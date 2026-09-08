const dgram = require('node:dgram');
const os = require('node:os');
const PORT = 45873;
function addresses() {
  return Object.values(os.networkInterfaces()).flat().filter(n => n.family === 'IPv4' && !n.internal).map(n => n.address);
}
function discovery(room, id, port) {
  const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  const seen = new Map();
  const born = Date.now();
  let leader = false, ready = false;
  const packet = () => Buffer.from(JSON.stringify({ app: 'entretela-1', room, id, port, born, leader }));
  const announce = () => {
    if (!ready) return;
    const targets = new Set(['255.255.255.255']);
    for (const n of Object.values(os.networkInterfaces()).flat()) if (n.family === 'IPv4' && !n.internal) {
      const ip = n.address.split('.').map(Number), mask = n.netmask.split('.').map(Number);
      targets.add(ip.map((v, i) => (v | (~mask[i] & 255))).join('.'));
    }
    for (const address of targets) socket.send(packet(), PORT, address, () => {});
  };
  socket.on('error', () => {});
  socket.on('message', (data, info) => {
    try {
      if (data.length > 1000) return;
      const p = JSON.parse(data);
      if (p.app !== 'entretela-1' || p.room !== room || p.id === id || typeof p.id !== 'string' || !Number.isFinite(p.born) || !Number.isInteger(p.port) || p.port < 1 || p.port > 65535) return;
      seen.set(p.id, { ...p, address: info.address, seen: Date.now() });
    } catch {}
  });
  socket.bind(PORT, () => { ready = true; socket.setBroadcast(true); announce(); });
  const timer = setInterval(announce, 500);
  return {
    candidates() { return [...seen.values()].filter(p => Date.now() - p.seen < 2200).concat([{ id, born, address: '127.0.0.1', port, leader }]).sort((a, b) => Number(b.leader) - Number(a.leader) || a.born - b.born || a.id.localeCompare(b.id)); },
    promote(value) { leader = value; announce(); },
    close() { clearInterval(timer); try { socket.close(); } catch {} }
  };
}
module.exports = { discovery, addresses };
