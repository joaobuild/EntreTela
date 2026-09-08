const { scryptSync, createHash, randomBytes, createCipheriv, createDecipheriv } = require('node:crypto');
function keyFor(secret) {
  if (typeof secret !== 'string' || secret.length < 8 || secret.length > 128) throw new Error('Use uma senha de grupo entre 8 e 128 caracteres.');
  return scryptSync(secret, 'EntreTela/v1', 32);
}
function roomId(key) { return createHash('sha256').update(key).digest('hex').slice(0, 32); }
function seal(key, value) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), data]);
}
function open(key, data) {
  const b = Buffer.from(data);
  if (b.length < 29 || b.length > 100000) throw new Error('Mensagem inválida');
  const cipher = createDecipheriv('aes-256-gcm', key, b.subarray(0, 12));
  cipher.setAuthTag(b.subarray(12, 28));
  return JSON.parse(Buffer.concat([cipher.update(b.subarray(28)), cipher.final()]).toString('utf8'));
}
module.exports = { keyFor, roomId, seal, open };
