const { test } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { WebSocket } = require('ws');
const { keyFor, seal, open } = require('../src/crypto.cjs');
const { createRoomServer } = require('../src/server.cjs');
const { Room, parseInvite } = require('../src/room.cjs');
const key = keyFor('uma-senha-longa-de-teste');
function client(server, id, custom = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}`);
  const events = []; const waiters = [];
  ws.on('message', raw => { const m = open(key, raw); events.push(m); for (const fn of [...waiters]) fn(m); if (m.type === 'challenge') ws.send(seal(key, { type: 'join', challenge: m.challenge, id, name: id, port: 40000, ...custom })); });
  const wait = type => new Promise((resolve, reject) => {
    const existing = events.find(m => m.type === type); if (existing) return resolve(existing);
    const timer = setTimeout(() => reject(new Error(`No ${type}`)), 2000);
    const fn = m => { if (m.type === type) { clearTimeout(timer); waiters.splice(waiters.indexOf(fn), 1); resolve(m); } }; waiters.push(fn);
  });
  return { ws, events, wait, send: m => ws.send(seal(key, m)) };
}
test('encrypted messages reject tampering and wrong passwords', () => {
  const msg = { type: 'signal', data: { sdp: 'private' } }; const data = seal(key, msg);
  assert.deepEqual(open(key, data), msg); assert.ok(!data.includes(Buffer.from('private')));
  data[data.length - 1] ^= 1; assert.throws(() => open(key, data));
  assert.throws(() => open(keyFor('another-password'), seal(key, msg)));
  assert.throws(() => keyFor('short'));
});
test('invite validates addresses, secret and port', () => {
  const invite = obj => 'entretela:' + Buffer.from(JSON.stringify(obj)).toString('base64url');
  const valid = { v: 1, hosts: ['127.0.0.1'], port: 12345, secret: 'long-password' };
  assert.deepEqual(parseInvite(invite(valid)), valid);
  for (const item of [{ ...valid, hosts: ['999.2.3.4'] }, { ...valid, port: 0 }, { ...valid, secret: '123' }]) assert.throws(() => parseInvite(invite(item)));
});
test('room admits 10, rejects 11, routes messages and enforces one presenter', async t => {
  const server = await createRoomServer(key, { host: '127.0.0.1' }); t.after(() => server.close());
  const all = [];
  for (let i = 0; i < 10; i++) { const c = client(server, `peer-${i}`); all.push(c); await c.wait('welcome'); }
  const extra = client(server, 'eleven'); assert.match((await extra.wait('error')).message, /10/);
  all[0].send({ type: 'signal', to: 'peer-1', from: 'forged', data: { candidate: 'test' } });
  assert.equal((await all[1].wait('signal')).from, 'peer-0');
  all[0].send({ type: 'share-request' });
  await new Promise(resolve => setTimeout(resolve, 60));
  all[1].send({ type: 'share-request' }); await all[1].wait('share-denied');
  all[0].ws.close(); await once(all[0].ws, 'close');
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(all[1].events.filter(m => m.type === 'roster').at(-1).presenter, null);
  assert.equal(all[1].events.filter(m => m.type === 'roster').at(-1).peers.length, 9);
});
test('server rejects invalid encrypted messages and duplicate IDs', async t => {
  const server = await createRoomServer(key, { host: '127.0.0.1' }); t.after(() => server.close());
  const a = client(server, 'same'); await a.wait('welcome');
  const b = client(server, 'same'); const [code] = await once(b.ws, 'close'); assert.equal(code, 1008);
  a.ws.send(Buffer.from('untrusted')); const [bad] = await once(a.ws, 'close'); assert.equal(bad, 1008);
});
test('oldest surviving member hosts after original host closes', { timeout: 20000 }, async t => {
  const a = new Room(), b = new Room(), c = new Room();
  t.after(async () => { await Promise.all([a.close(), b.close(), c.close()]); });
  await a.start({ name: 'A', secret: 'uma-senha-longa-de-teste' });
  const invite = 'entretela:' + Buffer.from(JSON.stringify({ v: 1, hosts: ['127.0.0.1'], port: a.server.port, secret: 'uma-senha-longa-de-teste' })).toString('base64url');
  await b.start({ name: 'B', invite }); await c.start({ name: 'C', invite });
  await new Promise(resolve => setTimeout(resolve, 100));
  const connected = room => new Promise(resolve => { const fn = e => { if (e.type === 'connected') { room.off('event', fn); resolve(e); } }; room.on('event', fn); });
  const bReconnected = connected(b), cReconnected = connected(c);
  await a.close();
  const [bInfo, cInfo] = await Promise.all([bReconnected, cReconnected]);
  assert.equal(bInfo.port, b.server.port); assert.equal(cInfo.port, b.server.port);
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(b.roster.length, 2); assert.equal(c.roster.length, 2);
});
test('simultaneous LAN entrants converge on one host', { timeout: 15000 }, async t => {
  const a = new Room(), b = new Room();
  t.after(async () => { await Promise.all([a.close(), b.close()]); });
  const results = await Promise.all([a.start({ name: 'First', secret: 'simultaneous-lan-room' }), b.start({ name: 'Second', secret: 'simultaneous-lan-room' })]);
  assert.equal(results[0].port, results[1].port);
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(a.roster.length, 2); assert.equal(b.roster.length, 2);
});
