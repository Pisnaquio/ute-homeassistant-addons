'use strict';

const { getUruguayHolidaySet } = require('./uruguay_holidays');

const TARIFA = {
  R_PH: 12.034,
  R_PNH: 5.172,
  R_V: 2.443,
  R_L: 5.172,
  POTENCIA: 416,
  CARGO_FIJO: 488,
  ALUMBRADO: 326.22
};

function parsePortalDate(text) {
  const [day, month, year] = String(text || '').split('-').map(Number);
  return new Date(year, (month || 1) - 1, day || 1);
}

function formatPortalDate(date) {
  return String(date.getDate()).padStart(2, '0') + '-' +
    String(date.getMonth() + 1).padStart(2, '0') + '-' +
    date.getFullYear();
}

function normalizeHolidaySet(holidays = [], options = {}) {
  const set = options.includeDefaultHolidays === false
    ? new Set()
    : getUruguayHolidaySet();
  for (const holiday of holidays || []) set.add(String(holiday));
  return set;
}

function countBillingDays(periodoInicio, periodoFin, options = {}) {
  const start = parsePortalDate(periodoInicio);
  const end = parsePortalDate(periodoFin);
  const holidaySet = normalizeHolidaySet(options.holidays, options);
  const totDays = Math.max(0, Math.round((end - start) / 86400000));

  let habCount = 0;
  let noHabCount = 0;

  for (let dt = new Date(start); dt < end; dt.setDate(dt.getDate() + 1)) {
    const dow = dt.getDay();
    const isWeekend = dow === 0 || dow === 6;
    const isHoliday = holidaySet.has(formatPortalDate(dt));
    if (isWeekend || isHoliday) noHabCount += 1;
    else habCount += 1;
  }

  return { totDays, habCount, noHabCount };
}

function calcFacturaFromSplit(pHab, pNoHab, vKwh, lKwh, counts = {}) {
  const ePH = pHab * TARIFA.R_PH;
  const ePNH = pNoHab * TARIFA.R_PNH;
  const eV = vKwh * TARIFA.R_V;
  const eL = lKwh * TARIFA.R_L;
  const eTotal = ePH + ePNH + eV + eL;
  const gravable = eTotal + TARIFA.POTENCIA;
  const iva = gravable * 0.22;
  const total = gravable + iva + TARIFA.CARGO_FIJO + TARIFA.ALUMBRADO;

  return {
    ...counts,
    pHab,
    pNoHab,
    ePH,
    ePNH,
    eV,
    eL,
    eTotal,
    gravable,
    iva,
    total
  };
}

function calcFactura(pKwh, vKwh, lKwh, periodoInicio, periodoFin, options = {}) {
  const counts = countBillingDays(periodoInicio, periodoFin, options);
  const { totDays, habCount, noHabCount } = counts;

  const pHab = totDays > 0 ? pKwh * (habCount / totDays) : 0;
  const pNoHab = totDays > 0 ? pKwh * (noHabCount / totDays) : 0;
  return calcFacturaFromSplit(pHab, pNoHab, vKwh, lKwh, counts);
}

module.exports = {
  TARIFA,
  parsePortalDate,
  formatPortalDate,
  countBillingDays,
  calcFactura,
  calcFacturaFromSplit
};
