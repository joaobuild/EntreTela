// The single room has no password or shared secret. WebRTC encrypts media;
// signaling relies on the local network / VPN for transport privacy.
const VERSION = 2;
function encode(message) { return JSON.stringify(message); }
function decode(raw) {
  const bytes = Buffer.from(raw);
  if (!bytes.length || bytes.length > 100000) throw new Error('Mensagem inválida.');
  const message = JSON.parse(bytes.toString('utf8'));
  if (!message || Array.isArray(message) || typeof message !== 'object' || typeof message.type !== 'string') throw new Error('Mensagem inválida.');
  return message;
}
module.exports = { VERSION, encode, decode };
