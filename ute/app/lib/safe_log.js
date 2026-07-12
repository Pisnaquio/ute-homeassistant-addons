'use strict';

const SENSITIVE_QUERY_KEYS = /([?&](?:saId|spId|meterId|badge|psId|userId|password|token|access_token|refresh_token)=)[^&#\s]+/gi;
const SENSITIVE_ASSIGNMENTS = /\b(?:UTE_EMAIL|UTE_PASSWORD|ute_email|ute_password|saId|spId|meterId|badge|psId|userId|password|token|access_token|refresh_token|authorization|cookie)\s*[:=]\s*[^\s,;]+/gi;

function valuesFromEnvironment(env = process.env) {
  return [
    env.UTE_EMAIL,
    env.UTE_PASSWORD,
    env.UTE_SA_ID,
    env.UTE_SP_ID,
    env.UTE_METER_ID,
    env.UTE_BADGE,
  ].filter(value => typeof value === 'string' && value.length >= 3);
}

function redact(value, env = process.env) {
  let text = String(value ?? '');
  for (const secret of valuesFromEnvironment(env)) {
    text = text.split(secret).join('[REDACTED]');
    text = text.split(encodeURIComponent(secret)).join('[REDACTED]');
  }
  return text
    .replace(SENSITIVE_QUERY_KEYS, '$1[REDACTED]')
    .replace(SENSITIVE_ASSIGNMENTS, match => `${match.split(/[:=]/, 1)[0]}=[REDACTED]`)
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]{12,}/gi, 'Bearer [REDACTED]')
    .replace(/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g, '[REDACTED_PRIVATE_KEY]');
}

function logEvent(level, event, fields = {}) {
  const payload = {
    ts: new Date().toISOString(),
    level,
    event,
    ...Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, redact(value)])),
  };
  const line = JSON.stringify(payload);
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

module.exports = { logEvent, redact };
