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
const { normalizePortalIdentity } = require('../portfolio_contract');

const BASE = 'https://autoservicio.ute.com.uy/SelfService/SSvcController';
const MIN_MONTHLY_HISTORY_MONTHS = 26;

class UtePortalClient {
  constructor(options = {}) {
    loadEnvIfPresent(options.envPath);

    this.userId = options.userId || process.env.UTE_USER_ID || process.env.UTE_EMAIL;
    this.password = options.password || process.env.UTE_PASSWORD;
    this.client = new HttpClient();
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

    await this.client.get(`${BASE}/login`);
    const response = await this.client.postForm(`${BASE}/authenticate`, {
      userId: this.userId,
      password: this.password,
    }, {
      headers: {
        referer: `${BASE}/login`,
      },
    });

    const loggedIn = this.isLoggedInText(response.text);
    if (response.url && response.url.includes('/navigateSelectUserType')) {
      this.userTypePage = response.text;
      this.userTypeOptions = parseUserTypeOptions(response.text);
      return response;
    }
    if (!loggedIn) {
      const account = await this.client.get(`${BASE}/account`);
      if (!this.isLoggedInText(account.text)) {
        throw new Error('Login HTTP fallido - verificar credenciales o flujo del portal');
      }
      return account;
    }

    return response;
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
    const accountGroups = new Map();
    for (const option of options) {
      const ids = mergeIdentifiers({}, option.ids || {});
      let enriched = ids;
      if (ids.saId && ids.spId) {
        try {
          enriched = mergeIdentifiers(enriched, extractAccountIdentifiers(await this.fetchCurvePage(ids.saId, ids.spId)));
        } catch (_) { /* opción visible pero curva temporalmente no disponible */ }
      }
      if (enriched.saId && (!enriched.meterId || !enriched.badge)) {
        try {
          enriched = mergeIdentifiers(enriched, extractAccountIdentifiers(await this.fetchConsumptionHistoryPage(enriched.saId)));
        } catch (_) { /* conservar la opción para diagnóstico */ }
      }
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
        selectedByDefault: options.length === 1,
      });
    }
    const portfolio = normalizePortalIdentity({ source: 'ute-portal', accounts: [...accountGroups.values()] });
    const supplies = portfolio.accounts.flatMap((account) => account.supplies);
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
    if (!this.isLoggedInText(response.text)) {
      throw new Error('Sesion no valida al pedir /account');
    }
    return response.text;
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
  const blocks = source.match(/<(?:a|button|option|input|div)[^>]*(?:saId|spId|meterId|account|suministro|servicio)[^>]*>[^<]*|<(?:a|button|option|input|div)[^>]*>[^<]*(?:saId|spId|meterId|account|suministro|servicio)[^<]*/gi) || [];
  const candidates = blocks.length ? blocks : [source];
  candidates.forEach((block, index) => {
    const ids = extractAccountIdentifiers(block);
    const accountNumber = ids.accountNumber || block.match(/(?:accountNumber|cuenta)[^0-9]{0,10}(\d{6,})/i)?.[1] || null;
    const label = stripHtml(block).replace(/\s+/g, ' ').trim().slice(0, 120);
    if (accountNumber || ids.saId || ids.spId || ids.meterId || /suministro|servicio|cuenta/i.test(label)) {
      options.push({ index: index + 1, ids, accountNumber, label: label || `Opción ${index + 1}`, accountAlias: label || null, supplyAlias: label || null });
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

module.exports = { UtePortalClient, BASE, parseUserTypeOptions };
