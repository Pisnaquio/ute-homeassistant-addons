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

const BASE = 'https://autoservicio.ute.com.uy/SelfService/SSvcController';
const MIN_MONTHLY_HISTORY_MONTHS = 26;

class UtePortalClient {
  constructor(options = {}) {
    loadEnvIfPresent(options.envPath);

    this.userId = options.userId || process.env.UTE_USER_ID || process.env.UTE_EMAIL;
    this.password = options.password || process.env.UTE_PASSWORD;
    this.client = new HttpClient();
    this.ids = {
      saId: options.saId || process.env.UTE_SA_ID || null,
      spId: options.spId || process.env.UTE_SP_ID || null,
      meterId: options.meterId || process.env.UTE_METER_ID || null,
      badge: options.badge || process.env.UTE_BADGE || null,
    };
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
    if (!loggedIn) {
      const account = await this.client.get(`${BASE}/account`);
      if (!this.isLoggedInText(account.text)) {
        throw new Error('Login HTTP fallido - verificar credenciales o flujo del portal');
      }
      return account;
    }

    return response;
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
    this.ids = mergeIdentifiers(this.ids, accountIds);

    if (this.ids.saId && this.ids.spId) {
      const curvaHtml = await this.fetchCurvePage(this.ids.saId, this.ids.spId);
      const curveIds = extractAccountIdentifiers(curvaHtml);
      this.ids = mergeIdentifiers(this.ids, curveIds);
    } else {
      const fallbackCurvaLinks = this.extractCurveRouteCandidates(accountHtml);
      if (fallbackCurvaLinks[0]) {
        const url = fallbackCurvaLinks[0];
        const match = url.match(/saId=(\d+).*spId=(\d+)/i);
        if (match) {
          this.ids.saId = this.ids.saId || match[1];
          this.ids.spId = this.ids.spId || match[2];
          const curvaHtml = await this.fetchCurvePage(this.ids.saId, this.ids.spId);
          const curveIds = extractAccountIdentifiers(curvaHtml);
          this.ids = mergeIdentifiers(this.ids, curveIds);
        }
      }
    }

    if (!this.ids.meterId || !this.ids.badge) {
      const consumoRoute = this.extractConsumptionRouteCandidate(accountHtml);
      if (consumoRoute) {
        const parsedUrl = new URL(consumoRoute, `${BASE}/`);
        this.ids.meterId = this.ids.meterId || parsedUrl.searchParams.get('meterId');
        this.ids.badge = this.ids.badge || parsedUrl.searchParams.get('badge');
      }
    }

    if ((!this.ids.meterId || !this.ids.badge) && this.ids.saId) {
      const consumoHtml = await this.fetchConsumptionHistoryPage(this.ids.saId);
      const consumoRoute = this.extractConsumptionRouteCandidate(consumoHtml);
      if (consumoRoute) {
        const parsedUrl = new URL(consumoRoute, `${BASE}/`);
        this.ids.meterId = this.ids.meterId || parsedUrl.searchParams.get('meterId');
        this.ids.badge = this.ids.badge || parsedUrl.searchParams.get('badge');
      }
      const consumoIds = extractAccountIdentifiers(consumoHtml);
      this.ids = mergeIdentifiers(this.ids, consumoIds);
    }

    return this.ids;
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
    const bills = await this.fetchBills();
    const dataset = combineData(punta, valle, llano, bills);
    return this.supplementHistoricGapWithBills(dataset, bills);
  }

  async fetchCurrentPeriod(options = {}) {
    await this.ensureIds(['saId', 'spId']);
    const curveHtml = await this.fetchCurvePage(this.ids.saId, this.ids.spId);
    const inicioRaw = parseDatepickerValue(curveHtml, `datepicker_${this.ids.spId}_inicio`);
    const fin = parseDatepickerValue(curveHtml, `datepicker_${this.ids.spId}_fin`);

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
      previousClosed = { error: error.message };
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
    const url = `${BASE}/cmVerConsumo?meterId=${this.ids.meterId}&tou=${tou}&uom=KWH&badge=${this.ids.badge}&energia=${encodeURIComponent(`Energía ${label} kWh`)}`;
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
        console.warn(`⚠️  No pude completar la factura histórica ${bill.emision || bill.billId}: ${error.message}`);
      }
    }

    return supplemented.sort((a, b) => new Date(a.fecha) - new Date(b.fecha));
  }

  buildGraficarUrl(name, fechaInicio, fechaFin, agrupacion) {
    const p = encodeURIComponent;
    const base = `${BASE}/cmgraficar`;

    if (name === 'CURVA_DE_CONSUMO') {
      return `${base}?${p('graficas[0][name]')}=${name}` +
        `&${p('graficas[0][parms][psId]')}=${this.ids.spId}` +
        `&${p('graficas[0][parms][meterId]')}=` +
        `&${p('graficas[0][parms][fechaInicial]')}=${fechaInicio}` +
        `&${p('graficas[0][parms][fechaFinal]')}=${fechaFin}` +
        `&${p('graficas[0][parms][agrupacion]')}=${agrupacion || 'D'}` +
        `&${p('graficas[0][parms][magnitudes]')}=IMPORT_ACTIVE_ENERGY`;
    }

    return `${base}?${p('graficas[0][name]')}=${name}` +
      `&${p('graficas[0][parms][psId]')}=${this.ids.spId}` +
      `&${p('graficas[0][parms][fechaInicial]')}=${fechaInicio}` +
      `&${p('graficas[0][parms][fechaFinal]')}=${fechaFin}`;
  }

  async fetchJson(url, options = {}) {
    const response = await this.client.get(url);
    const parsed = tryParseJson(response.text);
    if (!parsed) {
      if (options.nullOnFailure) return null;
      throw new Error(`UTE devolvio contenido no JSON en ${url}`);
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
    const missing = requiredKeys.filter((key) => !this.ids[key]);
    if (!missing.length) return;
    await this.discoverIdentifiers();
    const stillMissing = requiredKeys.filter((key) => !this.ids[key]);
    if (stillMissing.length) {
      throw new Error(`Faltan identificadores UTE: ${stillMissing.join(', ')}`);
    }
  }
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

module.exports = { UtePortalClient, BASE };
