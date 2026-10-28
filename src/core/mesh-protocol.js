const id = value => typeof value === 'string' && value.length > 0 && value.length <= 64;
const hex = (value, length) => typeof value === 'string' && new RegExp(`^0x[0-9a-f]{${length}}$`, 'i').test(value);
const validators = {
  credits:message=>message.event&&typeof message.event.content==='string'&&message.event.content.length<=4000,
  'credits-ack':message=>typeof message.eventId==='string'&&/^[a-f0-9]{64}$/.test(message.eventId),
  hello: message => message.event && typeof message.event === 'object' && typeof message.event.content === 'string' && message.event.content.length < 64000,
  ping: message => id(message.id),
  pong: message => id(message.id),
  job: message => id(message.id) && message.job && typeof message.job === 'object',
  cancel: message => id(message.id),
  delta: message => id(message.id) && typeof message.text === 'string',
  done: message => id(message.id) && Number.isFinite(message.tokens) && message.tokens >= 0,
  error: message => id(message.id) && typeof message.error === 'string' && message.error.length <= 2000 && (message.retryable == null || typeof message.retryable === 'boolean'),
  tool_calls: message => id(message.id) && Array.isArray(message.calls) && message.calls.length <= 128,
  delivered: message => message.payment && hex(message.payment.id, 64) && hex(message.payment.outputHash, 64) && hex(message.payment.attestation, 130)
};
export function validateMessage(message) {
  if (!message || typeof message !== 'object' || !Object.hasOwn(validators, message.type) || !validators[message.type](message)) throw new Error('Malformed or unsupported mesh message');
}
