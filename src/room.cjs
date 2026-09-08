const { EventEmitter } = require('node:events');
const { randomUUID } = require('node:crypto');
const { WebSocket } = require('ws');
const { VERSION, encode, decode } = require('./protocol.cjs');
const { createRoomServer } = require('./server.cjs');
const { discovery, addresses } = require('./discovery.cjs');
const pause = ms => new Promise(r => setTimeout(r, ms));
class Room extends EventEmitter {
  constructor() { super(); this.id = randomUUID(); this.roster = []; this.closed = false; }
  async start({ name }) {
    if (typeof name !== 'string' || !name.trim() || name.trim().length > 32) throw new Error('Informe seu nome (até 32 caracteres).');
    this.name = name.trim();
    this.server = await createRoomServer();
    if (this.closed) { await this.server.close(); throw new Error('Entrada cancelada.'); }
    this.discovery = discovery(this.id, this.server.port);
    try {
      await pause(1800);
      const candidates = this.discovery.candidates();
      const hosts = candidates.filter(candidate => candidate.leader);
      // Never create a second room when an existing room is full/unreachable.
      // For simultaneous first arrivals, everyone picks the same oldest peer.
      let connected = false;
      for (const candidate of hosts.length ? hosts : candidates) {
        try { await this.connect(candidate); connected = true; break; }
        catch (e) { if (e.code === 'ROOM_FULL') throw e; }
      }
      if (!connected) throw new Error('Não foi possível entrar na sala. Verifique a rede ou VPN e o firewall e tente novamente.');
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
          const msg = decode(raw);
          if (msg.type === 'challenge') {
            if (msg.version !== VERSION) { reject(new Error('Todos precisam usar a versão 0.2.0 ou posterior.')); ws.close(); return; }
            ws.send(encode({ type: 'join', version: VERSION, id: this.id, name: this.name, port: this.server.port, challenge: msg.challenge }));
          }
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
            if (!accepted) { reject(Object.assign(new Error(msg.message), { code: msg.code })); ws.close(); }
          } else if (accepted) {
            if (msg.type === 'roster') {
              this.roster = msg.peers.map(p => ({ ...p, address: p.address === '127.0.0.1' ? candidate.address : p.address }));
              msg.peers = this.roster;
            }
            this.emit('event', msg);
          }
        } catch { ws.close(); if (!accepted) reject(new Error('Mensagem inválida recebida da sala.')); }
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
    if (!this.closed) this.emit('event', { type: 'error', message: 'Reconexão falhou. Confira a rede ou VPN, saia e entre novamente.' });
  }
  info() {
    const hosts = this.isHost ? addresses() : [this.target?.address].filter(Boolean);
    if (!hosts.length) hosts.push('127.0.0.1');
    return { id: this.id, isHost: !!this.isHost, hosts, port: this.target?.port };
  }
  send(msg) { if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(encode(msg)); }
  async close() {
    this.closed = true;
    this.ws?.close(); this.pending?.close(); this.discovery?.close();
    if (this.server) await this.server.close();
  }
}
module.exports = { Room };
