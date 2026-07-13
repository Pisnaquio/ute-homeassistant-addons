/**
 * Manages a persistent UTE portal session using Playwright.
 * Keeps the browser open between requests to avoid repeated logins.
 */

const { chromium } = require('playwright');
const { getChromiumLaunchOptions } = require('./runtime_env');
const { discoverPortalContext } = require('./portal_context');

const BASE = 'https://autoservicio.ute.com.uy/SelfService/SSvcController';
let sessionQuiet = false;
let portalContext = null;

function sessionLog(...args) {
  if (!sessionQuiet) console.log(...args);
}

function sessionWarn(...args) {
  if (!sessionQuiet) console.warn(...args);
}

function parsePortalDate(text) {
  const [d, m, y] = String(text || '').split('-').map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}

function formatPortalDate(date) {
  return String(date.getDate()).padStart(2, '0') + '-' +
    String(date.getMonth() + 1).padStart(2, '0') + '-' +
    date.getFullYear();
}

function shiftMonth(date, delta) {
  return new Date(date.getFullYear(), date.getMonth() + delta, date.getDate());
}

async function hasLoggedInContent(page) {
  let bodyText = '';
  for (let i = 0; i < 3; i++) {
    try {
      bodyText = await page.locator('body').innerText({ timeout: 5000 });
      break;
    } catch (err) {
      const msg = String(err.message || err);
      if (!msg.includes('Execution context was destroyed') && !msg.includes('Timeout')) throw err;
      await page.waitForTimeout(1000);
    }
  }
  return (
    bodyText.includes('Número de cuenta:') ||
    bodyText.includes('Acuerdos de servicio') ||
    bodyText.includes('Mis Servicios') ||
    bodyText.includes('Salir')
  );
}

let browser = null;
let page    = null;
let loggedIn = false;
let lastUsed = 0;
const SESSION_TTL = 20 * 60 * 1000; // 20 minutes

async function ensureSession(requestedSupplyContext = null) {
  const now = Date.now();

  // Check if we need to close a stale session
  if (browser && (now - lastUsed > SESSION_TTL)) {
    sessionLog('[UTE Session] Session TTL expired, restarting...');
    await close();
  }

  if (!browser) {
    sessionLog('[UTE Session] Launching browser...');
    browser = await chromium.launch(getChromiumLaunchOptions());
    page    = await browser.newPage();
    loggedIn = false;
  }

  if (!loggedIn) {
    sessionLog('[UTE Session] Logging in...');
    await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(1000);
    await page.fill('input[name="userId"]',   process.env.UTE_EMAIL);
    await page.fill('input[name="password"]', process.env.UTE_PASSWORD);
    await page.keyboard.press('Enter');
    await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(4000);

    let url = page.url();
    if (url.includes('/login')) {
      await page.goto(`${BASE}/account`, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
      await page.waitForTimeout(2000);
      url = page.url();
    }

    const loggedInContent = await hasLoggedInContent(page);
    if (url.includes('/login') && !loggedInContent) {
      loggedIn = false;
      throw new Error('UTE login failed — check credentials');
    }
    loggedIn = true;
    portalContext = exactTechnicalContext(requestedSupplyContext) || await discoverPortalContext(page, {
      logger: (...args) => sessionLog(...args)
    });
    sessionLog('[UTE Session] Logged in ✅');
  }

  const exactContext = exactTechnicalContext(requestedSupplyContext);
  if (exactContext) portalContext = exactContext;

  lastUsed = now;
  return page;
}

async function withSessionOptions(options, fn) {
  const prevQuiet = sessionQuiet;
  sessionQuiet = !!options.quiet;
  try {
    return await fn();
  } finally {
    sessionQuiet = prevQuiet;
  }
}

function tryParseJson(text) {
  try {
    return JSON.parse(text);
  } catch (error) {
    return null;
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

async function fetchTextViaGoto(p, url, label) {
  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await p.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: 25000
      });
      const text = response ? await response.text() : null;
      if (text) return text;
    } catch (err) {
      lastErr = err;
      await p.waitForTimeout(1000 * (attempt + 1));
    }
  }
  throw lastErr || new Error(`UTE no respondió al fallback de ${label}`);
}

async function fetchPeriodSnapshot(pageRef, periodoInicio, periodoFin, options = {}) {
  const dailyUrl = buildGraficarUrl('CURVA_DE_CONSUMO', periodoInicio, periodoFin, 'D');
  const dailyData = await fetchJson(pageRef, dailyUrl, {
    allowGotoFallback: true,
    label: 'CURVA_DE_CONSUMO'
  });

  const currentUrl = buildGraficarUrl('CONSUMO_ACTUAL', periodoInicio, periodoFin);
  let currentData = await fetchJson(pageRef, currentUrl, {
    allowGotoFallback: true,
    label: 'CONSUMO_ACTUAL',
    nullOnFailure: true
  });

  if ((!currentData || !hasValidTotalsPayload(currentData)) && options.fallbackTotals) {
    currentData = buildTotalsPayloadFromFallback(options.fallbackTotals);
  }

  const period = parsePeriodPayload(periodoInicio, periodoFin, dailyData, currentData);
  const totalDaily = (period.dias || []).reduce((sum, day) => sum + Number(day.kwh || 0), 0);
  if (!period.dias.length || !(period.consumo_kwh > 0) || totalDaily <= 0) {
    throw new Error('UTE no devolvió un detalle diario válido para ese período');
  }

  if (options.includePreviousComparison) {
    const startDate = parsePortalDate(periodoInicio);
    const endDate = parsePortalDate(periodoFin);
    const prevStart = formatPortalDate(shiftMonth(startDate, -1));
    const prevEnd = formatPortalDate(shiftMonth(endDate, -1));
    try {
      period.comparativa_anterior = await fetchPeriodSnapshot(pageRef, prevStart, prevEnd);
    } catch (err) {
      sessionWarn('[UTE Session] No se pudo cargar comparativa del período anterior:', err.message);
    }
  }

  return period;
}

/**
 * Fetch current billing period data (daily consumption + tramo breakdown).
 */
async function fetchCurrentPeriod(options = {}) {
  return withSessionOptions(options, async () => {
    const p = await ensureSession(options.supplyContext);
    if (!portalContext?.saId || !portalContext?.spId) {
      throw new Error('UTE session is missing saId/spId');
    }

    // Navigate to curva de carga to get the billing period dates
    await p.goto(
      `${BASE}/cmvisualizarcurvadecarga?saId=${portalContext.saId}&spId=${portalContext.spId}`,
      { waitUntil: 'domcontentloaded', timeout: 20000 }
    );
    await p.waitForTimeout(2000);

    // Read the billing period dates from the date pickers.
    // The portal sets datepicker_inicio = day AFTER the last meter reading (e.g., 28-03-2026
    // when the reading was on 27-03-2026). The real period start is one day earlier.
    // datepicker_fin = last date with available data (~today minus 48h).
    const fechaInicioRaw = await p.$eval('#datepicker_' + portalContext.spId + '_inicio', el => el.value).catch(() => null);
    const fechaFin       = await p.$eval('#datepicker_' + portalContext.spId + '_fin',    el => el.value).catch(() => null);

    if (!fechaInicioRaw || !fechaFin) {
      throw new Error('Could not read billing period dates');
    }

    // Real period start is one day before what the portal shows (the actual meter reading date)
    const [d, m, y] = fechaInicioRaw.split('-').map(Number);
    const realStartDate = new Date(y, m - 1, d - 1);
    const fechaInicio = formatPortalDate(realStartDate);
    const realEndDate = parsePortalDate(fechaFin);

    sessionLog(`[UTE Session] Billing period: ${fechaInicio} → ${fechaFin} (portal shows ${fechaInicioRaw})`);

    const currentPeriod = await fetchPeriodSnapshot(p, fechaInicio, fechaFin, {
      includePreviousComparison: true
    });

    // Fetch last fully closed billing period so the UI can show a provisional month
    const closedPrevStartDate = shiftMonth(realStartDate, -1);
    const closedPrevEndDate = new Date(realStartDate);
    closedPrevEndDate.setDate(closedPrevEndDate.getDate() - 1);
    const closedPrevStart = formatPortalDate(closedPrevStartDate);
    const closedPrevEnd   = formatPortalDate(closedPrevEndDate);
    let closedPreviousPeriod = null;
    try {
      closedPreviousPeriod = await fetchPeriodSnapshot(p, closedPrevStart, closedPrevEnd, {
        includePreviousComparison: true
      });
    } catch (err) {
      sessionWarn('[UTE Session] No se pudo cargar el período cerrado anterior:', err.message);
    }

    return {
      ...currentPeriod,
      periodo_cerrado_anterior: closedPreviousPeriod
    };
  });
}

async function fetchPeriodDetail(periodoInicio, periodoFin, options = {}) {
  return withSessionOptions(options, async () => {
    const p = await ensureSession(options.supplyContext);
    return fetchPeriodSnapshot(p, periodoInicio, periodoFin, {
      includePreviousComparison: true,
      fallbackTotals: options.fallbackTotals
    });
  });
}

function buildGraficarUrl(name, fechaInicio, fechaFin, agrupacion) {
  if (!portalContext?.spId) {
    throw new Error('UTE session is missing spId');
  }
  const base = `${BASE}/cmgraficar`;
  const p = encodeURIComponent;
  if (name === 'CURVA_DE_CONSUMO') {
    return `${base}?${p('graficas[0][name]')}=${name}` +
      `&${p('graficas[0][parms][psId]')}=${portalContext.spId}` +
      `&${p('graficas[0][parms][meterId]')}=` +
      `&${p('graficas[0][parms][fechaInicial]')}=${fechaInicio}` +
      `&${p('graficas[0][parms][fechaFinal]')}=${fechaFin}` +
      `&${p('graficas[0][parms][agrupacion]')}=${agrupacion || 'D'}` +
      `&${p('graficas[0][parms][magnitudes]')}=IMPORT_ACTIVE_ENERGY`;
  }
  // CONSUMO_ACTUAL
  return `${base}?${p('graficas[0][name]')}=${name}` +
    `&${p('graficas[0][parms][psId]')}=${portalContext.spId}` +
    `&${p('graficas[0][parms][fechaInicial]')}=${fechaInicio}` +
    `&${p('graficas[0][parms][fechaFinal]')}=${fechaFin}`;
}

async function fetchJson(p, url, options = {}) {
  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const text = await p.evaluate(async (targetUrl) => {
        const r = await fetch(targetUrl, { credentials: 'include' });
        return r.text();
      }, url);

      const parsed = tryParseJson(text);
      if (parsed) return parsed;
      lastErr = new Error(`UTE devolvió contenido no JSON para ${options.label || 'endpoint'}`);
      console.error(`[UTE Session] JSON parse error: ${options.label || 'endpoint'} devolvió contenido no JSON`);
    } catch (err) {
      lastErr = err;
    }

    if (options.allowGotoFallback) {
      try {
        const text = await fetchTextViaGoto(p, url, options.label || 'endpoint');
        const parsed = tryParseJson(text);
        if (parsed) return parsed;
        lastErr = new Error(`UTE devolvió contenido no JSON para ${options.label || 'endpoint'} (fallback)`);
        console.error(`[UTE Session] JSON parse error: ${options.label || 'endpoint'} devolvió contenido no JSON (fallback)`);
      } catch (err) {
        lastErr = err;
      }
    }

    await p.waitForTimeout(1000 * (attempt + 1));
  }

  if (options.nullOnFailure) return null;
  throw lastErr || new Error(`UTE no devolvió JSON válido para ${options.label || 'endpoint'}`);
}

function exactTechnicalContext(value) {
  const technical = value?.technical || value || {};
  if (!['saId', 'spId', 'meterId', 'badge'].every((key) => Boolean(technical[key]))) return null;
  return Object.freeze({
    saId: technical.saId,
    spId: technical.spId,
    meterId: technical.meterId,
    badge: technical.badge,
  });
}

function parsePeriodPayload(periodoInicio, periodoFin, dailyData, totalsData) {
  const curva = dailyData?.CURVA_DE_CONSUMO?.data;
  const dailyLabels = curva?.labels || [];
  const dailyValues = curva?.datasets?.[0]?.data || [];

  const dias = dailyLabels.map((label, i) => ({
    fecha: label,
    kwh:   Math.round((dailyValues[i] || 0) * 100) / 100
  }));

  const ca = totalsData?.CONSUMO_ACTUAL;
  const consumoTotal = ca?.consumoActual?.data?.datasets?.[0]?.data?.[0] || 0;
  const tramoBands   = ca?.consumoActualTramoHorario?.data?.datasets || [];
  const tramo = {};
  for (const ds of tramoBands) {
    tramo[ds.label.toLowerCase()] = Math.round((ds.data?.[0] || 0) * 100) / 100;
  }

  return {
    periodo_inicio: periodoInicio,
    periodo_fin:    periodoFin,
    consumo_kwh:    Math.round(consumoTotal * 100) / 100,
    punta_kwh:      tramo.punta || 0,
    valle_kwh:      tramo.valle || 0,
    llano_kwh:      tramo.llano || 0,
    dias
  };
}

async function close() {
  if (browser) {
    await browser.close().catch(() => {});
    browser = null;
    page    = null;
    loggedIn = false;
    portalContext = null;
  }
}

module.exports = { fetchCurrentPeriod, fetchPeriodDetail, close };
