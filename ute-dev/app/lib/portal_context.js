'use strict';

const DEFAULT_ACCOUNT_LABEL = 'Cuenta personal UTE';
const DEFAULT_LOCATION_LABEL = 'Configuracion pendiente';
const DEFAULT_PLAN_LABEL = 'Tarifa configurable';

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function uniqueMatch(text, patterns) {
  for (const pattern of patterns) {
    const match = String(text || '').match(pattern);
    if (match && match[1]) return match[1];
  }
  return null;
}

function mergeContext(base, extra) {
  return {
    saId: extra.saId || base.saId || null,
    spId: extra.spId || base.spId || null,
    meterId: extra.meterId || base.meterId || null,
    badge: extra.badge || base.badge || null,
    accountNumber: extra.accountNumber || base.accountNumber || null,
    tariffLabel: extra.tariffLabel || base.tariffLabel || null,
    locationLabel: extra.locationLabel || base.locationLabel || null,
  };
}

function extractContextFromText(text) {
  const raw = String(text || '');
  const compact = normalizeText(raw);

  return {
    saId: uniqueMatch(raw, [
      /[?&]saId=(\d{6,})/i,
      /["']saId["']\s*[:=]\s*["']?(\d{6,})/i,
      /\bsaId\b[^0-9]{0,20}(\d{6,})/i,
    ]),
    spId: uniqueMatch(raw, [
      /[?&]spId=(\d{6,})/i,
      /["']spId["']\s*[:=]\s*["']?(\d{6,})/i,
      /\bspId\b[^0-9]{0,20}(\d{6,})/i,
    ]),
    meterId: uniqueMatch(raw, [
      /[?&]meterId=(\d{6,})/i,
      /["']meterId["']\s*[:=]\s*["']?(\d{6,})/i,
      /\bmeterId\b[^0-9]{0,20}(\d{6,})/i,
    ]),
    badge: uniqueMatch(raw, [
      /[?&]badge=(\d{6,})/i,
      /["']badge["']\s*[:=]\s*["']?(\d{6,})/i,
      /\bbadge\b[^0-9]{0,20}(\d{6,})/i,
    ]),
    accountNumber: uniqueMatch(raw, [
      /N[uú]mero de cuenta:\s*(\d{6,})/i,
      /\bcuenta\b[^0-9]{0,10}(\d{6,})/i,
      /\baccount\b[^0-9]{0,10}(\d{6,})/i,
    ]),
    tariffLabel: uniqueMatch(compact, [
      /\b(Tarifa [A-Za-zÁÉÍÓÚáéíóúÑñ ]{3,80})\b/,
      /\b(Residencial Triple)\b/i,
      /\b(TRT Residencial Triple)\b/i,
    ]),
    locationLabel: uniqueMatch(compact, [
      /(?:Cuenta|N[uú]mero de cuenta)[^·\n]*·[^·\n]*·\s*([A-Za-zÁÉÍÓÚáéíóúÑñ ,.-]{3,80})/i,
      /\b([A-ZÁÉÍÓÚÑ][A-Za-zÁÉÍÓÚáéíóúÑñ]+,\s*[A-ZÁÉÍÓÚÑ][A-Za-zÁÉÍÓÚáéíóúÑñ]+)\b/,
    ]),
  };
}

function buildDisplayContext(portalContext = {}) {
  return {
    accountLabel: portalContext.accountNumber
      ? `Cuenta ${portalContext.accountNumber}`
      : DEFAULT_ACCOUNT_LABEL,
    tariffLabel: portalContext.tariffLabel || DEFAULT_PLAN_LABEL,
    locationLabel: portalContext.locationLabel || DEFAULT_LOCATION_LABEL,
  };
}

function getPortalContextFromEnv() {
  return {
    saId: process.env.UTE_SA_ID || null,
    spId: process.env.UTE_SP_ID || null,
    meterId: process.env.UTE_METER_ID || null,
    badge: process.env.UTE_BADGE || null,
    accountNumber: process.env.UTE_ACCOUNT_NUMBER || null,
    tariffLabel: process.env.UTE_TARIFF_LABEL || null,
    locationLabel: process.env.UTE_LOCATION_LABEL || null,
  };
}

async function collectPageSignals(page) {
  const pageUrl = page.url();
  const html = await page.content().catch(() => '');
  const bodyText = await page.locator('body').innerText({ timeout: 5000 }).catch(() => '');
  const hrefs = await page.$$eval('a[href]', anchors =>
    anchors.map(anchor => anchor.getAttribute('href') || '').filter(Boolean)
  ).catch(() => []);

  const combined = [pageUrl, html, bodyText, ...hrefs].join('\n');
  return {
    pageUrl,
    bodyText,
    hrefs,
    combined,
  };
}

async function discoverPortalContext(page, options = {}) {
  const logger = typeof options.logger === 'function' ? options.logger : () => {};
  let context = getPortalContextFromEnv();

  const accountUrl = options.accountUrl || 'https://autoservicio.ute.com.uy/SelfService/SSvcController/account';
  await page.goto(accountUrl, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(1500);

  const firstSignals = await collectPageSignals(page);
  context = mergeContext(context, extractContextFromText(firstSignals.combined));

  if (!context.saId || !context.spId) {
    const curveHref = firstSignals.hrefs.find(href => href.includes('cmvisualizarcurvadecarga'));
    if (curveHref) {
      context = mergeContext(context, extractContextFromText(curveHref));
    }
  }

  if (context.saId && context.spId) {
    const curveUrl =
      `https://autoservicio.ute.com.uy/SelfService/SSvcController/cmvisualizarcurvadecarga?saId=${context.saId}&spId=${context.spId}`;
    await page.goto(curveUrl, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(1500);
    const curveSignals = await collectPageSignals(page);
    context = mergeContext(context, extractContextFromText(curveSignals.combined));
  }

  if (!context.saId || !context.spId) {
    throw new Error('No se pudieron descubrir saId/spId desde el portal UTE');
  }

  logger('[Portal Context] service identifiers discovered');

  return context;
}

module.exports = {
  DEFAULT_ACCOUNT_LABEL,
  DEFAULT_LOCATION_LABEL,
  DEFAULT_PLAN_LABEL,
  buildDisplayContext,
  discoverPortalContext,
  getPortalContextFromEnv,
};
