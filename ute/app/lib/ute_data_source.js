'use strict';

const UTEScraper = require('./scraper');
const { isUsablePeriodDetail } = require('./period_detail_store');
const { UtePortalClient } = require('./ute_http/portal_client');
const { redact } = require('./safe_log');
const {
  CURRENT_DISCOVERY_REVISION,
  normalizePortalIdentity,
} = require('./portfolio_contract');

const VALID_SOURCE_MODES = new Set(['auto', 'http', 'playwright']);
const DISCOVERY_FAIL_CLOSED_CODES = new Set([
  'INVALID_CREDENTIALS',
  'SESSION_EXPIRED',
  'USER_TYPE_SELECTION_REQUIRED',
  'USER_TYPE_SELECTION_UNPARSEABLE',
  'DISCOVERY_OPTIONS_UNPARSEABLE',
  'DISCOVERY_FAILED',
  'ACCOUNT_PAGE_UNAVAILABLE',
  'CHALLENGE_UNSUPPORTED',
  'PORTFOLIO_CONTEXT_INCOMPLETE',
  'PORTFOLIO_IDENTITY_AMBIGUOUS',
  'PORTFOLIO_IDENTITY_CONFLICT',
]);

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
    this.playwrightScraperFactory = options.playwrightScraperFactory || (() =>
      new UTEScraper(this.userId, this.password, this.debug));
  }

  async discoverPortfolio() {
    if (this.mode === 'playwright') return this.discoverPortfolioWithPlaywright(null);
    try {
      const client = await this.getHttpClient({ allowUnselected: true });
      const portfolio = this.portfolio || await client.discoverPortfolio();
      this.portfolio = portfolio;
      if (!portfolio?.accounts?.length) throw new Error('UTE no devolvió cuentas ni suministros');
      return portfolio;
    } catch (error) {
      if (this.mode === 'http') throw error;
      if (DISCOVERY_FAIL_CLOSED_CODES.has(error.code)) throw error;
      return this.discoverPortfolioWithPlaywright(error);
    }
  }

  async discoverPortfolioWithPlaywright(httpError) {
    const scraper = this.playwrightScraperFactory();
    try {
      await scraper.initialize();
      await scraper.login();
      if (scraper.portfolio?.accounts?.length) {
        this.portfolio = finalizePlaywrightPortfolio(scraper.portfolio);
        return this.portfolio;
      }
      const error = new Error('Playwright no enumeró una cartera de suministros verificable; no se eligió el primer contexto automáticamente.');
      error.code = 'PLAYWRIGHT_DISCOVERY_UNVERIFIED';
      throw error;
    } catch (error) {
      if (error?.portfolio?.accounts?.length) {
        this.portfolio = finalizePlaywrightPortfolio(error.portfolio);
        return this.portfolio;
      }
      if (!error.code) error.code = httpError?.code || 'DISCOVERY_FAILED';
      error.fallbackFrom = 'http';
      error.fallbackReason = summarizeError(httpError);
      throw error;
    } finally {
      await scraper.close();
    }
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
        const scraper = new UTEScraper(this.userId, this.password, this.debug, this.supplyContext);
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
        const data = await fetchCurrentPeriod({ ...options, supplyContext: this.supplyContext });
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
        const data = await fetchPeriodDetail(periodoInicio, periodoFin, { ...options, supplyContext: this.supplyContext });
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
      if (this.hasMultiSupplyContext() && !this.hasCompleteSupplyContext()) {
        const error = new Error('Playwright requiere el contexto técnico completo del suministro seleccionado.');
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
      if (this.hasMultiSupplyContext() && !this.hasCompleteSupplyContext()) {
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

  hasCompleteSupplyContext() {
    const technical = this.supplyContext?.technical || this.supplyContext || {};
    return ['saId', 'spId', 'meterId', 'badge'].every((key) => Boolean(technical[key]));
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

function finalizePlaywrightPortfolio(rawPortfolio) {
  const evidence = rawPortfolio?.discoveryEvidence || {};
  if (evidence.enumerated !== true || evidence.canonicalized !== true) {
    const error = new Error('Playwright no aportó evidencia de enumeración completa de suministros.');
    error.code = 'PLAYWRIGHT_DISCOVERY_UNVERIFIED';
    throw error;
  }
  const portfolio = normalizePortalIdentity({
    ...rawPortfolio,
    discoveryRevision: CURRENT_DISCOVERY_REVISION,
  });
  const supplies = (portfolio.accounts || []).flatMap((account) => account.supplies || []);
  if (Number(evidence.candidateCount || 0) !== supplies.length) {
    const error = new Error('La evidencia Playwright no coincide con los suministros enumerados.');
    error.code = 'PLAYWRIGHT_DISCOVERY_UNVERIFIED';
    throw error;
  }
  if (supplies.length !== 1 || !hasCompleteTechnicalContext(supplies[0]?.technical)) {
    const error = new Error('Playwright no pudo demostrar una identidad única y completa del suministro.');
    error.code = supplies.length > 1
      ? 'PLAYWRIGHT_MULTI_ACCOUNT_UNVERIFIED'
      : 'PORTFOLIO_CONTEXT_INCOMPLETE';
    throw error;
  }
  supplies[0].selectedByDefault = true;
  return portfolio;
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

function hasCompleteTechnicalContext(context) {
  return ['saId', 'spId', 'meterId', 'badge'].every((key) => Boolean(context?.[key]));
}

module.exports = {
  UteDataSource,
  createUteDataSource,
  finalizePlaywrightPortfolio,
};
