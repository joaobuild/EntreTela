const { WebSocketServer, WebSocket } = require('ws');
const { randomUUID } = require('node:crypto');
const { VERSION, encode, decode } = require('./protocol.cjs');
async function createRoomServer(options = {}) {
  const clients = new Map();
  let presenter = null;
  const wss = new WebSocketServer({ port: options.port || 0, host: options.host || '0.0.0.0', maxPayload: 100000, perMessageDeflate: false, backlog: 20 });
  await new Promise((resolve, reject) => { wss.once('listening', resolve); wss.once('error', reject); });
  wss.on('error', () => {});
  const send = (ws, msg) => {
    if (ws.readyState === WebSocket.OPEN && ws.bufferedAmount < 1000000) ws.send(encode(msg));
    else if (ws.bufferedAmount >= 1000000) ws.terminate();
  };
  const roster = () => [...clients.values()].map(c => ({ id: c.id, name: c.name, address: c.address, port: c.port }));
  const broadcast = msg => { for (const c of clients.values()) send(c.ws, msg); };
  const state = () => broadcast({ type: 'roster', peers: roster(), presenter });
  wss.on('connection', (ws, req) => {
    if (wss.clients.size > 24) return ws.close(1013, 'Busy');
    let client;
    const challenge = randomUUID();
    send(ws, { type: 'challenge', challenge, version: VERSION });
    const timeout = setTimeout(() => ws.close(1008, 'Timeout'), 5000);
    let count = 0;
    const rate = setInterval(() => { count = 0; }, 1000);
    ws.alive = true;
    ws.on('pong', () => { ws.alive = true; });
    ws.on('error', () => {});
    ws.on('message', raw => {
      try {
        if (++count > 160) return ws.close(1008, 'Rate limit');
        const msg = decode(raw);
        if (!client) {
          if (msg.type !== 'join' || msg.version !== VERSION || msg.challenge !== challenge || typeof msg.id !== 'string' || !/^[\w-]{1,64}$/.test(msg.id) || typeof msg.name !== 'string' || !msg.name.trim() || msg.name.length > 32 || !Number.isInteger(msg.port) || msg.port < 1 || msg.port > 65535) return ws.close(1008, 'Invalid join');
          if (clients.size >= 10) { send(ws, { type: 'error', code: 'ROOM_FULL', message: 'A sala já tem 10 pessoas. Aguarde alguém sair.' }); return ws.close(1008, 'Full'); }
          if (clients.has(msg.id)) return ws.close(1008, 'Duplicate');
          clearTimeout(timeout);
          client = { id: msg.id, name: msg.name.trim(), port: msg.port, address: req.socket.remoteAddress.replace(/^::ffff:/, ''), ws };
          clients.set(client.id, client);
          send(ws, { type: 'welcome', id: client.id });
          state();
        } else if (msg.type === 'signal') {
          const target = clients.get(msg.to);
          if (target && target !== client && msg.data && JSON.stringify(msg.data).length < 80000) send(target.ws, { type: 'signal', from: client.id, data: msg.data });
        } else if (msg.type === 'share-request') {
          if (!presenter || presenter === client.id) { presenter = client.id; state(); }
          else send(ws, { type: 'share-denied' });
        } else if (msg.type === 'share-stop' && presenter === client.id) {
          presenter = null; state();
        }
      } catch { ws.close(1008, 'Invalid message'); }
    });
    ws.on('close', () => {
      clearTimeout(timeout); clearInterval(rate);
      if (client && clients.get(client.id) === client) { clients.delete(client.id); if (presenter === client.id) presenter = null; state(); }
    });
  });
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) { if (!ws.alive) ws.terminate(); else { ws.alive = false; ws.ping(); } }
  }, 4000);
  return { port: wss.address().port, close: async () => { clearInterval(heartbeat); for (const ws of wss.clients) ws.terminate(); await new Promise(resolve => wss.close(resolve)); } };
}
module.exports = { createRoomServer };
