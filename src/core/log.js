const privateFields=/key|secret|passphrase|authorization|signature|attestation|prompt|messages|content|ciphertext/i;
export function redact(value){if(Array.isArray(value))return value.map(redact);if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,privateFields.test(key)?'[REDACTED]':redact(item)]));
  if(typeof value==='string')return value.replace(/\b(?:0x)?[a-f0-9]{64,}\b/ig,'[REDACTED]');return value;}
export function logger(format='json'){return (event,fields={})=>{const record=redact({time:new Date().toISOString(),event,...fields});process.stdout.write((format==='pretty'?`${record.time} ${event} ${JSON.stringify(record)}`:JSON.stringify(record))+'\n');};}
