const dgram = require('node:dgram');
const os = require('node:os');
const { isIP } = require('node:net');

const PORT = 45873;
const APP = 'entretela-single-room-v2';
const MAX_PEERS = 64, MAX_ENDPOINTS = 12, MAX_INTERFACES = 16;
const EXPIRES_AFTER = 5000;

function validAddress(value) {
  if (typeof value !== 'string' || isIP(value) !== 4) return false;
  const first = Number(value.split('.')[0]);
  return first > 0 && first < 224 && first !== 127;
}
function number(address) {
  return address.split('.').reduce((value, octet) => ((value << 8) | Number(octet)) >>> 0, 0);
}
function interfaces(networkInterfaces) {
  const result = new Map();
  for (const [name, entries] of Object.entries(networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family !== 'IPv4' || entry.internal || !validAddress(entry.address) || isIP(entry.netmask) !== 4) continue;
      const mask = number(entry.netmask), inverse = (~mask) >>> 0;
      // Ignore invalid masks rather than inventing broadcast destinations.
      if (mask === 0 || ((inverse & ((inverse + 1) >>> 0)) >>> 0) !== 0) continue;
      const broadcast = (number(entry.address) | inverse) >>> 0;
      result.set(entry.address, {
        address: entry.address, mask,
        broadcast: [24, 16, 8, 0].map(shift => (broadcast >>> shift) & 255).join('.'),
        priority: /radmin/i.test(name) ? 400 : /vpn|zerotier|hamachi|tailscale|wireguard|wintun/i.test(name) ? 300 : 200
      });
    }
  }
  return [...result.values()].sort((a, b) => b.priority - a.priority || number(a.address) - number(b.address)).slice(0, MAX_INTERFACES);
}
function addresses() { return interfaces(os.networkInterfaces).map(entry => entry.address); }

// Optional dependencies allow deterministic tests without changing callers.
function discovery(id, port, dependencies = {}) {
  const createSocket = dependencies.createSocket || (options => dgram.createSocket(options));
  const networkInterfaces = dependencies.networkInterfaces || os.networkInterfaces;
  const now = dependencies.now || Date.now;
  const schedule = dependencies.setInterval || setInterval;
  const cancel = dependencies.clearInterval || clearInterval;
  const socket = createSocket({ type: 'udp4', reuseAddr: true });
  const seen = new Map(), senders = new Map();
  const born = now();
  let leader = false, ready = false, closed = false, local = [];

  const stopSocket = entry => {
    entry.closed = true;
    try { entry.socket.close(); } catch {}
  };
  const prune = () => {
    const cutoff = now() - EXPIRES_AFTER;
    for (const [peerId, peer] of seen) {
      for (const [address, endpoint] of peer.endpoints) if (endpoint.seen <= cutoff) peer.endpoints.delete(address);
      if (peer.seen <= cutoff || !peer.endpoints.size) seen.delete(peerId);
    }
  };
  const rank = endpoint => {
    let score = endpoint.observed ? 20 : 0;
    for (const entry of local) {
      if (((number(endpoint.address) & entry.mask) >>> 0) === ((number(entry.address) & entry.mask) >>> 0)) score = Math.max(score, entry.priority + (endpoint.observed ? 20 : 0));
    }
    return score;
  };
  const ordered = peer => [...peer.endpoints.values()].sort((a, b) => rank(b) - rank(a) || b.seen - a.seen || number(a.address) - number(b.address));
  const packet = () => Buffer.from(JSON.stringify({ app: APP, id, port, born, leader, addresses: local.map(entry => entry.address).slice(0, MAX_ENDPOINTS) }));
  const send = entry => {
    if (closed || !ready || !entry.ready || entry.closed) return;
    const data = packet();
    // Binding the source interface avoids Windows choosing a different VPN or
    // Ethernet adapter for the limited broadcast.
    for (const address of new Set([entry.broadcast, '255.255.255.255'])) {
      try { entry.socket.send(data, PORT, address, () => {}); } catch {}
    }
  };
  const announce = () => {
    if (closed || !ready) return;
    prune();
    try { local = interfaces(networkInterfaces); } catch { return; }
    const current = new Set(local.map(entry => entry.address));
    for (const [address, entry] of senders) if (!current.has(address)) { stopSocket(entry); senders.delete(address); }
    for (const adapter of local) {
      const existing = senders.get(adapter.address);
      if (existing) { existing.broadcast = adapter.broadcast; send(existing); continue; }
      let senderSocket;
      try { senderSocket = createSocket({ type: 'udp4', reuseAddr: true }); } catch { continue; }
      const entry = { ...adapter, socket: senderSocket, ready: false, closed: false };
      senders.set(adapter.address, entry);
      entry.socket.on('error', () => {
        stopSocket(entry);
        if (senders.get(adapter.address) === entry) senders.delete(adapter.address);
      });
      try {
        entry.socket.bind(0, adapter.address, () => {
          if (closed || entry.closed) { stopSocket(entry); return; }
          try { entry.socket.setBroadcast(true); entry.ready = true; send(entry); }
          catch { stopSocket(entry); senders.delete(adapter.address); }
        });
      } catch { stopSocket(entry); senders.delete(adapter.address); }
    }
    // A machine without an active IPv4 adapter can still try the default route.
    if (!local.length) {
      try { socket.send(packet(), PORT, '255.255.255.255', () => {}); } catch {}
    }
  };
  socket.on('error', () => { ready = false; });
  socket.on('message', (data, info) => {
    if (closed) return;
    try {
      if (data.length > 2048 || !validAddress(info.address)) return;
      const p = JSON.parse(data);
      if (!p || p.app !== APP || p.id === id || typeof p.id !== 'string' || !/^[\w-]{1,64}$/.test(p.id) || !Number.isSafeInteger(p.born) || p.born < 0 || typeof p.leader !== 'boolean' || !Number.isInteger(p.port) || p.port < 1 || p.port > 65535) return;
      prune();
      let peer = seen.get(p.id);
      if (!peer || peer.port !== p.port || peer.born !== p.born) {
        if (!peer && seen.size >= MAX_PEERS) return;
        peer = { id: p.id, port: p.port, born: p.born, endpoints: new Map() };
      }
      peer.leader = p.leader; peer.seen = now();
      const advertised = Array.isArray(p.addresses) ? p.addresses.slice(0, MAX_ENDPOINTS).filter(validAddress) : [];
      for (const address of new Set([info.address, ...advertised])) {
        peer.endpoints.set(address, { address, seen: now(), observed: address === info.address || !!peer.endpoints.get(address)?.observed });
      }
      // Claimed alternatives must not crowd out addresses actually observed.
      const retained = ordered(peer).sort((a, b) => Number(b.observed) - Number(a.observed)).slice(0, MAX_ENDPOINTS);
      peer.endpoints = new Map(retained.map(endpoint => [endpoint.address, endpoint]));
      seen.set(p.id, peer);
    } catch {}
  });
  socket.bind(PORT, '0.0.0.0', () => {
    if (closed) { try { socket.close(); } catch {} return; }
    try { socket.setBroadcast(true); ready = true; announce(); } catch {}
  });
  const timer = schedule(announce, 500);
  return {
    candidates() {
      prune();
      return [...seen.values()].map(peer => {
        const endpoints = ordered(peer).map(endpoint => endpoint.address);
        return { id: peer.id, born: peer.born, port: peer.port, leader: peer.leader, seen: peer.seen, address: endpoints[0], addresses: endpoints };
      }).concat([{ id, born, address: '127.0.0.1', addresses: ['127.0.0.1'], port, leader }]).sort((a, b) => Number(b.leader) - Number(a.leader) || a.born - b.born || a.id.localeCompare(b.id));
    },
    promote(value) { if (!closed) { leader = !!value; announce(); } },
    close() {
      if (closed) return;
      closed = true; ready = false; cancel(timer); seen.clear();
      for (const entry of senders.values()) stopSocket(entry);
      senders.clear();
      try { socket.close(); } catch {}
    }
  };
}
module.exports = { discovery, addresses };
