'use strict';

const fs = require('fs-extra');
const path = require('path');

const DETAILS_DIRNAME = 'periodos_detalle';

function parsePortalDate(text) {
  const [d, m, y] = String(text || '').split('-').map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}

function isLikelyClosedBillingPeriod(periodoInicio, periodoFin) {
  if (!periodoInicio || !periodoFin) return false;
  const start = parsePortalDate(periodoInicio);
  const end = parsePortalDate(periodoFin);
  const days = Math.round((end - start) / 86400000) + 1;
  return start.getDate() === 27 && (end.getDate() === 26 || end.getDate() === 27) && days >= 28 && days <= 32;
}

function getDetailsDir(baseDir) {
  return path.join(baseDir, DETAILS_DIRNAME);
}

function buildPeriodFileName(periodoInicio, periodoFin) {
  const end = parsePortalDate(periodoFin);
  const year = end.getFullYear();
  const month = String(end.getMonth() + 1).padStart(2, '0');
  return `${year}-${month}.json`;
}

function getPeriodFilePath(baseDir, periodoInicio, periodoFin) {
  return path.join(getDetailsDir(baseDir), buildPeriodFileName(periodoInicio, periodoFin));
}

function isUsablePeriodDetail(detail) {
  if (!detail || !detail.periodo_inicio || !detail.periodo_fin) return false;
  if (!Array.isArray(detail.dias) || detail.dias.length === 0) return false;
  if (!(detail.consumo_kwh > 0)) return false;
  const totalDaily = detail.dias.reduce((sum, day) => sum + Number(day.kwh || 0), 0);
  return totalDaily > 0;
}

function loadPeriodDetail(baseDir, periodoInicio, periodoFin) {
  const filePath = getPeriodFilePath(baseDir, periodoInicio, periodoFin);
  if (!fs.existsSync(filePath)) return null;
  try {
    const parsed = fs.readJsonSync(filePath);
    if (!isUsablePeriodDetail(parsed)) return null;
    return { ...parsed, _source: 'local-cache' };
  } catch (error) {
    return null;
  }
}

function savePeriodDetail(baseDir, detail, meta = {}) {
  if (!detail || !detail.periodo_inicio || !detail.periodo_fin) return null;
  if (!isLikelyClosedBillingPeriod(detail.periodo_inicio, detail.periodo_fin)) return null;

  const dir = getDetailsDir(baseDir);
  fs.ensureDirSync(dir);

  const filePath = getPeriodFilePath(baseDir, detail.periodo_inicio, detail.periodo_fin);
  const payload = {
    ...detail,
    stored_at: meta.storedAt || new Date().toISOString()
  };

  fs.writeJsonSync(filePath, payload, { spaces: 2 });
  return filePath;
}

module.exports = {
  DETAILS_DIRNAME,
  getDetailsDir,
  loadPeriodDetail,
  savePeriodDetail,
  isLikelyClosedBillingPeriod,
  isUsablePeriodDetail
};
