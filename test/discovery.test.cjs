const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { discovery } = require('../src/discovery.cjs');

const adapter = (address, netmask = '255.255.255.0') => ({ address, netmask, family: 'IPv4', internal: false });
function harness({ deferred = false } = {}) {
  const state = {
    time: 10000, sockets: [], binds: [], timers: new Map(),
    interfaces: { Ethernet: [adapter('192.168.0.68')], 'Radmin VPN': [adapter('26.4.62.126', '255.0.0.0')] }
  };
  class Socket extends EventEmitter {
    constructor() { super(); this.sent = []; this.closeCalls = 0; }
    bind(port, address, callback) {
      this.binding = { port, address };
      if (deferred) state.binds.push(callback); else callback();
    }
    setBroadcast(value) { this.broadcast = value; }
    send(data, port, address, callback) {
      assert.equal(this.closeCalls, 0, 'a closed socket cannot send');
      this.sent.push({ data: JSON.parse(data), port, address }); callback();
    }
    close() { this.closeCalls++; }
  }
  state.room = discovery('self', 41234, {
    createSocket: () => { const socket = new Socket(); state.sockets.push(socket); return socket; },
    networkInterfaces: () => state.interfaces,
    now: () => state.time,
    setInterval: fn => { const key = Symbol(); state.timers.set(key, fn); return key; },
    clearInterval: key => state.timers.delete(key)
  });
  state.receive = (address, custom = {}) => state.sockets[0].emit('message', Buffer.from(JSON.stringify({ app: 'entretela-single-room-v2', id: 'friend', port: 40000, born: 1, leader: true, ...custom })), { address });
  state.tick = () => { for (const callback of state.timers.values()) callback(); };
  state.peer = (id = 'friend') => state.room.candidates().find(peer => peer.id === id);
  return state;
}

test('discovery keeps both observed addresses and prefers the reachable Radmin subnet', t => {
  const h = harness(); t.after(() => h.room.close());
  h.receive('26.1.1.1');
  h.time++;
  h.receive('192.168.0.4');
  assert.deepEqual(h.peer().addresses, ['26.1.1.1', '192.168.0.4']);
  assert.equal(h.peer().address, '26.1.1.1');
  assert.equal(h.peer().leader, true);
  assert.equal(h.room.candidates().filter(peer => peer.id === 'friend').length, 1);
});

test('advertised alternative addresses are validated and other VPNs remain eligible', t => {
  const h = harness(); t.after(() => h.room.close());
  h.interfaces['ZeroTier One'] = [adapter('10.49.8.189')]; h.tick();
  h.receive('192.168.0.4', { addresses: ['10.49.8.2', '26.8.9.10', '26.8.9.10', '127.0.0.1', '0.0.0.0', '224.0.0.1', '255.255.255.255', 'https://evil.invalid', {}, '::1'] });
  assert.deepEqual(h.peer().addresses, ['26.8.9.10', '10.49.8.2', '192.168.0.4']);
  h.receive('192.168.0.5', { id: 'legacy-peer' });
  assert.deepEqual(h.peer('legacy-peer').addresses, ['192.168.0.5'], 'v0.2.0 packets without an address list still work');
});

test('each IPv4 adapter sends from its own bound socket and advertises local alternatives', t => {
  const h = harness(); t.after(() => h.room.close());
  assert.deepEqual(h.sockets[0].binding, { port: 45873, address: '0.0.0.0' });
  const radmin = h.sockets.find(socket => socket.binding?.address === '26.4.62.126');
  const ethernet = h.sockets.find(socket => socket.binding?.address === '192.168.0.68');
  assert.equal(radmin.binding.port, 0); assert.equal(ethernet.binding.port, 0);
  assert.deepEqual(radmin.sent.map(packet => packet.address), ['26.255.255.255', '255.255.255.255']);
  assert.deepEqual(ethernet.sent.map(packet => packet.address), ['192.168.0.255', '255.255.255.255']);
  for (const socket of [radmin, ethernet]) {
    assert.equal(socket.broadcast, true);
    assert.deepEqual(socket.sent[0].data.addresses, ['26.4.62.126', '192.168.0.68']);
    assert.equal(socket.sent[0].port, 45873);
  }
  h.room.promote(true);
  assert.equal(radmin.sent.at(-1).data.leader, true);
});

test('a full advertised address list cannot evict the observed source endpoint', t => {
  const h = harness(); t.after(() => h.room.close());
  h.receive('192.168.0.4', { addresses: Array.from({ length: 12 }, (_, n) => `26.2.1.${n + 1}`) });
  assert.equal(h.peer().addresses.length, 12);
  assert.ok(h.peer().addresses.includes('192.168.0.4'));
});

test('old endpoints expire separately and inactive peers are removed', t => {
  const h = harness(); t.after(() => h.room.close());
  h.receive('26.1.1.1'); h.time += 3000; h.receive('192.168.0.4');
  h.time += 2001;
  assert.deepEqual(h.peer().addresses, ['192.168.0.4']);
  h.time += 3000;
  assert.equal(h.peer(), undefined);
  assert.equal(h.room.candidates().length, 1);
});

test('malformed or foreign discovery packets do not create candidates', t => {
  const h = harness(); t.after(() => h.room.close());
  for (const custom of [{ id: 'self' }, { id: 'x'.repeat(65) }, { id: '../friend' }, { id: {} }, { app: 'other-app' }, { born: -1 }, { born: 1.5 }, { leader: 'true' }, { port: 0 }, { port: 65536 }, { port: '40000' }]) h.receive('26.1.1.1', custom);
  for (const source of ['127.0.0.1', '224.0.0.1', '0.0.0.0', 'invalid']) h.receive(source);
  for (const raw of ['null', '[]', '{', 'x'.repeat(2049)]) h.sockets[0].emit('message', Buffer.from(raw), { address: '26.1.1.1' });
  assert.equal(h.room.candidates().length, 1);
});

test('discovery bounds peer and endpoint counts and clears obsolete server addresses', t => {
  const h = harness(); t.after(() => h.room.close());
  for (let i = 0; i < 80; i++) h.receive('26.1.1.1', { id: `peer-${i}`, addresses: Array.from({ length: 30 }, (_, n) => `26.2.1.${n + 1}`) });
  assert.equal(h.room.candidates().length, 65);
  assert.ok(h.room.candidates().every(peer => peer.addresses.length <= 12));
  h.receive('192.168.0.4', { id: 'peer-0', port: 40001 });
  assert.deepEqual(h.peer('peer-0').addresses, ['192.168.0.4']);
  h.time += 5001; h.receive('26.1.1.2', { id: 'new-peer' });
  assert.equal(h.room.candidates().length, 2);
});

test('interface changes replace only affected senders and close releases all sockets and timers', () => {
  const h = harness();
  const radmin = h.sockets.find(socket => socket.binding?.address === '26.4.62.126');
  const ethernet = h.sockets.find(socket => socket.binding?.address === '192.168.0.68');
  delete h.interfaces['Radmin VPN']; h.interfaces['ZeroTier One'] = [adapter('10.49.8.189')]; h.tick();
  assert.equal(radmin.closeCalls, 1); assert.equal(ethernet.closeCalls, 0);
  assert.ok(h.sockets.some(socket => socket.binding?.address === '10.49.8.189'));
  h.room.close();
  assert.equal(h.timers.size, 0);
  assert.ok(h.sockets.every(socket => socket.closeCalls === 1));
  const sent = h.sockets.map(socket => socket.sent.length);
  h.room.close(); h.room.promote(true); h.tick();
  assert.ok(h.sockets.every(socket => socket.closeCalls === 1));
  assert.deepEqual(h.sockets.map(socket => socket.sent.length), sent);
});

test('failed interface sockets can retry and pending binds cannot send after close', () => {
  const h = harness();
  const failed = h.sockets[1]; failed.emit('error', new Error('interface disappeared'));
  assert.equal(failed.closeCalls, 1);
  h.tick(); assert.equal(h.sockets.length, 4); h.room.close();
  const delayed = harness({ deferred: true });
  delayed.binds.shift()(); // Receiver binds; per-interface binds are still pending.
  delayed.room.close();
  for (const finishBind of delayed.binds) finishBind();
  assert.equal(delayed.timers.size, 0);
  assert.ok(delayed.sockets.every(socket => socket.closeCalls >= 1 && socket.sent.length === 0));
});
