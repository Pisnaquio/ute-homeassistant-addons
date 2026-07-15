'use strict';

const { apiError } = require('./errors');

const API_HOST = 'rocme.ute.com.uy';
const IDENTITY_HOST = 'identityserver.ute.com.uy';
const MAX_BODY_BYTES = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 25_000;

function assertAllowedUrl(input, expectedHost) {
  let url;
  try { url = new URL(input); }
  catch (_) { throw apiError('API_AUTHORITY_REJECTED', 'La autoridad de UTE no es una URL HTTPS válida.'); }
  if (url.protocol !== 'https:' || url.port || url.hostname !== expectedHost) {
    throw apiError('API_AUTHORITY_REJECTED', 'La autoridad de UTE no está permitida.');
  }
  return url;
}

function parseRetryAfter(value) {
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 60_000);
  const date = Date.parse(value || '');
  return Number.isFinite(date) ? Math.max(0, Math.min(date - Date.now(), 60_000)) : undefined;
}

function defaultFetchTransport(url, options) {
  return fetch(url, options);
}

class MobileApiTransport {
  constructor(options = {}) {
    this.fetch = options.fetch || defaultFetchTransport;
    this.timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
    this.maxBodyBytes = options.maxBodyBytes || MAX_BODY_BYTES;
  }

  async request({ authority, pathname, method = 'GET', headers = {}, json, form, expectedHost, signal }) {
    const base = assertAllowedUrl(authority, expectedHost);
    const url = new URL(pathname, base);
    if (url.hostname !== expectedHost || url.protocol !== 'https:' || url.port) {
      throw apiError('API_AUTHORITY_REJECTED', 'La ruta API salió de la autoridad permitida.');
    }
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), this.timeoutMs);
    if (signal) signal.addEventListener('abort', () => abort.abort(), { once: true });
    const requestHeaders = { accept: 'application/json', ...headers };
    let body;
    if (json !== undefined) {
      requestHeaders['content-type'] = 'application/json';
      body = JSON.stringify(json);
    } else if (form !== undefined) {
      requestHeaders['content-type'] = 'application/x-www-form-urlencoded';
      body = new URLSearchParams(form).toString();
    }
    let response;
    try {
      response = await this.fetch(url.toString(), { method, headers: requestHeaders, body, redirect: 'manual', signal: abort.signal });
    } catch (error) {
      if (abort.signal.aborted) throw apiError('API_TIMEOUT', 'La API de UTE demoró demasiado en responder.', { cause: error });
      throw apiError('API_UNAVAILABLE', 'No fue posible conectar con la API de UTE.', { cause: error });
    } finally { clearTimeout(timer); }
    if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
      throw apiError('API_REDIRECT_REJECTED', 'La API de UTE devolvió una redirección no permitida.', { statusCode: response.status });
    }
    const contentLength = Number(response.headers?.get?.('content-length') || 0);
    if (contentLength > this.maxBodyBytes) throw apiError('API_SCHEMA_INVALID', 'La respuesta de UTE supera el límite permitido.', { statusCode: response.status });
    const text = await response.text();
    if (Buffer.byteLength(text) > this.maxBodyBytes) throw apiError('API_SCHEMA_INVALID', 'La respuesta de UTE supera el límite permitido.', { statusCode: response.status });
    if (response.status === 429) throw apiError('RATE_LIMITED', 'UTE limitó temporalmente las solicitudes.', { statusCode: 429, retryAfterMs: parseRetryAfter(response.headers?.get?.('retry-after')) });
    if (response.status === 401) throw apiError('SESSION_EXPIRED', 'La sesión con UTE expiró.', { statusCode: 401 });
    if (response.status === 403) throw apiError('API_UNAVAILABLE', 'UTE rechazó la operación.', { statusCode: 403 });
    if (response.status >= 500) throw apiError('API_UNAVAILABLE', 'UTE no está disponible temporalmente.', { statusCode: response.status });
    if (response.status >= 400) throw apiError('API_SCHEMA_INVALID', 'UTE rechazó la solicitud.', { statusCode: response.status });
    if (response.status === 204) return { statusCode: 204, body: null, headers: response.headers };
    try { return { statusCode: response.status, body: text ? JSON.parse(text) : null, headers: response.headers }; }
    catch (_) { return { statusCode: response.status, body: text, headers: response.headers }; }
  }
}

module.exports = { MobileApiTransport, API_HOST, IDENTITY_HOST, assertAllowedUrl, parseRetryAfter };
