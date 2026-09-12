const { EventEmitter } = require('node:events');
const { randomUUID } = require('node:crypto');
const { WebSocket } = require('ws');
const { VERSION, encode, decode } = require('./protocol.cjs');
const { createRoomServer } = require('./server.cjs');
const { discovery, addresses } = require('./discovery.cjs');
const pause = ms => new Promise(r => setTimeout(r, ms));
function connectionFailure(failures) {
  const reasons = { ECONNREFUSED: 'conexão recusada', ETIMEDOUT: 'tempo de conexão esgotado', EHOSTUNREACH: 'computador inacessível', ENETUNREACH: 'rede inacessível', EACCES: 'conexão bloqueada', ECONNRESET: 'conexão interrompida' };
  const details = failures.map(({ address, port, error }) => `${address}:${port} (${reasons[error.code] || error.message})`).join('; ');
  return Object.assign(new Error(`Encontrei a sala, mas não consegui conectar: ${details}. Nos dois computadores, mantenham o Radmin na mesma rede e cliquem em “Permitir conexão no Windows”. Depois tentem entrar novamente.`), { code: 'HOST_UNREACHABLE' });
}
class Room extends EventEmitter {
  constructor(options = {}) { super(); this.options = options; this.id = randomUUID(); this.roster = []; this.closed = false; }
  async start({ name }) {
    if (typeof name !== 'string' || !name.trim() || name.trim().length > 32) throw new Error('Informe seu nome (até 32 caracteres).');
    this.name = name.trim();
    this.server = await createRoomServer();
    if (this.closed) { await this.server.close(); throw new Error('Entrada cancelada.'); }
    this.discovery = (this.options.discovery || discovery)(this.id, this.server.port);
    try {
      await pause(this.options.discoveryWait ?? 1800);
      if (this.closed) throw new Error('Entrada cancelada.');
      const candidates = this.discovery.candidates();
      const hosts = candidates.filter(candidate => candidate.leader);
      // Never create a second room when an existing room is full/unreachable.
      // For simultaneous first arrivals, everyone picks the same oldest peer.
      let connected = false;
      const failures = [];
      for (const candidate of hosts.length ? hosts : candidates) {
        try { await this.connectCandidate(candidate); connected = true; break; }
        catch (e) { if (['ROOM_FULL', 'VERSION_MISMATCH'].includes(e.code)) throw e; failures.push(...(e.failures || [{ ...candidate, error: e }])); }
      }
      if (!connected) throw connectionFailure(failures);
      return this.info();
    } catch (e) { await this.close(); throw e; }
  }
  async connectCandidate(candidate) {
    const failures = [];
    const endpoints = [...new Set([candidate.address, ...(candidate.addresses || [])].filter(Boolean))].slice(0, 12);
    for (const address of endpoints) {
      if (this.closed) throw new Error('Entrada cancelada.');
      try { await this.connect({ ...candidate, address }); return; }
      catch (error) {
        if (['ROOM_FULL', 'VERSION_MISMATCH'].includes(error.code)) throw error;
        failures.push({ address, port: candidate.port, error });
      }
    }
    throw Object.assign(connectionFailure(failures), { failures });
  }
  async connect(candidate) {
    if (this.closed) throw new Error('Sala fechada.');
    const ws = new WebSocket(`ws://${candidate.address}:${candidate.port}`, { maxPayload: 100000, perMessageDeflate: false, handshakeTimeout: 4000 });
    this.pending = ws;
    await new Promise((resolve, reject) => {
      let accepted = false;
      let lastSeen = Date.now();
      const timer = setTimeout(() => { reject(Object.assign(new Error('A sala não respondeu.'), { code: 'ETIMEDOUT' })); ws.terminate(); }, 5500);
      const health = setInterval(() => { if (Date.now() - lastSeen > 11000) ws.terminate(); }, 2000);
      ws.on('ping', () => { lastSeen = Date.now(); });
      ws.on('error', error => { if (!accepted) reject(Object.assign(new Error(error.message.includes('timed out') ? 'A sala não respondeu.' : 'Falha na conexão.'), { code: error.code || (error.message.includes('timed out') ? 'ETIMEDOUT' : 'CONNECTION_FAILED') })); });
      ws.on('message', raw => {
        try {
          lastSeen = Date.now();
          const msg = decode(raw);
          if (msg.type === 'challenge') {
            if (msg.version !== VERSION) { reject(Object.assign(new Error('A sala usa uma versão incompatível. Atualizem o EntreTela nos dois computadores.'), { code: 'VERSION_MISMATCH' })); ws.close(); return; }
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
        const discovered = this.discovery.candidates().find(peer => peer.id === p.id);
        const candidate = p.id === this.id ? { address: '127.0.0.1', port: this.server.port } : { ...p, addresses: discovered?.addresses || [] };
        try { await this.connectCandidate(candidate); return; } catch {}
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
