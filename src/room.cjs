const { EventEmitter } = require('node:events');
const { randomUUID } = require('node:crypto');
const { WebSocket } = require('ws');
const { keyFor, roomId, seal, open } = require('./crypto.cjs');
const { createRoomServer } = require('./server.cjs');
const { discovery, addresses } = require('./discovery.cjs');
const pause = ms => new Promise(r => setTimeout(r, ms));
function parseInvite(value) {
  if (typeof value !== 'string' || value.length > 2000) throw new Error('Convite inválido.');
  let data;
  try { data = JSON.parse(Buffer.from(value.trim().replace(/^entretela:/, ''), 'base64url').toString()); } catch { throw new Error('Convite inválido.'); }
  if (data.v !== 1 || !Array.isArray(data.hosts) || !data.hosts.length || data.hosts.length > 20 || !data.hosts.every(x => typeof x === 'string' && /^\d{1,3}(\.\d{1,3}){3}$/.test(x) && x.split('.').every(n => +n <= 255)) || !Number.isInteger(data.port) || data.port < 1 || data.port > 65535) throw new Error('Endereço do convite inválido.');
  keyFor(data.secret);
  return data;
}
class Room extends EventEmitter {
  constructor() { super(); this.id = randomUUID(); this.roster = []; this.closed = false; }
  async start({ name, secret, invite }) {
    if (typeof name !== 'string' || !name.trim() || name.trim().length > 32) throw new Error('Informe seu nome (até 32 caracteres).');
    this.name = name.trim();
    const data = invite ? parseInvite(invite) : null;
    this.secret = data ? data.secret : secret;
    this.key = keyFor(this.secret);
    this.server = await createRoomServer(this.key);
    if (this.closed) { await this.server.close(); throw new Error('Entrada cancelada.'); }
    this.discovery = discovery(roomId(this.key), this.id, this.server.port);
    try {
      if (data) {
        let connected = false;
        for (const address of data.hosts) {
          try { await this.connect({ address, port: data.port }); connected = true; break; } catch {}
        }
        if (!connected) throw new Error('Não foi possível alcançar a sala. Use a mesma rede ou VPN e verifique o firewall do anfitrião.');
      } else {
        await pause(1800);
        const candidates = this.discovery.candidates();
        let connected = false;
        for (const candidate of candidates) {
          try { await this.connect(candidate); connected = true; break; } catch {}
        }
        if (!connected) throw new Error('Não foi possível iniciar a sala.');
      }
      return this.info();
    } catch (e) { await this.close(); throw e; }
  }
  async connect(candidate) {
    if (this.closed) throw new Error('Sala fechada.');
    const ws = new WebSocket(`ws://${candidate.address}:${candidate.port}`, { maxPayload: 100000, perMessageDeflate: false, handshakeTimeout: 2200 });
    this.pending = ws;
    await new Promise((resolve, reject) => {
      let accepted = false;
      let lastSeen = Date.now();
      const timer = setTimeout(() => { ws.terminate(); reject(new Error('A sala não respondeu.')); }, 3500);
      const health = setInterval(() => { if (Date.now() - lastSeen > 11000) ws.terminate(); }, 2000);
      ws.on('ping', () => { lastSeen = Date.now(); });
      ws.on('error', () => { if (!accepted) reject(new Error('Falha na conexão.')); });
      ws.on('message', raw => {
        try {
          lastSeen = Date.now();
          const msg = open(this.key, raw);
          if (msg.type === 'challenge') ws.send(seal(this.key, { type: 'join', id: this.id, name: this.name, port: this.server.port, challenge: msg.challenge }));
          else if (msg.type === 'welcome') {
            if (this.closed) { ws.close(); return reject(new Error('Entrada cancelada.')); }
            accepted = true; clearTimeout(timer);
            this.ws = ws; this.target = candidate;
            this.isHost = candidate.port === this.server.port && candidate.address === '127.0.0.1';
            this.discovery.promote(this.isHost);
            this.emit('event', { type: 'connected', ...this.info() });
            resolve();
          } else if (msg.type === 'error') {
            this.emit('event', msg);
            if (!accepted) { reject(new Error(msg.message)); ws.close(); }
          } else if (accepted) {
            if (msg.type === 'roster') {
              this.roster = msg.peers.map(p => ({ ...p, address: p.address === '127.0.0.1' ? candidate.address : p.address }));
              msg.peers = this.roster;
            }
            this.emit('event', msg);
          }
        } catch { ws.close(); if (!accepted) reject(new Error('Senha incorreta ou mensagem inválida.')); }
      });
      ws.on('close', () => {
        clearTimeout(timer); clearInterval(health);
        if (!accepted) reject(new Error('A sala recusou a conexão.'));
        else if (!this.closed && this.ws === ws) { this.ws = null; this.recover().catch(e => this.emit('event', { type: 'error', message: e.message })); }
      });
    });
  }
  async recover() {
    this.emit('event', { type: 'reconnecting' });
    this.discovery.promote(false);
    const candidates = this.roster.filter(p => p.port !== this.target.port || p.address !== this.target.address);
    // Every member already has a standby signaling server. All survivors try the
    // same join order; the oldest reachable member becomes the next host.
    for (let round = 0; round < 3 && !this.closed; round++) {
      for (const p of candidates) {
        const candidate = p.id === this.id ? { address: '127.0.0.1', port: this.server.port } : p;
        try { await this.connect(candidate); return; } catch {}
      }
      await pause(500);
    }
    if (!this.closed) this.emit('event', { type: 'error', message: 'Reconexão falhou. Saia e entre novamente com um convite atualizado.' });
  }
  info() {
    const hosts = this.isHost ? addresses() : [this.target?.address].filter(Boolean);
    if (!hosts.length) hosts.push('127.0.0.1');
    return { id: this.id, isHost: !!this.isHost, hosts, port: this.target?.port, invite: 'entretela:' + Buffer.from(JSON.stringify({ v: 1, hosts, port: this.target?.port, secret: this.secret })).toString('base64url') };
  }
  send(msg) { if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(seal(this.key, msg)); }
  async close() {
    this.closed = true;
    this.ws?.close(); this.pending?.close(); this.discovery?.close();
    if (this.server) await this.server.close();
  }
}
module.exports = { Room, parseInvite };
