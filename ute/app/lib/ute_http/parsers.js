'use strict';

function parseNumeric(text) {
  return Number(
    String(text || '0')
      .replace(/\$/g, '')
      .replace(/\./g, '')
      .replace(',', '.')
      .trim()
  ) || 0;
}

function parseDecimal(text) {
  return Number(String(text || '0').replace(/,/g, '.').trim()) || 0;
}

function formatPortalDate(date) {
  return `${String(date.getDate()).padStart(2, '0')}-${String(date.getMonth() + 1).padStart(2, '0')}-${date.getFullYear()}`;
}

function parsePortalDate(text) {
  const parts = String(text || '').split('-').map(Number);
  return new Date(parts[2], (parts[1] || 1) - 1, parts[0] || 1);
}

function shiftMonth(date, delta) {
  return new Date(date.getFullYear(), date.getMonth() + delta, date.getDate());
}

function decodeHtmlText(text) {
  return String(text || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .trim();
}

function stripTags(html) {
  return decodeHtmlText(
    String(html || '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
  );
}

function tryParseJson(text) {
  try {
    return JSON.parse(text);
  } catch (error) {
    return null;
  }
}

function parseConsumptionHistory(html) {
  const rows = [];
  const rowBlocks = String(html || '').match(/<tr\b[\s\S]*?<\/tr>/gi) || [];

  for (const rowHtml of rowBlocks) {
    const cellMatches = [...rowHtml.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)];
    if (cellMatches.length < 4) continue;

    const cells = cellMatches.map((match) => stripTags(match[1]));
    const fecha = cells[0]?.match(/\d{2}-\d{2}-\d{4}/)?.[0];
    const consumo = cells[cells.length - 1];
    if (!fecha) continue;

    rows.push({
      fecha,
      consumo: parseDecimal(consumo),
    });
  }

  if (rows.length === 0) throw new Error('Sin filas en cmVerConsumo');
  return rows;
}

function parseBillingHistory(html) {
  const bills = [];
  const rowBlocks = String(html || '').match(/<tr\b[\s\S]*?<\/tr>/gi) || [];

  for (const rowHtml of rowBlocks) {
    const cellMatches = [...rowHtml.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)];
    if (cellMatches.length < 6) continue;

    const cells = cellMatches.map((match) => stripTags(match[1]));
    const dateCells = cells
      .map((cell) => cell.match(/\d{2}-\d{2}-\d{4}/)?.[0] || null)
      .filter(Boolean);
    if (dateCells.length < 2) continue;

    const moneyCells = cells.filter((cell) => cell.includes('$') || /[\d.]+,\d+|[\d.]+/.test(cell));
    const costoCell = moneyCells[moneyCells.length - 1];
    const costo = parseNumeric(costoCell);
    if (!costo) continue;
    const billId = rowHtml.match(/cmviewbill\?billId=(\d+)/i)?.[1] || null;
    const numero = cells[0] || null;

    bills.push({
      billId,
      numero,
      emision: dateCells[0],
      vencimiento: dateCells[1],
      costo_uyu: costo,
    });
  }

  if (bills.length === 0) throw new Error('Sin filas en historialfacturas');
  return bills;
}

function combineData(punta, valle, llano, bills) {
  const kwhByDate = new Map();
  const allDates = new Set(
    punta.map((row) => row.fecha)
      .concat(valle.map((row) => row.fecha))
      .concat(llano.map((row) => row.fecha))
  );

  allDates.forEach((fecha) => {
    const p = (punta.find((row) => row.fecha === fecha) || {}).consumo || 0;
    const v = (valle.find((row) => row.fecha === fecha) || {}).consumo || 0;
    const l = (llano.find((row) => row.fecha === fecha) || {}).consumo || 0;
    kwhByDate.set(fecha, { total: p + v + l, punta: p, valle: v, llano: l });
  });

  const costByEmision = new Map();
  bills.forEach((bill) => {
    costByEmision.set(bill.emision, bill.costo_uyu);
  });

  const result = [];
  kwhByDate.forEach((kwhObj, fechaStr) => {
    const parts = fechaStr.split('-').map(Number);
    const day = parts[0];
    const month = parts[1];
    const year = parts[2];
    let costo = 0;

    costByEmision.forEach((amount, emision) => {
      const emParts = emision.split('-').map(Number);
      if (emParts[1] === month && emParts[2] === year && !costo) costo = amount;
    });

    result.push({
      mes: month,
      año: year,
      fecha: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
      consumo_kwh: kwhObj.total,
      punta_kwh: kwhObj.punta,
      valle_kwh: kwhObj.valle,
      llano_kwh: kwhObj.llano,
      costo_uyu: costo,
    });
  });

  if (result.length === 0) throw new Error('combineData sin resultados');
  return result.sort((a, b) => new Date(a.fecha) - new Date(b.fecha));
}

function parseDatepickerValue(html, inputId) {
  const regex = new RegExp(`id=["']${escapeRegExp(inputId)}["'][^>]*value=["'](\\d{2}-\\d{2}-\\d{4})["']`, 'i');
  const match = String(html || '').match(regex);
  return match ? match[1] : null;
}

function parsePeriodPayload(periodoInicio, periodoFin, dailyData, totalsData) {
  const curva = (((dailyData || {}).CURVA_DE_CONSUMO || {}).data) || {};
  const dailyLabels = curva.labels || [];
  const dailyValues = ((curva.datasets || [])[0] || {}).data || [];

  if (dailyLabels.length === 0) throw new Error('Curva diaria vacia');

  const dias = dailyLabels.map((label, index) => ({
    fecha: label,
    kwh: Math.round(((dailyValues[index] || 0) * 100)) / 100,
  }));

  const consumoActual = (totalsData || {}).CONSUMO_ACTUAL || {};
  const total = (((((consumoActual.consumoActual || {}).data || {}).datasets || [])[0] || {}).data || [])[0] || 0;
  const tramoDatasets = ((((consumoActual.consumoActualTramoHorario || {}).data || {}).datasets) || []);
  const tramoMap = {};

  tramoDatasets.forEach((dataset) => {
    tramoMap[String(dataset.label || '').toLowerCase()] = Math.round((((dataset.data || [])[0] || 0) * 100)) / 100;
  });

  return {
    periodo_inicio: periodoInicio,
    periodo_fin: periodoFin,
    consumo_kwh: Math.round(total * 100) / 100,
    punta_kwh: tramoMap.punta || 0,
    valle_kwh: tramoMap.valle || 0,
    llano_kwh: tramoMap.llano || 0,
    dias,
  };
}

function extractAccountIdentifiers(html) {
  const text = String(html || '');
  const decoded = decodeHtmlText(text);
  const stripped = stripTags(text);
  const candidates = {
    saId: findCandidate(text, [
      /saId[=:"'\s]+(\d{6,})/i,
      /acuerdo(?:s)?\s+de\s+servicio[^0-9]*(\d{6,})/i,
    ]),
    spId: findCandidate(text, [
      /spId[=:"'\s]+(\d{6,})/i,
      /psId[=:"'\s]+(\d{6,})/i,
      /service\s*point[^0-9]*(\d{6,})/i,
    ]),
    meterId: findCandidate(text, [
      /meterId[=:"'\s]+(\d{6,})/i,
    ]),
    badge: findCandidate(text, [
      /badge[=:"'\s]+(\d{6,})/i,
      /medidor[^0-9]*(\d{10,})/i,
    ]),
    accountNumber: findCandidate(`${text}\n${decoded}\n${stripped}`, [
      /n(?:u|ú|&uacute;)mero\s+de\s+cuenta[^0-9]*(\d{6,})/i,
      /n[úu]mero\s+de\s+cuenta[^0-9]*(\d{6,})/i,
      /cuenta[^0-9]*(\d{6,})/i,
    ]),
  };

  const allIds = [];
  for (const match of text.matchAll(/\b\d{6,20}\b/g)) {
    allIds.push(match[0]);
  }

  return {
    ...candidates,
    rawNumericIds: [...new Set(allIds)],
  };
}

function escapeRegExp(text) {
  return String(text || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function findCandidate(text, patterns) {
  for (const pattern of patterns) {
    const match = String(text || '').match(pattern);
    if (match && match[1]) return match[1];
  }
  return null;
}

module.exports = {
  combineData,
  extractAccountIdentifiers,
  formatPortalDate,
  parseBillingHistory,
  parseConsumptionHistory,
  parseDatepickerValue,
  parseDecimal,
  parseNumeric,
  parsePeriodPayload,
  parsePortalDate,
  shiftMonth,
  stripTags,
  tryParseJson,
};
