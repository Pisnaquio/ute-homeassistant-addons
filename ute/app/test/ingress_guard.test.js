'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { isAllowedRequest, resolveGuardOptions } = require('../lib/ingress_guard');

const addon = resolveGuardOptions({ SUPERVISOR_TOKEN: 'x' });
const post = (remoteAddress, path) => isAllowedRequest({ remoteAddress, method: 'POST', path }, addon);
const get = (remoteAddress, path) => isAllowedRequest({ remoteAddress, method: 'GET', path }, addon);

test('fuera de Home Assistant no restringe', () => {
  const local = resolveGuardOptions({});
  assert.equal(local.enabled, false);
  assert.equal(isAllowedRequest({ remoteAddress: '10.0.0.9', method: 'POST', path: '/api/refresh' }, local), true);
});

test('acepta al Supervisor y al propio contenedor', () => {
  assert.equal(post('172.30.32.2', '/api/admin/reset-local-data'), true);
  assert.equal(post('::ffff:172.30.32.2', '/api/refresh'), true);
  assert.equal(post('127.0.0.1', '/api/refresh'), true);
  assert.equal(post('::1', '/api/refresh'), true);
});

test('rechaza a otros contenedores de la red de add-ons', () => {
  assert.equal(post('172.30.33.5', '/api/admin/reset-local-data'), false);
  assert.equal(post('::ffff:172.30.33.5', '/api/refresh'), false);
  assert.equal(get('172.30.33.5', '/'), false);
  assert.equal(get('172.30.33.5', '/api/data'), false);
  assert.equal(get('', '/api/data'), false);
});

test('deja abiertas sólo las lecturas de salud y resumen', () => {
  assert.equal(get('172.30.32.1', '/health'), true);
  assert.equal(get('172.30.32.1', '/api/ha/summary'), true);
  assert.equal(post('172.30.32.1', '/api/ha/summary'), false);
});

test('UTE_ALLOW_DIRECT_ACCESS y UTE_INGRESS_PROXY_IP se respetan', () => {
  assert.equal(resolveGuardOptions({ SUPERVISOR_TOKEN: 'x', UTE_ALLOW_DIRECT_ACCESS: 'true' }).enabled, false);
  const custom = resolveGuardOptions({ SUPERVISOR_TOKEN: 'x', UTE_INGRESS_PROXY_IP: '10.1.1.1' });
  assert.equal(isAllowedRequest({ remoteAddress: '10.1.1.1', method: 'POST', path: '/api/refresh' }, custom), true);
  assert.equal(isAllowedRequest({ remoteAddress: '172.30.32.2', method: 'POST', path: '/api/refresh' }, custom), false);
});
