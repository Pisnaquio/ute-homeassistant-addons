'use strict';

const fs = require('fs');
const dotenv = require('dotenv');
const { HttpClient } = require('./http_client');
const { parseBillPdfBuffer } = require('./bill_pdf_parser');
const {
  combineData,
  extractAccountIdentifiers,
  formatPortalDate,
  parseBillingHistory,
  parseConsumptionHistory,
  parseDatepickerValue,
  parsePeriodPayload,
  parsePortalDate,
  shiftMonth,
  tryParseJson,
} = require('./parsers');
const {
  CURRENT_DISCOVERY_REVISION,
  normalizePortalIdentity,
} = require('../portfolio_contract');
const { logEvent } = require('../safe_log');
const {
  STATES,
  buildSafeFormSubmission,
  classifyPostLoginPage,
  extractJsRedirect,
  inspectForms,
  isSafePortalUrl,
  safePortalUrl,
} = require('./post_login_state');

const BASE = 'https://autoservicio.ute.com.uy/SelfService/SSvcController';
const MIN_MONTHLY_HISTORY_MONTHS = 26;
const MAX_POST_LOGIN_STEPS = 4;

class UtePortalClient {
  constructor(options = {}) {
    loadEnvIfPresent(options.envPath);

    this.userId = options.userId || process.env.UTE_USER_ID || process.env.UTE_EMAIL;
    this.password = options.password || process.env.UTE_PASSWORD;
    this.client = options.client || new HttpClient();
    this.context = Object.freeze({
      saId: options.saId || process.env.UTE_SA_ID || null,
      spId: options.spId || process.env.UTE_SP_ID || null,
      meterId: options.meterId || process.env.UTE_METER_ID || null,
      badge: options.badge || process.env.UTE_BADGE || null,
      accountNumber: options.accountNumber || null,
      portfolioSupplyCount: Number(options.portfolioSupplyCount || 0),
    });
  }

  async login() {
    if (!this.userId || !this.password) {
      throw new Error('Faltan credenciales UTE_USER_ID/UTE_EMAIL y UTE_PASSWORD');
    }

    const loginPage = await this.client.get(`${BASE}/login`);
    const form = inspectForms(loginPage.text, loginPage.url).find((candidate) =>
      candidate.fieldNames.includes('userId') && candidate.fieldNames.includes('password'));
    const submission = form ? buildSafeFormSubmission(form) : null;
    const values = submission?.ok ? submission.values : {};
    values.userId = this.userId;
    values.password = this.password;
    const action = submission?.ok ? submission.action : `${BASE}/authenticate`;
    let response = await this.submitForm({ method: submission?.method || 'POST', action, values }, `${BASE}/login`);

    for (let step = 0; step <= MAX_POST_LOGIN_STEPS; step += 1) {
      const diagnostic = classifyPostLoginPage(response, { afterAuthentication: true });
      this.lastPostLoginDiagnostic = diagnostic;
      logEvent('info', 'portal.post_login.classified', { operation: 'login', step, ...diagnostic });

      if (diagnostic.state === STATES.ACCOUNT) return response;
      if (diagnostic.state === STATES.USER_TYPE_SELECTION) {
        this.userTypePage = response.text;
        this.userTypeOptions = parseUserTypeOptions(response.text);
        if (this.userTypeOptions.length) return response;
        const transition = this.findSafeFormTransition(response);
        if (!transition.ok) {
          throw this.portalError(
            transition.reason === 'selection_required' ? 'USER_TYPE_SELECTION_REQUIRED' : 'USER_TYPE_SELECTION_UNPARSEABLE',
            'login',
            diagnostic
          );
        }
        response = await this.submitForm(transition.submission, response.url);
        continue;
      }
      if (diagnostic.state === STATES.JS_REDIRECT_OR_AUTOSUBMIT) {
        const transition = this.findSafeScriptTransition(response);
        if (!transition.ok) throw this.portalError('CHALLENGE_UNSUPPORTED', 'login', diagnostic);
        response = await this.submitForm(transition.submission, response.url);
        continue;
      }
      if (diagnostic.state === STATES.AUTHENTICATED_INTERMEDIATE) {
        response = await this.client.get(`${BASE}/account`);
        continue;
      }
      if (diagnostic.state === STATES.LOGIN_FORM) {
        throw this.portalError('INVALID_CREDENTIALS', 'login', diagnostic);
      }
      if (diagnostic.state === STATES.SESSION_EXPIRED) {
        throw this.portalError('SESSION_EXPIRED', 'login', diagnostic, true);
      }
      if (diagnostic.state === STATES.PORTAL_MAINTENANCE) {
        throw this.portalError('PORTAL_MAINTENANCE', 'login', diagnostic, true);
      }
      if (diagnostic.state === STATES.PORTAL_ERROR) {
        throw this.portalError('PORTAL_UNAVAILABLE', 'login', diagnostic, true);
      }
      if (diagnostic.state === STATES.CHALLENGE_OR_UNSUPPORTED) {
        throw this.portalError('CHALLENGE_UNSUPPORTED', 'login', diagnostic);
      }
      if (diagnostic.state === STATES.HTTP_REDIRECT_PENDING) {
        throw this.portalError('REDIRECT_LOOP', 'login', diagnostic, true);
      }
      throw this.portalError('DISCOVERY_FAILED', 'login', diagnostic, true);
    }
    throw this.portalError('REDIRECT_LOOP', 'login', this.lastPostLoginDiagnostic, true);
  }

  /**
   * Descubre el portfolio completo luego del login. La pantalla
   * navigateSelectUserType es una pantalla válida de autenticación, no un
   * error de credenciales. Se enumeran todas las opciones y sólo se fija
   * contexto automáticamente si existe exactamente un suministro.
   */
  async discoverPortfolio() {
    const html = this.userTypePage || (await this.fetchAccountPage());
    const options = this.userTypeOptions || parseUserTypeOptions(html);
    const diagnostic = buildDiscoveryDiagnostic(html, options, this.lastPostLoginDiagnostic);
    logEvent('info', 'portal.discovery.parsed', diagnostic);
    if (!options.length) {
      const error = this.portalError('DISCOVERY_OPTIONS_UNPARSEABLE', 'discovery', diagnostic, true);
      logEvent('warn', 'portal.discovery.failed', { code: error.code, ...diagnostic });
      throw error;
    }
    const enrichedOptions = [];
    for (const option of options) {
      const ids = mergeIdentifiers({}, option.ids || {});
      let enriched = ids;
      if (ids.saId && ids.spId) {
        try {
          enriched = mergeDiscoveryIdentifiersOrThrow(
            enriched,
            extractAccountIdentifiers(await this.fetchCurvePage(ids.saId, ids.spId))
          );
        } catch (error) {
          if (error.code === 'PORTFOLIO_IDENTITY_CONFLICT') throw error;
          /* opción visible pero curva temporalmente no disponible */
        }
      }
      if (enriched.saId && (!enriched.meterId || !enriched.badge)) {
        try {
          enriched = mergeDiscoveryIdentifiersOrThrow(
            enriched,
            extractAccountIdentifiers(await this.fetchConsumptionHistoryPage(enriched.saId))
          );
        } catch (error) {
          if (error.code === 'PORTFOLIO_IDENTITY_CONFLICT') throw error;
          /* conservar la opción para diagnóstico */
        }
      }
      enrichedOptions.push({
        ...option,
        ids: enriched,
        accountNumber: option.accountNumber || enriched.accountNumber || null,
      });
    }

    const canonical = canonicalizeDiscoveryCandidates(enrichedOptions);
    logEvent('info', 'portal.discovery.canonicalized', {
      raw_candidate_count: options.length,
      service_candidate_count: canonical.serviceCandidateCount,
      metadata_candidate_count: canonical.metadataCandidateCount,
      canonical_supply_count: canonical.canonicalCandidateCount,
      duplicates_collapsed_count: canonical.duplicatesCollapsedCount,
      ambiguous_count: canonical.ambiguousCount,
    });
    if (canonical.errorCode) {
      const error = this.portalError(canonical.errorCode, 'discovery', {
        ...diagnostic,
        ambiguous_count: canonical.ambiguousCount,
        identity_conflict_count: canonical.identityConflictCount,
      });
      logEvent('warn', 'portal.discovery.identity_failed', {
        code: error.code,
        ambiguous_count: canonical.ambiguousCount,
        identity_conflict_count: canonical.identityConflictCount,
      });
      throw error;
    }
    if (!canonical.candidates.length) {
      const error = this.portalError('DISCOVERY_OPTIONS_UNPARSEABLE', 'discovery', diagnostic, true);
      logEvent('warn', 'portal.discovery.failed', { code: error.code, ...diagnostic });
      throw error;
    }

    const accountGroups = new Map();
    for (const option of canonical.candidates) {
      const enriched = option.ids;
      const accountNumber = option.accountNumber || enriched.accountNumber || `opcion-${option.index}`;
      const accountId = option.accountId || accountNumber;
      const key = `${accountId}`;
      if (!accountGroups.has(key)) accountGroups.set(key, { accountId, accountNumber, accountAlias: option.accountAlias || `Cuenta ${accountNumber}`, supplies: [] });
      accountGroups.get(key).supplies.push({
        alias: option.supplyAlias || option.label || `Suministro ${option.index}`,
        location: option.location || 'Ubicación no disponible',
        saId: enriched.saId,
        spId: enriched.spId,
        meterId: enriched.meterId,
        badge: enriched.badge,
        meters: enriched.meterId ? [{ id: enriched.meterId, label: 'Medidor principal', type: 'electricity', status: 'unknown' }] : [],
        capabilities: { hasAMI: Boolean(enriched.meterId), supportsMaxDemand: false, supportsDailyDetail: Boolean(enriched.spId), canEstimateTRT: true },
        tariffs: [],
        selectedByDefault: canonical.candidates.length === 1,
      });
    }
    const portfolio = normalizePortalIdentity({
      source: 'ute-portal',
      discoveryRevision: CURRENT_DISCOVERY_REVISION,
      accounts: [...accountGroups.values()],
    });
    const supplies = portfolio.accounts.flatMap((account) => account.supplies);
    logEvent('info', 'portal.discovery.ready', {
      ...diagnostic,
      supply_count: supplies.length,
      complete_context_count: supplies.filter((supply) => ['saId', 'spId', 'meterId', 'badge'].every((key) => Boolean(supply.technical?.[key]))).length,
    });
    if (supplies.length === 1) this.setSupplyContext(supplies[0].technical);
    return portfolio;
  }

  setSupplyContext(context = {}) {
    const technical = context.technical && typeof context.technical === 'object'
      ? context.technical
      : context;
    this.context = Object.freeze({
      saId: technical.saId || null,
      spId: technical.spId || null,
      meterId: technical.meterId || null,
      badge: technical.badge || null,
      accountNumber: context.accountNumber || technical.accountNumber || null,
      portfolioSupplyCount: Number(context.portfolioSupplyCount || technical.portfolioSupplyCount || 0),
    });
    return this.context;
  }

  async fetchAccountPage() {
    const response = await this.client.get(`${BASE}/account`);
    const diagnostic = classifyPostLoginPage(response, { afterAuthentication: true });
    this.lastPostLoginDiagnostic = diagnostic;
    if (diagnostic.state !== STATES.ACCOUNT) {
      const code = diagnostic.state === STATES.LOGIN_FORM || diagnostic.state === STATES.SESSION_EXPIRED
        ? 'SESSION_EXPIRED'
        : diagnostic.state === STATES.PORTAL_MAINTENANCE
          ? 'PORTAL_MAINTENANCE'
          : 'ACCOUNT_PAGE_UNAVAILABLE';
      throw this.portalError(code, 'discovery', diagnostic, code !== 'SESSION_EXPIRED');
    }
    return response.text;
  }

  findSafeFormTransition(response) {
    const forms = inspectForms(response.text, response.url);
    const submissions = forms
      .map((form) => buildSafeFormSubmission(form))
      .filter((candidate) => candidate.ok);
    if (submissions.length !== 1) {
      return { ok: false, reason: submissions.length > 1 ? 'selection_required' : 'unparseable' };
    }
    return { ok: true, submission: submissions[0] };
  }

  findSafeScriptTransition(response) {
    const redirect = extractJsRedirect(response.text);
    if (redirect) {
      const action = safePortalUrl(redirect, response.url);
      if (action && isSafePortalUrl(action)) return { ok: true, submission: { method: 'GET', action, values: {} } };
      return { ok: false, reason: 'unsafe_redirect' };
    }
    return this.findSafeFormTransition(response);
  }

  async submitForm(submission, referer) {
    if (!submission?.action || !isSafePortalUrl(submission.action)) {
      throw this.portalError('USER_TYPE_SELECTION_UNPARSEABLE', 'login', this.lastPostLoginDiagnostic);
    }
    const headers = { referer };
    if (submission.method === 'GET') {
      const url = new URL(submission.action);
      Object.entries(submission.values || {}).forEach(([key, value]) => url.searchParams.set(key, value));
      return this.client.get(url.href, { headers });
    }
    return this.client.postForm(submission.action, submission.values || {}, { headers });
  }

  portalError(code, operation, diagnostic, retryable = false) {
    const messages = {
      INVALID_CREDENTIALS: 'UTE no pudo validar las credenciales. Revisá usuario/número de cuenta y contraseña.',
      SESSION_EXPIRED: 'La sesión de UTE venció durante la operación. Volvé a intentar.',
      USER_TYPE_SELECTION_REQUIRED: 'UTE requiere una selección de perfil que no se puede decidir automáticamente.',
      USER_TYPE_SELECTION_UNPARSEABLE: 'UTE mostró una selección de perfil que esta versión no pudo interpretar de forma segura.',
      ACCOUNT_PAGE_UNAVAILABLE: 'UTE no entregó una página de cuenta utilizable.',
      DISCOVERY_FAILED: 'UTE no devolvió una pantalla autenticada reconocible para descubrir los suministros.',
      DISCOVERY_OPTIONS_UNPARSEABLE: 'UTE no devolvió opciones de suministro interpretables. Revisá el diagnóstico seguro.',
      PORTAL_UNAVAILABLE: 'El portal UTE devolvió un error temporal. Probá nuevamente más tarde.',
      PORTAL_MAINTENANCE: 'El portal UTE está en mantenimiento.',
      CHALLENGE_UNSUPPORTED: 'UTE solicitó un paso interactivo no compatible con la sincronización automática.',
      PORTFOLIO_IDENTITY_AMBIGUOUS: 'UTE devolvió referencias ambiguas que podrían pertenecer a más de un suministro. No se eligió ninguna automáticamente.',
      PORTFOLIO_IDENTITY_CONFLICT: 'UTE devolvió identificadores contradictorios para un mismo suministro. La sincronización se bloqueó para evitar mezclar datos.',
      REDIRECT_LOOP: 'UTE redirigió demasiadas veces durante el inicio de sesión.',
    };
    const error = new Error(messages[code] || 'No se pudo completar la operación con UTE.');
    error.code = code;
    error.operation = operation;
    error.stage = diagnostic?.state || STATES.UNKNOWN;
    error.retryable = retryable;
    error.diagnostic = diagnostic || null;
    return error;
  }

  async discoverIdentifiers() {
    const accountHtml = await this.fetchAccountPage();
    const accountIds = extractAccountIdentifiers(accountHtml);
    this.context = Object.freeze(mergeIdentifiers(this.context, accountIds));

    if (this.context.saId && this.context.spId) {
      const curvaHtml = await this.fetchCurvePage(this.context.saId, this.context.spId);
      const curveIds = extractAccountIdentifiers(curvaHtml);
      this.context = Object.freeze(mergeIdentifiers(this.context, curveIds));
    } else {
      const fallbackCurvaLinks = this.extractCurveRouteCandidates(accountHtml);
      if (fallbackCurvaLinks[0]) {
        const url = fallbackCurvaLinks[0];
        const match = url.match(/saId=(\d+).*spId=(\d+)/i);
        if (match) {
          this.context = Object.freeze({ ...this.context, saId: this.context.saId || match[1], spId: this.context.spId || match[2] });
          const curvaHtml = await this.fetchCurvePage(this.context.saId, this.context.spId);
          const curveIds = extractAccountIdentifiers(curvaHtml);
          this.context = Object.freeze(mergeIdentifiers(this.context, curveIds));
        }
      }
    }

    if (!this.context.meterId || !this.context.badge) {
      const consumoRoute = this.extractConsumptionRouteCandidate(accountHtml);
      if (consumoRoute) {
        const parsedUrl = new URL(consumoRoute, `${BASE}/`);
        this.context = Object.freeze({ ...this.context, meterId: this.context.meterId || parsedUrl.searchParams.get('meterId'), badge: this.context.badge || parsedUrl.searchParams.get('badge') });
      }
    }

    if ((!this.context.meterId || !this.context.badge) && this.context.saId) {
      const consumoHtml = await this.fetchConsumptionHistoryPage(this.context.saId);
      const consumoRoute = this.extractConsumptionRouteCandidate(consumoHtml);
      if (consumoRoute) {
        const parsedUrl = new URL(consumoRoute, `${BASE}/`);
        this.context = Object.freeze({ ...this.context, meterId: this.context.meterId || parsedUrl.searchParams.get('meterId'), badge: this.context.badge || parsedUrl.searchParams.get('badge') });
      }
      const consumoIds = extractAccountIdentifiers(consumoHtml);
      this.context = Object.freeze(mergeIdentifiers(this.context, consumoIds));
    }

    return this.context;
  }

  async fetchCurvePage(saId, spId) {
    const response = await this.client.get(`${BASE}/cmvisualizarcurvadecarga?saId=${saId}&spId=${spId}`);
    return response.text;
  }

  async fetchConsumptionHistoryPage(saId) {
    const response = await this.client.get(`${BASE}/cmhistorialconsumo?saId=${saId}`);
    return response.text;
  }

  async fetchMonthlyHistory() {
    await this.ensureIds(['meterId', 'badge']);
    const punta = await this.fetchEnergyReadings('PUNTA', 'Punta');
    const valle = await this.fetchEnergyReadings('VALLE', 'Valle');
    const llano = await this.fetchEnergyReadings('LLANO', 'Llano');
    return { punta, valle, llano, combined: combineData(punta, valle, llano, []) };
  }

  async fetchBills() {
    const candidates = [
      `${BASE}/historialfacturas?tipoDoc=TODOS&getAll=true`,
      `${BASE}/CMBillingHistory?tipoDoc=TODOS&getAll=true`,
    ];

    let lastError = null;
    for (const url of candidates) {
      try {
        const response = await this.client.get(url);
        return parseBillingHistory(response.text);
      } catch (error) {
        lastError = error;
      }
    }

    throw lastError || new Error('No pude leer historial de facturas');
  }

  async fetchFullMonthlyDataset() {
    await this.ensureIds(['meterId', 'badge']);
    const punta = await this.fetchEnergyReadings('PUNTA', 'Punta');
    const valle = await this.fetchEnergyReadings('VALLE', 'Valle');
    const llano = await this.fetchEnergyReadings('LLANO', 'Llano');
    // El historial de facturas del autoservicio no acepta un supplyId y puede
    // devolver documentos de otra cuenta del mismo usuario. En portfolios
    // múltiples preferimos omitir el costo real antes que mezclar suministros.
    const isMultiSupply = this.context.portfolioSupplyCount > 1;
    const bills = isMultiSupply ? [] : await this.fetchBills();
    const dataset = combineData(punta, valle, llano, bills);
    return isMultiSupply ? dataset : this.supplementHistoricGapWithBills(dataset, bills);
  }

  async fetchCurrentPeriod(options = {}) {
    await this.ensureIds(['saId', 'spId']);
    const curveHtml = await this.fetchCurvePage(this.context.saId, this.context.spId);
    const inicioRaw = parseDatepickerValue(curveHtml, `datepicker_${this.context.spId}_inicio`);
    const fin = parseDatepickerValue(curveHtml, `datepicker_${this.context.spId}_fin`);

    if (!inicioRaw || !fin) {
      throw new Error('No pude leer fechas del periodo actual desde cmvisualizarcurvadecarga');
    }

    const [d, m, y] = inicioRaw.split('-').map(Number);
    const realStartDate = new Date(y, m - 1, d - 1);
    const inicio = formatPortalDate(realStartDate);

    const dailyData = await this.fetchJson(this.buildGraficarUrl('CURVA_DE_CONSUMO', inicio, fin, 'D'));
    let totalsData = await this.fetchJson(this.buildGraficarUrl('CONSUMO_ACTUAL', inicio, fin), {
      nullOnFailure: true,
    });
    if ((!totalsData || !hasValidTotalsPayload(totalsData)) && options.fallbackTotals) {
      totalsData = buildTotalsPayloadFromFallback(options.fallbackTotals);
    }
    const current = parsePeriodPayload(inicio, fin, dailyData, totalsData);

    const prevStart = formatPortalDate(shiftMonth(realStartDate, -1));
    const prevEndDate = new Date(realStartDate);
    prevEndDate.setDate(prevEndDate.getDate() - 1);
    const prevEnd = formatPortalDate(prevEndDate);

    let previousClosed = null;
    try {
      previousClosed = await this.fetchPeriodDetail(prevStart, prevEnd);
    } catch (error) {
      previousClosed = { error: 'previous_period_unavailable' };
    }

    return {
      ...current,
      portal_inicio_mostrado: inicioRaw,
      periodo_cerrado_anterior: previousClosed,
    };
  }

  async fetchPeriodDetail(periodoInicio, periodoFin, options = {}) {
    await this.ensureIds(['spId']);
    const dailyData = await this.fetchJson(this.buildGraficarUrl('CURVA_DE_CONSUMO', periodoInicio, periodoFin, 'D'));
    let totalsData = await this.fetchJson(this.buildGraficarUrl('CONSUMO_ACTUAL', periodoInicio, periodoFin), {
      nullOnFailure: true,
    });
    if ((!totalsData || !hasValidTotalsPayload(totalsData)) && options.fallbackTotals) {
      totalsData = buildTotalsPayloadFromFallback(options.fallbackTotals);
    }
    return parsePeriodPayload(periodoInicio, periodoFin, dailyData, totalsData);
  }

  async fetchEnergyReadings(tou, label) {
    const url = `${BASE}/cmVerConsumo?meterId=${this.context.meterId}&tou=${tou}&uom=KWH&badge=${this.context.badge}&energia=${encodeURIComponent(`Energía ${label} kWh`)}`;
    const response = await this.client.get(url);
    return parseConsumptionHistory(response.text);
  }

  async fetchBillDetail(bill) {
    if (!bill?.billId) {
      throw new Error('Factura sin billId');
    }

    const response = await this.client.get(`${BASE}/cmviewbill?billId=${bill.billId}`);
    return parseBillPdfBuffer(response.buffer, bill);
  }

  async supplementHistoricGapWithBills(dataset, bills) {
    if (!Array.isArray(dataset) || dataset.length === 0) return dataset;
    if (!Array.isArray(bills) || bills.length === 0) return dataset;

    const missingCount = Math.max(0, MIN_MONTHLY_HISTORY_MONTHS - dataset.length);
    if (!missingCount) return dataset;

    const existingKeys = new Set(dataset.map(toDatasetMonthKey));
    const earliestKey = [...existingKeys].sort()[0];
    if (!earliestKey) return dataset;

    const candidateBills = bills
      .filter((bill) => {
        const key = billMonthKey(bill);
        return key && key < earliestKey && !existingKeys.has(key);
      })
      .sort((a, b) => comparePortalDatesDesc(a.emision, b.emision))
      .slice(0, missingCount);

    if (!candidateBills.length) return dataset;

    const supplemented = [...dataset];
    for (const bill of candidateBills) {
      try {
        const detail = await this.fetchBillDetail(bill);
        const key = toDatasetMonthKey(detail);
        if (existingKeys.has(key)) continue;
        supplemented.push(detail);
        existingKeys.add(key);
      } catch (error) {
        console.warn(`⚠️  No pude completar la factura histórica ${bill.emision || 'sin fecha'}: no disponible`);
      }
    }

    return supplemented.sort((a, b) => new Date(a.fecha) - new Date(b.fecha));
  }

  buildGraficarUrl(name, fechaInicio, fechaFin, agrupacion) {
    const p = encodeURIComponent;
    const base = `${BASE}/cmgraficar`;

    if (name === 'CURVA_DE_CONSUMO') {
      return `${base}?${p('graficas[0][name]')}=${name}` +
        `&${p('graficas[0][parms][psId]')}=${this.context.spId}` +
        `&${p('graficas[0][parms][meterId]')}=` +
        `&${p('graficas[0][parms][fechaInicial]')}=${fechaInicio}` +
        `&${p('graficas[0][parms][fechaFinal]')}=${fechaFin}` +
        `&${p('graficas[0][parms][agrupacion]')}=${agrupacion || 'D'}` +
        `&${p('graficas[0][parms][magnitudes]')}=IMPORT_ACTIVE_ENERGY`;
    }

    return `${base}?${p('graficas[0][name]')}=${name}` +
      `&${p('graficas[0][parms][psId]')}=${this.context.spId}` +
      `&${p('graficas[0][parms][fechaInicial]')}=${fechaInicio}` +
      `&${p('graficas[0][parms][fechaFinal]')}=${fechaFin}`;
  }

  async fetchJson(url, options = {}) {
    const response = await this.client.get(url);
    const parsed = tryParseJson(response.text);
    if (!parsed) {
      if (options.nullOnFailure) return null;
      throw new Error('UTE devolvio contenido no JSON en un endpoint autenticado');
    }
    return parsed;
  }

  extractCurveRouteCandidates(html) {
    return [...String(html || '').matchAll(/cmvisualizarcurvadecarga\?saId=\d+&spId=\d+/gi)]
      .map((match) => `${BASE}/${match[0]}`);
  }

  extractConsumptionRouteCandidate(html) {
    const match = String(html || '').match(/cmVerConsumo\?[^"'\\\s<]+/i);
    return match ? `${BASE}/${match[0]}` : null;
  }

  isLoggedInText(text) {
    const body = String(text || '');
    return (
      body.includes('Numero de cuenta') ||
      body.includes('Número de cuenta') ||
      body.includes('Acuerdos de servicio') ||
      body.includes('Mis Servicios') ||
      body.includes('Salir')
    );
  }

  async ensureIds(requiredKeys) {
    const missing = requiredKeys.filter((key) => !this.context[key]);
    if (!missing.length) return;
    // El descubrimiento genérico toma el primer contexto que devuelve el
    // portal. Con más de un suministro eso puede mezclar una cuenta con otra;
    // en ese caso fallamos cerrados y pedimos que el descubrimiento de cartera
    // entregue el contexto técnico completo del suministro elegido.
    if (Number(this.context.portfolioSupplyCount || 0) > 1) {
      const error = new Error(`Contexto técnico incompleto para el suministro seleccionado: ${missing.join(', ')}`);
      error.code = 'MULTI_ACCOUNT_CONTEXT_INCOMPLETE';
      throw error;
    }
    await this.discoverIdentifiers();
    const stillMissing = requiredKeys.filter((key) => !this.context[key]);
    if (stillMissing.length) {
      throw new Error(`Faltan identificadores UTE: ${stillMissing.join(', ')}`);
    }
  }
}

function parseUserTypeOptions(html) {
  const source = String(html || '');
  const options = [];
  const blocks = source.match(/<(?:a|button|option|input|div|li)[^>]*(?:saId|spId|meterId|account|cuenta|suministro|servicio)[^>]*>[^<]*|<(?:a|button|option|input|div|li)[^>]*>[^<]*(?:saId|spId|meterId|account|cuenta|suministro|servicio)[^<]*/gi) || [];
  const candidates = blocks.length ? blocks : [source];
  candidates.forEach((block, index) => {
    const ids = extractAccountIdentifiers(block);
    const accountNumber = ids.accountNumber || block.match(/(?:accountNumber|cuenta)[^0-9]{0,10}(\d{6,})/i)?.[1] || null;
    const label = stripHtml(block).replace(/\s+/g, ' ').trim().slice(0, 120);
    const tagName = block.match(/^\s*<\s*([a-z0-9]+)/i)?.[1]?.toLowerCase() || '';
    const openingTag = block.match(/^\s*<[^>]+>/)?.[0] || '';
    const explicitActionable = ['a', 'button', 'option', 'input', 'li'].includes(tagName) ||
      /\b(?:onclick|onchange|onmousedown|onkeydown|tabindex|data-(?:action|target|value|id|account|supply|service))\s*=/i.test(openingTag) ||
      /\brole\s*=\s*["']?(?:button|link|option|menuitem|radio)/i.test(openingTag);
    const hasTechnicalIdentity = Boolean(ids.saId || ids.spId || ids.meterId || ids.badge);
    const isAccountHeader = tagName === 'div' && /^n[uú]mero de cuenta\s*:?[\s\d-]*$/i.test(label);
    const isGlobalHeader = tagName === 'div' && /^(?:mis servicios|acuerdos de servicio)$/i.test(label);
    const knownMetadata = isGlobalHeader || (isAccountHeader && Boolean(accountNumber));
    // No podemos observar listeners registrados desde JavaScript externo. Por
    // eso todo bloque no identificado que parezca una cuenta/suministro se
    // considera ambiguo, salvo headers decorativos conocidos y acotados.
    const actionable = explicitActionable || (!hasTechnicalIdentity && !knownMetadata);
    if (accountNumber || ids.saId || ids.spId || ids.meterId || /suministro|servicio|cuenta/i.test(label)) {
      options.push({
        index: index + 1,
        ids,
        accountNumber,
        label: label || `Opción ${index + 1}`,
        accountAlias: label || null,
        supplyAlias: label || null,
        actionable,
        metadataKind: isAccountHeader ? 'account-header' : isGlobalHeader ? 'global-header' : null,
      });
    }
  });
  // Algunas cuentas llegan a navigateSelectUserType con las opciones dentro
  // de rutas de curva embebidas en scripts, sin texto/atributos que el
  // selector HTML anterior pueda reconocer. Cada ruta se procesa por separado
  // para no colapsar varios suministros en el primer match global.
  extractServiceRouteOptions(source).forEach((route, index) => {
    const ids = extractAccountIdentifiers(route);
    if (!ids.saId || !ids.spId) return;
    options.push({
      index: options.length + index + 1,
      ids,
      accountNumber: ids.accountNumber || null,
      label: `Suministro detectado ${index + 1}`,
      accountAlias: null,
      supplyAlias: null,
      actionable: true,
    });
  });
  return dedupeOptions(options);
}

function stripHtml(value) { return String(value || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&'); }

function extractServiceRouteOptions(source) {
  const raw = String(source || '').replace(/&amp;/gi, '&');
  const routeMatches = [...raw.matchAll(/cmvisualizarcurvadecarga\?[^"'\\\s<]+/gi)].map((match) => match[0]);
  return [...new Set(routeMatches)];
}

function buildDiscoveryDiagnostic(html, options, postLoginDiagnostic = null) {
  const source = String(html || '');
  const classified = postLoginDiagnostic || classifyPostLoginPage({ text: source });
  return {
    stage: classified.state === STATES.USER_TYPE_SELECTION ? 'navigate_select_user_type' : classified.state,
    status_code: classified.statusCode,
    content_type: classified.contentType,
    pathname: classified.pathname,
    redirect_pathnames: classified.redirectPathnames,
    form_count: classified.formCount,
    form_methods: classified.formMethods,
    form_action_pathnames: classified.formActionPathnames,
    field_names: classified.fieldNames,
    select_count: classified.selectCount,
    option_count: Array.isArray(options) ? options.length : classified.optionCount,
    option_with_sa_sp_count: (options || []).filter((option) => option?.ids?.saId && option?.ids?.spId).length,
    link_count: classified.linkCount,
    script_count: classified.scriptCount,
    login_marker_present: classified.loginMarkerPresent,
    page_marker_present: classified.selectionMarkerPresent,
    account_marker_present: classified.accountMarkerPresent,
    error_marker_present: classified.errorMarkerPresent,
    maintenance_marker_present: classified.maintenanceMarkerPresent,
    js_redirect_present: classified.jsRedirectPresent,
    auto_submit_present: classified.autoSubmitPresent,
    html_length_bucket: classified.htmlLengthBucket,
    title_class: classified.titleClass,
    body_fingerprint: classified.bodyFingerprint,
    service_route_count: extractServiceRouteOptions(source).length,
  };
}

function dedupeOptions(options) {
  const seen = new Set();
  return options.filter((option) => {
    const technical = [option.ids.saId, option.ids.spId, option.ids.meterId, option.ids.badge].filter(Boolean);
    const key = technical.length ? technical.join('|') : [option.accountNumber, option.label].join('|');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const DISCOVERY_IDENTITY_KEYS = Object.freeze(['saId', 'spId', 'meterId', 'badge']);

function canonicalizeDiscoveryCandidates(options) {
  const opaqueActionableCandidates = (options || [])
    .filter((option) => option?.actionable && !hasAnyTechnicalIdentity(option?.ids));
  const serviceCandidates = (options || [])
    .filter((option) => hasAnyTechnicalIdentity(option?.ids))
    .map(cloneDiscoveryCandidate)
    .sort(compareCandidateStrength);
  const metadataCandidateCount = Math.max(0, (options || []).length - serviceCandidates.length - opaqueActionableCandidates.length);
  const accountHeaders = (options || []).filter((option) => option?.metadataKind === 'account-header');
  const primary = serviceCandidates.filter((candidate) => hasPrimaryIdentity(candidate.ids));
  const partial = serviceCandidates.filter((candidate) => !hasPrimaryIdentity(candidate.ids));
  const clusters = [];
  const unresolvedSecondary = [];
  let identityConflictCount = 0;
  let ambiguousCount = opaqueActionableCandidates.length;
  let mergeCount = 0;

  for (const candidate of primary) {
    const match = clusters.find((cluster) => samePrimaryIdentity(cluster.ids, candidate.ids));
    if (!match) {
      clusters.push(candidate);
      continue;
    }
    if (hasIdentityConflict(match, candidate)) {
      identityConflictCount += 1;
      continue;
    }
    mergeDiscoveryCandidate(match, candidate);
    mergeCount += 1;
  }

  if (identityConflictCount) {
    return canonicalizationResult('PORTFOLIO_IDENTITY_CONFLICT', clusters);
  }

  for (let leftIndex = 0; leftIndex < clusters.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < clusters.length; rightIndex += 1) {
      if (primaryClustersConflict(clusters[leftIndex], clusters[rightIndex])) identityConflictCount += 1;
    }
  }
  if (identityConflictCount) {
    return canonicalizationResult('PORTFOLIO_IDENTITY_CONFLICT', clusters);
  }

  for (const candidate of partial) {
    const sharedWith = clusters.filter((cluster) => sharedIdentityCount(cluster.ids, candidate.ids) > 0);
    const conflicting = sharedWith.filter((cluster) => hasIdentityConflict(cluster, candidate));
    if (conflicting.length) {
      identityConflictCount += 1;
      continue;
    }
    const compatible = sharedWith.filter((cluster) => identitiesCompatible(cluster, candidate));
    if (compatible.length === 1) {
      mergeDiscoveryCandidate(compatible[0], candidate);
      mergeCount += 1;
      continue;
    }
    if (compatible.length > 1) {
      ambiguousCount += 1;
      continue;
    }
    if (hasSecondaryIdentity(candidate.ids)) {
      const secondaryMatch = unresolvedSecondary.find((cluster) =>
        sameSecondaryIdentity(cluster.ids, candidate.ids) && !hasIdentityConflict(cluster, candidate));
      if (secondaryMatch) {
        mergeDiscoveryCandidate(secondaryMatch, candidate);
        mergeCount += 1;
      }
      else unresolvedSecondary.push(candidate);
      continue;
    }
    ambiguousCount += 1;
  }

  for (const header of accountHeaders) {
    const headerAccount = header.accountNumber || header.ids?.accountNumber || null;
    const represented = Boolean(headerAccount && [...clusters, ...unresolvedSecondary].some((candidate) =>
      (candidate.accountNumber || candidate.ids?.accountNumber || null) === headerAccount));
    if (!represented) ambiguousCount += 1;
  }

  if (identityConflictCount) {
    return canonicalizationResult('PORTFOLIO_IDENTITY_CONFLICT', [...clusters, ...unresolvedSecondary]);
  }
  if (ambiguousCount) {
    return canonicalizationResult('PORTFOLIO_IDENTITY_AMBIGUOUS', [...clusters, ...unresolvedSecondary]);
  }

  const candidates = [...clusters, ...unresolvedSecondary].sort((left, right) => left.index - right.index);
  return canonicalizationResult(null, candidates);

  function canonicalizationResult(errorCode, candidates = []) {
    return {
      errorCode,
      candidates,
      serviceCandidateCount: serviceCandidates.length,
      metadataCandidateCount,
      canonicalCandidateCount: candidates.length,
      duplicatesCollapsedCount: mergeCount,
      ambiguousCount,
      identityConflictCount,
    };
  }
}

function hasAnyTechnicalIdentity(ids = {}) {
  return DISCOVERY_IDENTITY_KEYS.some((key) => Boolean(ids[key]));
}

function hasPrimaryIdentity(ids = {}) {
  return Boolean(ids.saId && ids.spId);
}

function hasSecondaryIdentity(ids = {}) {
  return Boolean(ids.meterId && ids.badge);
}

function samePrimaryIdentity(left = {}, right = {}) {
  return Boolean(left.saId && left.spId && left.saId === right.saId && left.spId === right.spId);
}

function sameSecondaryIdentity(left = {}, right = {}) {
  return Boolean(left.meterId && left.badge && left.meterId === right.meterId && left.badge === right.badge);
}

function primaryClustersConflict(left, right) {
  const leftIds = left.ids || {};
  const rightIds = right.ids || {};
  if (leftIds.spId && rightIds.spId && leftIds.spId === rightIds.spId && leftIds.saId !== rightIds.saId) return true;
  if (leftIds.meterId && rightIds.meterId && leftIds.meterId === rightIds.meterId) return true;
  if (leftIds.badge && rightIds.badge && leftIds.badge === rightIds.badge) return true;
  return false;
}

function sharedIdentityCount(left = {}, right = {}) {
  return DISCOVERY_IDENTITY_KEYS.filter((key) => left[key] && right[key] && left[key] === right[key]).length;
}

function identitiesCompatible(left, right) {
  const sharedCount = sharedIdentityCount(left.ids, right.ids);
  const sharesStrongIdentifier = ['spId', 'meterId', 'badge']
    .some((key) => left.ids[key] && left.ids[key] === right.ids[key]);
  return (sharesStrongIdentifier || sharedCount >= 2) && !hasIdentityConflict(left, right);
}

function hasIdentityConflict(left, right) {
  if (left.accountNumber && right.accountNumber && left.accountNumber !== right.accountNumber) return true;
  return DISCOVERY_IDENTITY_KEYS.some((key) => left.ids[key] && right.ids[key] && left.ids[key] !== right.ids[key]);
}

function cloneDiscoveryCandidate(candidate) {
  return {
    ...candidate,
    ids: { ...(candidate.ids || {}) },
    index: Number(candidate.index || 0),
  };
}

function compareCandidateStrength(left, right) {
  const score = (candidate) => DISCOVERY_IDENTITY_KEYS.filter((key) => Boolean(candidate.ids[key])).length;
  return score(right) - score(left) || left.index - right.index;
}

function mergeDiscoveryCandidate(target, incoming) {
  target.ids = mergeIdentifiers(target.ids, incoming.ids);
  target.accountNumber = target.accountNumber || incoming.accountNumber || target.ids.accountNumber || null;
  target.accountId = target.accountId || incoming.accountId || null;
  target.label = preferDiscoveryLabel(target.label, incoming.label);
  target.accountAlias = preferDiscoveryLabel(target.accountAlias, incoming.accountAlias);
  target.supplyAlias = preferDiscoveryLabel(target.supplyAlias, incoming.supplyAlias);
  target.location = target.location || incoming.location || null;
  target.index = Math.min(target.index || incoming.index, incoming.index || target.index);
  return target;
}

function mergeDiscoveryIdentifiersOrThrow(base, incoming) {
  const left = { ids: base || {}, accountNumber: base?.accountNumber || null };
  const right = { ids: incoming || {}, accountNumber: incoming?.accountNumber || null };
  if (hasIdentityConflict(left, right)) {
    const error = new Error('UTE devolvió identificadores contradictorios durante el enriquecimiento del suministro.');
    error.code = 'PORTFOLIO_IDENTITY_CONFLICT';
    error.operation = 'discovery';
    throw error;
  }
  return mergeIdentifiers(base || {}, incoming || {});
}

function preferDiscoveryLabel(current, incoming) {
  const generic = /^(?:opci[oó]n|suministro detectado)\s+\d+$/i;
  if (!current) return incoming || null;
  if (generic.test(String(current)) && incoming && !generic.test(String(incoming))) return incoming;
  return current;
}

function hasValidTotalsPayload(data) {
  const total = data?.CONSUMO_ACTUAL?.consumoActual?.data?.datasets?.[0]?.data?.[0] || 0;
  return Number(total) > 0;
}

function buildTotalsPayloadFromFallback(fallbackTotals) {
  return {
    CONSUMO_ACTUAL: {
      consumoActual: {
        data: {
          datasets: [{ data: [Number(fallbackTotals.consumo_kwh || 0)] }]
        }
      },
      consumoActualTramoHorario: {
        data: {
          datasets: [
            { label: 'Punta', data: [Number(fallbackTotals.punta_kwh || 0)] },
            { label: 'Valle', data: [Number(fallbackTotals.valle_kwh || 0)] },
            { label: 'Llano', data: [Number(fallbackTotals.llano_kwh || 0)] }
          ]
        }
      }
    }
  };
}

function mergeIdentifiers(base, incoming) {
  return {
    ...base,
    saId: base.saId || incoming.saId || null,
    spId: base.spId || incoming.spId || null,
    meterId: base.meterId || incoming.meterId || null,
    badge: base.badge || incoming.badge || null,
    accountNumber: base.accountNumber || incoming.accountNumber || null,
    rawNumericIds: [...new Set([...(base.rawNumericIds || []), ...(incoming.rawNumericIds || [])])],
  };
}

function toDatasetMonthKey(row) {
  return `${row.año}-${String(row.mes).padStart(2, '0')}`;
}

function billMonthKey(bill) {
  if (!bill?.emision) return null;
  const parts = String(bill.emision).split('-').map(Number);
  if (parts.length !== 3 || !parts[1] || !parts[2]) return null;
  return `${parts[2]}-${String(parts[1]).padStart(2, '0')}`;
}

function comparePortalDatesDesc(left, right) {
  return portalDateToStamp(right) - portalDateToStamp(left);
}

function portalDateToStamp(text) {
  const parts = String(text || '').split('-').map(Number);
  return new Date(parts[2], (parts[1] || 1) - 1, parts[0] || 1).getTime();
}

function loadEnvIfPresent(envPath) {
  if (!envPath) return;
  if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath, override: false });
  }
}

module.exports = { UtePortalClient, BASE, parseUserTypeOptions, canonicalizeDiscoveryCandidates };
