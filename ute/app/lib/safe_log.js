'use strict';

const ENV_SECRET_KEYS = Object.freeze([
  'UTE_DOCUMENT',
  'UTE_EMAIL',
  'UTE_PASSWORD',
  'UTE_ACCESS_TOKEN',
  'UTE_REFRESH_TOKEN',
  'UTE_CLIENT_ID',
  'UTE_CLIENT_SECRET',
  'UTE_UNIQUE_ID',
  'UTE_ACCOUNT_ID',
  'UTE_SERVICE_AGREEMENT_ID',
  'UTE_SERVICE_POINT_ID',
  'UTE_SA_ID',
  'UTE_SP_ID',
  'UTE_METER_ID',
  'UTE_BADGE',
]);

const SENSITIVE_KEY_NAMES = Object.freeze([
  'password', 'utepassword', 'document', 'documentnumber', 'documento', 'username', 'userid',
  'client', 'clientid', 'clientsecret', 'secret', 'uniqueid', 'installationid', 'registrationid',
  'token', 'accesstoken', 'refreshtoken', 'idtoken', 'authorization', 'cookie', 'setcookie', 'session',
  'accountid', 'accountnumber', 'serviceagreementid', 'agreementid', 'servicepointid',
  'said', 'spid', 'psid', 'meterid', 'badge', 'invoiceid', 'docnumber',
  'address', 'shortaddress', 'location', 'accountalias', 'supplyalias',
  'body', 'requestbody', 'responsebody', 'rawbody', 'responsetext', 'html', 'payload',
]);

const TEXT_SENSITIVE_KEYS = Object.freeze([
  'UTE_EMAIL', 'UTE_PASSWORD', 'ute_email', 'ute_password',
  'document', 'documentNumber', 'documento', 'username', 'userId',
  'client', 'clientId', 'client_id', 'clientSecret', 'client_secret', 'secret',
  'uniqueId', 'unique_id', 'installationId', 'installation_id', 'registrationId', 'registration_id',
  'token', 'accessToken', 'access_token', 'refreshToken', 'refresh_token', 'idToken', 'id_token',
  'authorization', 'cookie', 'set-cookie', 'session',
  'accountId', 'account_id', 'accountNumber', 'account_number',
  'serviceAgreementId', 'service_agreement_id', 'agreementId', 'agreement_id',
  'servicePointId', 'service_point_id', 'saId', 'spId', 'psId', 'meterId', 'meter_id', 'badge',
  'invoiceId', 'invoice_id', 'docNumber', 'doc_number',
  'address', 'shortAddress', 'location', 'accountAlias', 'supplyAlias',
  'body', 'requestBody', 'responseBody', 'rawBody', 'responseText', 'html', 'payload',
]);

const TEXT_KEY_PATTERN = TEXT_SENSITIVE_KEYS
  .map((key) => key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  .join('|');

const SENSITIVE_QUERY_KEYS = new RegExp(`([?&](?:${TEXT_KEY_PATTERN})=)[^&#\\s]+`, 'gi');
const SENSITIVE_ASSIGNMENTS = new RegExp(`(?:["']?)(?:${TEXT_KEY_PATTERN})(?:["']?)\\s*[:=]\\s*(?!\\[REDACTED\\])(?:"[^"]*"|'[^']*'|[^,;\\s}\\]&#]+)`, 'gi');
const SENSITIVE_HEADERS = /\b(?:authorization|cookie|set-cookie)\s*:\s*[^\r\n]+/gi;
const BEARER_TOKEN = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const BASIC_TOKEN = /\bBasic\s+[A-Za-z0-9+/=]{8,}/gi;

function normalizeKey(key) {
  return String(key || '').replace(/[^a-z0-9]/gi, '').toLowerCase();
}

function isSensitiveKey(key) {
  return SENSITIVE_KEY_NAMES.includes(normalizeKey(key));
}

function valuesFromEnvironment(env = process.env) {
  return ENV_SECRET_KEYS
    .map((key) => env[key])
    .filter((value) => typeof value === 'string' && value.length >= 3);
}

function redactKnownApiPaths(text) {
  return text
    .replace(/(\/customersapp\/accounts\/)([^/?#\s]+)(\/services\/)([^/?#\s]+)(\/)([^/?#\s]+)(\/status)/gi, '$1[REDACTED]$3[REDACTED]$5[REDACTED]$7')
    .replace(/(\/customersapp\/accounts\/)([^/?#\s]+)(\/services\/)([^/?#\s]+)(\/peak)/gi, '$1[REDACTED]$3[REDACTED]$5')
    .replace(/(\/customersapp\/accounts\/)([^/?#\s]+)(\/calculateConsumptionForPlan\/)/gi, '$1[REDACTED]$3')
    .replace(/(\/customersapp\/invoices\/charts\/)([^/?#\s]+)(\/[^/?#\s]+\/)([^/?#\s]+)/gi, '$1[REDACTED]$3[REDACTED]')
    .replace(/(\/customersapp\/invoices\/file\/)([^/?#\s]+)(\/)([^/?#\s]+)/gi, '$1[REDACTED]$3[REDACTED]')
    .replace(/(\/customersapp\/invoices\/(?:unpaids|totalDebt)\/)([^/?#\s]+)/gi, '$1[REDACTED]')
    .replace(/(\/customersapp\/invoices\/)(?!charts\/|file\/|unpaids\/|totalDebt\/)([^/?#\s]+)(\/\d+)/gi, '$1[REDACTED]$3')
    .replace(/(\/customersapp\/accounts\/)([^/?#\s]+)(\/services)(?=[/?#\s]|$)/gi, '$1[REDACTED]$3');
}

function redact(value, env = process.env) {
  let text = String(value ?? '');
  for (const secret of valuesFromEnvironment(env)) {
    text = text.split(secret).join('[REDACTED]');
    text = text.split(encodeURIComponent(secret)).join('[REDACTED]');
  }
  return redactKnownApiPaths(text)
    .replace(SENSITIVE_QUERY_KEYS, '$1[REDACTED]')
    .replace(SENSITIVE_HEADERS, (match) => `${match.split(':', 1)[0]}: [REDACTED]`)
    .replace(BEARER_TOKEN, 'Bearer [REDACTED]')
    .replace(BASIC_TOKEN, 'Basic [REDACTED]')
    .replace(SENSITIVE_ASSIGNMENTS, (match) => {
      const key = match.match(/^\s*["']?([^"'\s:=]+)/)?.[1] || 'sensitive';
      return `${key}=[REDACTED]`;
    })
    .replace(/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g, '[REDACTED_PRIVATE_KEY]');
}

function redactValue(value, env = process.env, seen = new WeakSet()) {
  if (typeof value === 'string') return redact(value, env);
  if (value === null || value === undefined || typeof value !== 'object') return value;

  if (value instanceof Error) {
    const result = {
      name: redact(value.name || 'Error', env),
      message: redact(value.message || '', env),
    };
    if (value.code !== undefined) result.code = redactValue(value.code, env, seen);
    return result;
  }

  if (seen.has(value)) return '[REDACTED_CIRCULAR]';
  seen.add(value);

  if (Array.isArray(value)) {
    const result = value.map((item) => redactValue(item, env, seen));
    seen.delete(value);
    return result;
  }

  const result = Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    isSensitiveKey(key) ? '[REDACTED]' : redactValue(item, env, seen),
  ]));
  seen.delete(value);
  return result;
}

function redactEntry(key, value) {
  return isSensitiveKey(key) ? '[REDACTED]' : redactValue(value);
}

function logEvent(level, event, fields = {}) {
  const payload = {
    ts: new Date().toISOString(),
    level,
    event,
    ...Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, redactEntry(key, value)])),
  };
  const line = JSON.stringify(payload);
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

module.exports = { logEvent, redact, redactValue };
