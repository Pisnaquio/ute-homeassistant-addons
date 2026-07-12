'use strict';

const UTEScraper = require('./scraper');
const { isUsablePeriodDetail } = require('./period_detail_store');
const { UtePortalClient } = require('./ute_http/portal_client');

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
    this.httpClient = null;
    this.playwrightSessionTouched = false;
  }

  async fetchMonthlyData() {
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

  async getHttpClient() {
    if (!this.httpClient) {
      this.httpClient = new UtePortalClient({
        userId: this.userId,
        password: this.password,
      });
      await this.httpClient.login();
    }
    return this.httpClient;
  }

  async runOperation(operation, httpFn, playwrightFn) {
    const startedAt = Date.now();
    if (this.mode === 'playwright') {
      return this.wrapResult(operation, 'playwright', await playwrightFn(), startedAt);
    }

    try {
      const httpResult = await httpFn();
      return this.wrapResult(operation, 'http', httpResult, startedAt);
    } catch (error) {
      if (this.mode === 'http') {
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
  return String(error && error.message ? error.message : error || 'error desconocido').slice(0, 240);
}

module.exports = {
  UteDataSource,
  createUteDataSource,
};
