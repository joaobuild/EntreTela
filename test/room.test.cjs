const { test } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { WebSocket } = require('ws');
const { VERSION, encode, decode } = require('../src/protocol.cjs');
const { createRoomServer } = require('../src/server.cjs');
const { Room } = require('../src/room.cjs');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function client(server, id, custom = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}`);
  const events = [], waiters = [];
  ws.on('message', raw => {
    const m = decode(raw); events.push(m);
    for (const fn of [...waiters]) fn(m);
    if (m.type === 'challenge') ws.send(encode({ type: 'join', version: VERSION, challenge: m.challenge, id, name: id, port: 40000, ...custom }));
  });
  const wait = type => new Promise((resolve, reject) => {
    const existing = events.find(m => m.type === type); if (existing) return resolve(existing);
    const timer = setTimeout(() => reject(new Error(`No ${type}`)), 2000);
    const fn = m => { if (m.type === type) { clearTimeout(timer); waiters.splice(waiters.indexOf(fn), 1); resolve(m); } }; waiters.push(fn);
  });
  return { ws, events, wait, send: m => ws.send(encode(m)) };
}
test('single-room protocol rejects malformed messages', () => {
  assert.deepEqual(decode(encode({ type: 'signal', data: { candidate: 'test' } })), { type: 'signal', data: { candidate: 'test' } });
  for (const raw of ['null', '[]', '{}', 'invalid', '{"type":2}', 'x'.repeat(100001)]) assert.throws(() => decode(raw));
});
test('room admits 10 without credentials, rejects 11 and enforces one presenter', async t => {
  const server = await createRoomServer({ host: '127.0.0.1' }); t.after(() => server.close());
  const all = [];
  for (let i = 0; i < 10; i++) { const c = client(server, `peer-${i}`); all.push(c); await c.wait('welcome'); }
  const extra = client(server, 'eleven'); assert.equal((await extra.wait('error')).code, 'ROOM_FULL');
  all[0].send({ type: 'signal', to: 'peer-1', from: 'forged', data: { candidate: 'test' } });
  assert.equal((await all[1].wait('signal')).from, 'peer-0');
  all[0].send({ type: 'share-request' }); await pause(60);
  all[1].send({ type: 'share-request' }); await all[1].wait('share-denied');
  all[0].ws.close(); await once(all[0].ws, 'close'); await pause(60);
  assert.equal(all[1].events.filter(m => m.type === 'roster').at(-1).presenter, null);
  assert.equal(all[1].events.filter(m => m.type === 'roster').at(-1).peers.length, 9);
});
test('server rejects malformed messages, duplicate IDs and old protocol versions', async t => {
  const server = await createRoomServer({ host: '127.0.0.1' }); t.after(() => server.close());
  const a = client(server, 'same'); await a.wait('welcome');
  const b = client(server, 'same'); assert.equal((await once(b.ws, 'close'))[0], 1008);
  const legacy = client(server, 'legacy', { version: 1 }); assert.equal((await once(legacy.ws, 'close'))[0], 1008);
  a.ws.send('invalid'); assert.equal((await once(a.ws, 'close'))[0], 1008);
});
test('name-only entry discovers the host and migrates when it leaves', { timeout: 25000 }, async t => {
  const a = new Room(), b = new Room(), c = new Room();
  t.after(async () => { await Promise.all([a.close(), b.close(), c.close()]); });
  const initial = await a.start({ name: 'A' });
  assert.equal(initial.isHost, true);
  assert.equal('invite' in initial, false); assert.equal('secret' in a, false);
  const second = await b.start({ name: 'B' }), third = await c.start({ name: 'C' });
  assert.equal(second.port, initial.port); assert.equal(third.port, initial.port);
  await pause(100);
  const connected = room => new Promise(resolve => { const fn = e => { if (e.type === 'connected') { room.off('event', fn); resolve(e); } }; room.on('event', fn); });
  const bReconnected = connected(b), cReconnected = connected(c);
  await a.close();
  const [bInfo, cInfo] = await Promise.all([bReconnected, cReconnected]);
  assert.equal(bInfo.port, b.server.port); assert.equal(cInfo.port, b.server.port);
  await pause(100); assert.equal(b.roster.length, 2); assert.equal(c.roster.length, 2);
});
test('simultaneous entrants converge on a single room without a group key', { timeout: 15000 }, async t => {
  const a = new Room(), b = new Room();
  t.after(async () => { await Promise.all([a.close(), b.close()]); });
  const results = await Promise.all([a.start({ name: 'First' }), b.start({ name: 'Second' })]);
  assert.equal(results[0].port, results[1].port);
  await pause(100); assert.equal(a.roster.length, 2); assert.equal(b.roster.length, 2);
});
test('a full discovered room never silently creates a second room', { timeout: 15000 }, async t => {
  const host = new Room(), newcomer = new Room();
  t.after(async () => { await Promise.all([host.close(), newcomer.close()]); });
  await host.start({ name: 'Host' });
  for (let i = 0; i < 9; i++) await client(host.server, `member-${i}`).wait('welcome');
  await assert.rejects(newcomer.start({ name: 'Eleven' }), e => e.code === 'ROOM_FULL');
  assert.equal(newcomer.closed, true);
});
