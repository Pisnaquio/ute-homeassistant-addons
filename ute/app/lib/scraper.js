/**
 * UTE Scraper - autoservicio.ute.com.uy
 *
 * Login: https://autoservicio.ute.com.uy/SelfService/SSvcController/login
 *        Campos: input[name="userId"]  /  input[name="password"]
 *
 * Los identificadores del servicio (saId, spId, meterId, badge) se descubren
 * en runtime desde la sesión autenticada para evitar hardcodear datos del
 * usuario dueño del addon.
 */

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs-extra');
const { getChromiumLaunchOptions } = require('./runtime_env');
const { discoverPortalContext, discoverPortfolio } = require('./portal_context');

const BASE = 'https://autoservicio.ute.com.uy/SelfService/SSvcController';

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

function isAuthenticationPage(url) {
  const normalized = String(url || '').toLowerCase();
  return normalized.includes('/login') || normalized.includes('/account/login');
}

function safePortalUrl(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return 'URL no disponible';
  }
}

class UTEScraper {
  constructor(userId, password, debug = false, supplyContext = null) {
    this.userId   = userId;
    this.password = password;
    this.debug    = debug;
    this.browser  = null;
    this.page     = null;
    this.portalContext = null;
    this.portfolio = null;
    this.requestedSupplyContext = supplyContext?.technical || supplyContext || null;
  }

  log(msg) {
    if (this.debug) console.log(`[SCRAPER] ${msg}`);
  }

  // ── Inicializar Playwright ────────────────────────────────────────────────
  async initialize() {
    this.log('Inicializando navegador...');
    this.browser = await chromium.launch(getChromiumLaunchOptions());
    this.page    = await this.browser.newPage();
    this.log('Navegador iniciado correctamente');
  }

  // ── Login en autoservicio ─────────────────────────────────────────────────
  async login() {
    console.log('📝 Iniciando sesión en autoservicio.ute.com.uy...');
    await this.page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await this.page.waitForTimeout(1000);

    await this.page.fill('input[name="userId"]',   this.userId);
    await this.page.fill('input[name="password"]', this.password);
    await this.page.keyboard.press('Enter');
    await this.page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
    await this.page.waitForTimeout(4000);

    let url = this.page.url();
    if (isAuthenticationPage(url) && !url.includes('navigateSelectUserType')) {
      await this.page.goto(`${BASE}/account`, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
      await this.page.waitForTimeout(2500);
      url = this.page.url();
    }
    const loggedInContent = await hasLoggedInContent(this.page);
    if (isAuthenticationPage(url) && !loggedInContent) {
      throw new Error('Login no confirmado — verificar usuario/número de cuenta y contraseña en el portal UTE');
    }
    console.log('✅ Sesión iniciada');
    this.log(`Ruta post-login: ${safePortalUrl(url)}`);

    if (this.hasCompleteRequestedSupplyContext()) {
      this.portalContext = Object.freeze({ ...this.requestedSupplyContext });
      return;
    }

    if (url.includes('/navigateSelectUserType')) {
      this.portfolio = await discoverPortfolio(this.page);
      const supplies = this.portfolio.accounts.flatMap((account) => account.supplies || []);
      if (supplies.length !== 1) {
        const error = new Error('UTE requiere seleccionar explícitamente un suministro antes de sincronizar');
        error.code = 'SUPPLY_SELECTION_REQUIRED';
        error.portfolio = this.portfolio;
        throw error;
      }
      this.portalContext = supplies[0].technical;
      return;
    }

    this.portalContext = await discoverPortalContext(this.page, { logger: msg => this.log(msg) });
    if (!this.portalContext.meterId || !this.portalContext.badge) {
      throw new Error('No se pudieron descubrir meterId/badge desde el portal UTE');
    }
  }

  // ── Descargar lecturas kWh para un tipo de energía ────────────────────────
  async fetchEnergyReadings(tou) {
    const label = { PUNTA: 'Punta', VALLE: 'Valle', LLANO: 'Llano' }[tou] || tou;
    const { meterId, badge } = this.portalContext || {};
    if (!meterId || !badge) {
      throw new Error('Faltan meterId/badge para descargar el historial de consumo');
    }
    const url = `${BASE}/cmVerConsumo?meterId=${meterId}&tou=${tou}&uom=KWH&badge=${badge}&energia=Energía ${label} kWh`;
    this.log(`Navegando a historial ${tou}`);

    await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await this.page.waitForTimeout(2000);

    // Extraer tabla: Fecha | Lectura | Coeficiente Reactiva | Consumo
    const rows = await this.page.$$eval('table tr', trs =>
      trs.map(tr => {
        const cells = Array.from(tr.querySelectorAll('td, th')).map(c => c.innerText?.trim());
        return cells;
      }).filter(c => c.length >= 4 && /\d{2}-\d{2}-\d{4}/.test(c[0]))
    );

    // rows[i] = [ "27-03-2026", "16.598", "Regular", "166.000000" ]
    return rows.map(r => ({
      fecha:   r[0],
      consumo: parseFloat(r[3]) || 0
    }));
  }

  hasCompleteRequestedSupplyContext() {
    return ['saId', 'spId', 'meterId', 'badge'].every((key) => Boolean(this.requestedSupplyContext?.[key]));
  }

  // ── Descargar historial completo de facturas ──────────────────────────────
  async fetchBillingHistory() {
    this.log('Navegando a historial de facturas...');
    await this.page.goto(`${BASE}/CMBillingHistory`, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await this.page.waitForTimeout(2000);

    // Seleccionar "Historial completo"
    await this.page.selectOption('select#getAll', 'true').catch(() => {});
    await this.page.click('button#btnBuscar').catch(() => {});
    await this.page.waitForTimeout(3000);

    // Parsear texto de la página buscando el patrón: Emisión DD-MM-YYYY / Importe $ X.XXX
    const pageText = await this.page.evaluate(() => document.body.innerText);

    // Extraer líneas de facturas: "DD-MM-YYYY\t DD-MM-YYYY\t $ 0\t $ 6.562\t $ 6.562"
    // Pattern: Emisión(dd-mm-yyyy) Vencimiento(dd-mm-yyyy) DeudaAnt Importe ImporteTotal
    const billRegex = /(\d{2}-\d{2}-\d{4})\t(\d{2}-\d{2}-\d{4})\t\$ [\d.]+\t\$ ([\d.,]+)\t\$ ([\d.,]+)/g;
    const bills = [];
    let match;
    while ((match = billRegex.exec(pageText)) !== null) {
      const [, emision, vencimiento, importe, importeTotal] = match;
      const costo = parseFloat(importeTotal.replace(/\./g, '').replace(',', '.')) ||
                    parseFloat(importe.replace(/\./g, '').replace(',', '.'));
      if (costo > 0) {
        bills.push({ emision, vencimiento, costo_uyu: costo });
      }
    }

    // Fallback: extraer de la tabla HTML
    if (bills.length === 0) {
      const tableBills = await this.page.$$eval('table tr', trs => {
        const results = [];
        for (const tr of trs) {
          const cells = Array.from(tr.querySelectorAll('td, th')).map(c => c.innerText?.trim());
          // Buscar filas con fechas de emisión y vencimiento
          if (cells.length >= 6 && /\d{2}-\d{2}-\d{4}/.test(cells[0]) && /\d{2}-\d{2}-\d{4}/.test(cells[1])) {
            results.push({ emision: cells[0], vencimiento: cells[1], costo_str: cells[5] || cells[4] });
          }
        }
        return results;
      });

      for (const b of tableBills) {
        const costo = parseFloat((b.costo_str || '0').replace(/[$ .]/g, '').replace(',', '.'));
        if (costo > 0) {
          bills.push({ emision: b.emision, vencimiento: b.vencimiento, costo_uyu: costo });
        }
      }
    }

    this.log(`Facturas encontradas: ${bills.length}`);
    return bills;
  }

  // ── Combinar kWh + costos por mes ─────────────────────────────────────────
  combineData(punta, valle, llano, bills) {
    // Crear mapa de kWh por fecha de lectura (dd-mm-yyyy → kWh total)
    const kwhByDate = new Map();
    const allDates = new Set([
      ...punta.map(r => r.fecha),
      ...valle.map(r => r.fecha),
      ...llano.map(r => r.fecha)
    ]);

    for (const fecha of allDates) {
      const p = punta.find(r => r.fecha === fecha)?.consumo || 0;
      const v = valle.find(r => r.fecha === fecha)?.consumo || 0;
      const l = llano.find(r => r.fecha === fecha)?.consumo || 0;
      kwhByDate.set(fecha, { total: p + v + l, punta: p, valle: v, llano: l });
    }

    // Crear mapa de costo por fecha de emisión (dd-mm-yyyy → costo)
    // La fecha de emisión coincide aproximadamente con la fecha de lectura
    const costByEmision = new Map();
    for (const b of bills) {
      costByEmision.set(b.emision, b.costo_uyu);
    }

    const result = [];
    for (const [fechaStr, kwhObj] of kwhByDate) {
      const [dd, mm, yyyy] = fechaStr.split('-').map(Number);
      const mes = mm;
      const año = yyyy;

      // Buscar factura con emisión en el mismo mes/año
      let costo = 0;
      for (const [emision, c] of costByEmision) {
        const [, em, ey] = emision.split('-').map(Number);
        if (em === mm && ey === yyyy) {
          costo = c;
          break;
        }
      }

      result.push({
        mes,
        año,
        fecha: `${yyyy}-${String(mm).padStart(2,'0')}-${String(dd).padStart(2,'0')}`,
        consumo_kwh: kwhObj.total,
        punta_kwh:   kwhObj.punta,
        valle_kwh:   kwhObj.valle,
        llano_kwh:   kwhObj.llano,
        costo_uyu:   costo
      });
    }

    // Ordenar por año y mes
    result.sort((a, b) => (a.año !== b.año ? a.año - b.año : a.mes - b.mes));
    return result;
  }

  // ── Método principal de scraping ──────────────────────────────────────────
  async scrape() {
    await this.initialize();
    await this.login();

    console.log('📡 Descargando historial de consumo kWh...');
    // Sequential — all three use the same page object, concurrent goto() causes ERR_ABORTED
    const punta = await this.fetchEnergyReadings('PUNTA');
    const valle = await this.fetchEnergyReadings('VALLE');
    const llano = await this.fetchEnergyReadings('LLANO');

    console.log(`   Punta: ${punta.length} meses | Valle: ${valle.length} meses | Llano: ${llano.length} meses`);

    console.log('💰 Descargando historial de facturas...');
    const bills = await this.fetchBillingHistory();
    console.log(`   Facturas: ${bills.length}`);

    const data = this.combineData(punta, valle, llano, bills);
    console.log(`✅ Datos combinados: ${data.length} meses`);

    return data;
  }

  // ── Compatible con el flujo de ute_monitor.js ────────────────────────────
  async scrapeWithRetry(maxRetries = 3) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        console.log(`\n📊 Intento ${attempt}/${maxRetries}...`);
        const data = await this.scrape();

        // Convertir al formato esperado por DataProcessor.parseConsumptionData()
        return data.map(d => ({
          month:    `${d.mes}/${d.año}`,
          kwh:      String(d.consumo_kwh),
          cost:     String(d.costo_uyu),
          _parsed:  d          // shortcut: ya está procesado
        }));

      } catch (err) {
        console.error(`⚠️ Error en intento ${attempt}: ${err.message}`);
        await this.close();
        this.browser = null;
        this.page    = null;
        if (attempt === maxRetries) throw err;
        await new Promise(r => setTimeout(r, 3000));
      }
    }
  }

  async close() {
    if (this.browser) {
      await this.browser.close().catch(() => {});
      this.browser = null;
      this.page    = null;
      this.log('Navegador cerrado');
    }
  }
}

module.exports = UTEScraper;
