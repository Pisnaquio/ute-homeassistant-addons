'use strict';

// Dentro de Home Assistant el add-on escucha en la red interna de add-ons, donde
// cualquier otro contenedor puede alcanzarlo. La UI y la API sólo se atienden
// cuando el par TCP es el Supervisor (proxy de Ingress y watchdog) o el propio
// contenedor. Se mira la dirección del socket: los encabezados los escribe el
// cliente y no prueban el origen.

const DEFAULT_INGRESS_PROXY_IP = '172.30.32.2';
// Lecturas sin efectos que Home Assistant puede consultar directo (sensores REST).
const OPEN_READ_PATHS = new Set(['/health', '/api/ha/summary']);

function normalizeAddress(address) {
  const value = String(address || '').trim().toLowerCase();
  return value.startsWith('::ffff:') ? value.slice('::ffff:'.length) : value;
}

function isLoopback(address) {
  return address === '::1' || address.startsWith('127.');
}

function resolveGuardOptions(env = process.env) {
  return {
    // SUPERVISOR_TOKEN sólo existe cuando el proceso corre como add-on.
    enabled: Boolean(env.SUPERVISOR_TOKEN) && env.UTE_ALLOW_DIRECT_ACCESS !== 'true',
    proxyIp: normalizeAddress(env.UTE_INGRESS_PROXY_IP || DEFAULT_INGRESS_PROXY_IP),
  };
}

function isAllowedRequest({ remoteAddress, method, path }, options) {
  if (!options.enabled) return true;
  const address = normalizeAddress(remoteAddress);
  if (address === options.proxyIp || isLoopback(address)) return true;
  return (method === 'GET' || method === 'HEAD') && OPEN_READ_PATHS.has(path);
}

function createIngressGuard(options = resolveGuardOptions()) {
  return function ingressGuard(req, res, next) {
    const allowed = isAllowedRequest({
      remoteAddress: req.socket && req.socket.remoteAddress,
      method: req.method,
      path: req.path,
    }, options);
    if (allowed) return next();
    return res.status(403).json({ error: 'forbidden', detail: 'Abrí UTE desde el panel de Home Assistant.' });
  };
}

module.exports = { createIngressGuard, isAllowedRequest, resolveGuardOptions, normalizeAddress };
