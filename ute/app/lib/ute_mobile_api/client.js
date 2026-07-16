'use strict';

const { MobileApiTransport, API_HOST, IDENTITY_HOST, assertAllowedUrl } = require('./transport');
const { apiError } = require('./errors');

const API_AUTHORITY = `https://${API_HOST}`;
const ALLOWED_SCOPE = 'customers.accounts';

function assertObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw apiError('API_SCHEMA_INVALID', `${label} devolvió un esquema inválido.`);
  return value;
}

function basic(client, secret) {
  return `Basic ${Buffer.from(`${client}:${secret}`).toString('base64')}`;
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function hasAllowedTokenScope(scope) {
  // RFC 6749 permits omitting `scope` when it is unchanged from the request.
  // When UTE does include it, keep the fail-closed check for a different scope.
  return scope === undefined || scope === null || scope === ALLOWED_SCOPE;
}

class UteMobileApiClient {
  constructor(options = {}) {
    this.document = options.document;
    this.password = options.password;
    this.transport = options.transport || new MobileApiTransport(options);
    this.now = options.now || (() => Date.now());
    this.sleep = options.sleep || ((ms) => new Promise(resolve => setTimeout(resolve, ms)));
    this.apiAuthority = options.apiAuthority || API_AUTHORITY;
    this.session = null;
    this.refreshPromise = null;
  }

  async bootstrap() {
    const response = await this.transport.request({ authority: this.apiAuthority, expectedHost: API_HOST, pathname: '/customersapp/customers/setup', method: 'POST', json: { registrationId: '', deviceInfo: [] } });
    const payload = assertObject(response.body, 'Bootstrap');
    const oauth = assertObject(payload.oAuthConfiguration, 'OAuth');
    if (!payload.uniqueId || typeof payload.uniqueId !== 'string' || !oauth.client || !oauth.secret || oauth.scope !== ALLOWED_SCOPE) throw apiError('API_SCHEMA_INVALID', 'Bootstrap OAuth incompleto o con scope no permitido.');
    const authority = assertAllowedUrl(oauth.authority, IDENTITY_HOST).toString().replace(/\/$/, '');
    this.bootstrapState = { uniqueId: payload.uniqueId, authority, client: oauth.client, secret: oauth.secret, scope: oauth.scope };
    return { scope: oauth.scope };
  }

  async login() {
    if (!this.document || !this.password) throw apiError('INVALID_CREDENTIALS', 'Falta documento o contraseña para la API de UTE.');
    if (!this.bootstrapState) await this.bootstrap();
    const token = await this._token({
      grant_type: 'password',
      username: this.document,
      password: this.password,
      scope: this.bootstrapState.scope,
    });
    // ROPC necesita estos valores una sola vez cuando UTE entrega refresh token.
    // Si no lo entrega, se conservan únicamente en memoria para reautenticar.
    if (this.session.refreshToken) {
      this.document = null;
      this.password = null;
    }
    await this._loggedIn();
    return { scope: token.scope };
  }

  async _token(form) {
    const response = await this.transport.request({ authority: this.bootstrapState.authority, expectedHost: IDENTITY_HOST, pathname: '/connect/token', method: 'POST', headers: { authorization: basic(this.bootstrapState.client, this.bootstrapState.secret) }, form });
    const body = assertObject(response.body, 'Token');
    const expiresIn = Number(body.expires_in);
    if (!nonEmptyString(body.access_token) || !Number.isFinite(expiresIn) || expiresIn <= 0 || !hasAllowedTokenScope(body.scope)) {
      throw apiError('API_SCHEMA_INVALID', 'La respuesta OAuth de UTE es inválida.');
    }
    const returnedRefreshToken = nonEmptyString(body.refresh_token) ? body.refresh_token : null;
    this.session = {
      accessToken: body.access_token,
      refreshToken: returnedRefreshToken || this.session?.refreshToken || null,
      expiresAt: this.now() + Math.max(0, expiresIn - 60) * 1000,
    };
    return { scope: body.scope || this.bootstrapState.scope };
  }

  async _loggedIn() {
    await this.transport.request({ authority: this.apiAuthority, expectedHost: API_HOST, pathname: '/customersapp/customers/loggedin', method: 'POST', headers: this._authHeaders(), json: { uniqueId: this.bootstrapState.uniqueId } });
  }

  _authHeaders() {
    if (!this.session?.accessToken) throw apiError('SESSION_EXPIRED', 'No hay una sesión API activa.');
    return { authorization: `Bearer ${this.session.accessToken}` };
  }

  async ensureSession() {
    if (!this.session) return this.login();
    if (this.session.expiresAt > this.now()) return;
    return this.refresh();
  }

  async refresh() {
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = (async () => {
      try {
        if (!this.session?.refreshToken) return this.login();
        return await this._token({ grant_type: 'refresh_token', refresh_token: this.session.refreshToken });
      } catch (error) {
        this.session = null;
        if (error.statusCode === 400 || error.code === 'API_SCHEMA_INVALID') throw apiError('INVALID_CREDENTIALS', 'UTE rechazó la sesión o las credenciales.');
        throw error;
      } finally { this.refreshPromise = null; }
    })();
    return this.refreshPromise;
  }

  async requestApi(spec, { replayed = false } = {}) {
    await this.ensureSession();
    try {
      return await this.transport.request({ ...spec, authority: this.apiAuthority, expectedHost: API_HOST, headers: { ...this._authHeaders(), ...(spec.headers || {}) } });
    } catch (error) {
      if (error.code === 'SESSION_EXPIRED' && !replayed) {
        await this.refresh();
        return this.requestApi(spec, { replayed: true });
      }
      throw error;
    }
  }

  async getAccounts() { return this.requestApi({ pathname: '/customersapp/accounts' }); }
  async getServices(accountId) { return this.requestApi({ pathname: `/customersapp/accounts/${encodeURIComponent(accountId)}/services` }); }

  async discoverPortfolio() {
    const accountsResponse = await this.getAccounts();
    if (!Array.isArray(accountsResponse.body) || !accountsResponse.body.length) throw apiError('API_SCHEMA_INVALID', 'UTE no devolvió cuentas API válidas.');
    const accounts = [];
    for (const account of accountsResponse.body) {
      if (!account?.accountId) throw apiError('API_SCHEMA_INVALID', 'UTE devolvió una cuenta sin identidad técnica.');
      const servicesResponse = await this.getServices(account.accountId);
      if (!Array.isArray(servicesResponse.body)) throw apiError('API_SCHEMA_INVALID', 'UTE devolvió suministros API inválidos.');
      accounts.push({ account, services: servicesResponse.body });
    }
    return accounts;
  }

  async simulation(accountId) { return this.requestApi({ pathname: '/customersapp/accounts/consumption/simulation', method: 'POST', json: { accountId } }); }
  async tou(servicePointId, plan, from, to) { return this.requestApi({ pathname: `/customersapp/accounts/${encodeURIComponent(servicePointId)}/calculateConsumptionForPlan/${encodeURIComponent(plan)}/${encodeURIComponent(from)}/${encodeURIComponent(to)}` }); }
  async charts(accountId, kind, agreementId) { return this.requestApi({ pathname: `/customersapp/invoices/charts/${encodeURIComponent(accountId)}/${encodeURIComponent(kind)}/${encodeURIComponent(agreementId)}` }); }
  async invoices(accountId, count = 36) { return this.requestApi({ pathname: `/customersapp/invoices/${encodeURIComponent(accountId)}/${Number(count)}` }); }
  async unpaidInvoices(accountId) { return this.requestApi({ pathname: `/customersapp/invoices/unpaids/${encodeURIComponent(accountId)}` }); }
  async totalDebt(accountId) { return this.requestApi({ pathname: `/customersapp/invoices/totalDebt/${encodeURIComponent(accountId)}` }); }
  async invoicePdf(invoiceId, docNumber) { return this.requestApi({ pathname: `/customersapp/invoices/file/${encodeURIComponent(invoiceId)}/${encodeURIComponent(docNumber)}` }); }
  async supplyStatus(accountId, agreementId, servicePointId) { return this.requestApi({ pathname: `/customersapp/accounts/${encodeURIComponent(accountId)}/services/${encodeURIComponent(agreementId)}/${encodeURIComponent(servicePointId)}/status` }); }
  async peakWindow(accountId, agreementId) { return this.requestApi({ pathname: `/customersapp/accounts/${encodeURIComponent(accountId)}/services/${encodeURIComponent(agreementId)}/peak` }); }

  async close() { this.session = null; this.bootstrapState = null; }
}

module.exports = { UteMobileApiClient, ALLOWED_SCOPE, API_AUTHORITY };
