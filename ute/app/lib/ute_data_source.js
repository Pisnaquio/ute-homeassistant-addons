'use strict';

const UTEScraper = require('./scraper');
const { isUsablePeriodDetail } = require('./period_detail_store');
const { UtePortalClient } = require('./ute_http/portal_client');
const { redact } = require('./safe_log');

const VALID_SOURCE_MODES = new Set(['auto', 'http', 'playwright']);

function createUteDataSource(options) {
  return new UteDataSource(options);
}

class UteDataSource {
  constructor(options = {}) {
    this.userId = options.userId;
    this.password = options.password;
    this.debug = !!options.debug;
    this.mode = normalizeMode(options.mode);
    this.supplyContext = options.supplyContext || null;
    this.httpClient = null;
    this.playwrightSessionTouched = false;
  }

  async discoverPortfolio() {
    const client = await this.getHttpClient({ allowUnselected: true });
    const portfolio = this.portfolio || await client.discoverPortfolio();
    this.portfolio = portfolio;
    if (!portfolio?.accounts?.length) {
      throw new Error('UTE no devolvió cuentas ni suministros');
    }
    return portfolio;
  }

  async fetchMonthlyData(options = {}) {
    this.setSupplyContext(options.supplyContext);
    return this.runOperation(
      'monthly',
      async () => {
        const client = await this.getHttpClient();
        const data = await client.fetchFullMonthlyDataset();
        if (!Array.isArray(data) || !data.length) {
          throw new Error('HTTP devolvió historial mensual vacío');
        }
        return wrapParsedRows(data);
      },
      async () => {
        const scraper = new UTEScraper(this.userId, this.password, this.debug);
        try {
          return await scraper.scrapeWithRetry();
        } finally {
          await scraper.close();
        }
      }
    );
  }

  async fetchCurrentPeriod(options = {}) {
    this.setSupplyContext(options.supplyContext);
    return this.runOperation(
      'current',
      async () => {
        const client = await this.getHttpClient();
        const data = await client.fetchCurrentPeriod(options);
        if (!isUsablePeriodDetail(data)) {
          throw new Error('HTTP devolvió período actual incompleto');
        }
        return data;
      },
      async () => {
        this.playwrightSessionTouched = true;
        const { fetchCurrentPeriod } = require('./ute_session');
        const data = await fetchCurrentPeriod(options);
        if (!isUsablePeriodDetail(data)) {
          throw new Error('Playwright devolvió período actual incompleto');
        }
        return data;
      }
    );
  }

  async fetchPeriodDetail(periodoInicio, periodoFin, options = {}) {
    this.setSupplyContext(options.supplyContext);
    return this.runOperation(
      'period-detail',
      async () => {
        const client = await this.getHttpClient();
        const data = await client.fetchPeriodDetail(periodoInicio, periodoFin, options);
        if (!isUsablePeriodDetail(data)) {
          throw new Error('HTTP devolvió detalle diario inválido');
        }
        return data;
      },
      async () => {
        this.playwrightSessionTouched = true;
        const { fetchPeriodDetail } = require('./ute_session');
        const data = await fetchPeriodDetail(periodoInicio, periodoFin, options);
        if (!isUsablePeriodDetail(data)) {
          throw new Error('Playwright devolvió detalle diario inválido');
        }
        return data;
      }
    );
  }

  async close() {
    if (this.playwrightSessionTouched) {
      const { close } = require('./ute_session');
      await close();
      this.playwrightSessionTouched = false;
    }
  }

  async getHttpClient(options = {}) {
    const allowUnselected = options.allowUnselected === true;
    if (!this.httpClient) {
      this.httpClient = new UtePortalClient({
        userId: this.userId,
        password: this.password,
      });
      await this.httpClient.login();
      if (this.httpClient.userTypePage) {
        this.portfolio = await this.httpClient.discoverPortfolio();
      }
    }
    if (this.supplyContext) this.httpClient.setSupplyContext(this.supplyContext);
    const supplies = (this.portfolio?.accounts || []).flatMap((account) => account.supplies || []);
    if (this.portfolio && !allowUnselected && !this.supplyContext && supplies.length !== 1) {
      const error = new Error('UTE requiere seleccionar explícitamente un suministro antes de sincronizar');
      error.code = 'SUPPLY_SELECTION_REQUIRED';
      error.portfolio = this.portfolio;
      throw error;
    }
    return this.httpClient;
  }

  setSupplyContext(context) {
    if (!context) return;
    this.supplyContext = context;
    if (this.httpClient) this.httpClient.setSupplyContext(context);
  }

  async runOperation(operation, httpFn, playwrightFn) {
    const startedAt = Date.now();
    if (this.mode === 'playwright') {
      if (this.hasMultiSupplyContext()) {
        const error = new Error('Playwright no está habilitado para portfolios multicuenta: usá el conector HTTP');
        error.code = 'MULTI_ACCOUNT_PLAYWRIGHT_UNSUPPORTED';
        throw error;
      }
      return this.wrapResult(operation, 'playwright', await playwrightFn(), startedAt);
    }

    try {
      const httpResult = await httpFn();
      return this.wrapResult(operation, 'http', httpResult, startedAt);
    } catch (error) {
      if (this.mode === 'http') {
        throw error;
      }
      if (this.hasMultiSupplyContext()) {
        if (!error.code) error.code = 'MULTI_ACCOUNT_HTTP_FAILED';
        error.fallbackSuppressed = true;
        throw error;
      }
      const fallbackStartedAt = Date.now();
      const fallbackResult = await playwrightFn();
      return this.wrapResult(operation, 'playwright', fallbackResult, fallbackStartedAt, {
        fallbackFrom: 'http',
        fallbackReason: summarizeError(error),
      });
    }
  }

  hasMultiSupplyContext() {
    return Number(this.supplyContext?.portfolioSupplyCount || 0) > 1;
  }

  wrapResult(operation, source, data, startedAt, extra = {}) {
    return {
      data,
      source,
      operation,
      durationMs: Date.now() - startedAt,
      ...extra,
    };
  }
}

function normalizeMode(value) {
  const mode = String(value || 'auto').toLowerCase();
  return VALID_SOURCE_MODES.has(mode) ? mode : 'auto';
}

function wrapParsedRows(rows) {
  return rows.map((row) => ({
    month: `${row.mes}/${row.año}`,
    kwh: String(row.consumo_kwh),
    cost: String(row.costo_uyu),
    _parsed: row,
  }));
}

function summarizeError(error) {
  return redact(String(error && error.message ? error.message : error || 'error desconocido')).slice(0, 240);
}

module.exports = {
  UteDataSource,
  createUteDataSource,
};
