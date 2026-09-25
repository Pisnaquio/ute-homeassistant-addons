'use strict';

const fs = require('fs-extra');
const path = require('path');

function parsePortalMonth(text) {
  const match = String(text || '').match(/^\d{2}-(\d{2})-(\d{4})$/);
  if (!match) return null;
  const month = Number(match[1]);
  const year = Number(match[2]);
  if (!Number.isInteger(month) || month < 1 || month > 12 || !Number.isInteger(year)) return null;
  return { year, month, key: year * 12 + month };
}

function recordMonth(record) {
  const year = Number(record?.año);
  const month = Number(record?.mes);
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) return null;
  return { year, month, key: year * 12 + month };
}

function findExpectedClosedRecord(historical, current) {
  const expected = parsePortalMonth(current?.periodo_inicio);
  if (!expected) return { expected: null, record: null };
  const record = (Array.isArray(historical) ? historical : [])
    .find((entry) => recordMonth(entry)?.key === expected.key) || null;
  return { expected, record };
}

function hasPublishedBill(record) {
  const amount = Number(record?.costo_uyu);
  return Number.isFinite(amount) && amount > 0;
}

function evaluateAutoHistoryRefresh(options = {}) {
  const {
    historical = [],
    current = null,
    state = null,
    supplyKey = null,
    nowMs = Date.now(),
    retryMs = 24 * 60 * 60 * 1000,
  } = options;

  const { expected, record } = findExpectedClosedRecord(historical, current);
  if (!expected) return { shouldRefresh: false, reason: 'current_period_unavailable' };
  if (record && hasPublishedBill(record)) {
    return { shouldRefresh: false, reason: 'invoice_current', expectedYear: expected.year, expectedMonth: expected.month };
  }

  const sameSupply = !state?.supplyKey || state.supplyKey === supplyKey;
  const lastAttemptMs = sameSupply ? Date.parse(state?.lastAttemptAt || '') : NaN;
  if (Number.isFinite(lastAttemptMs) && nowMs - lastAttemptMs < retryMs) {
    return {
      shouldRefresh: false,
      reason: 'retry_throttled',
      expectedYear: expected.year,
      expectedMonth: expected.month,
      retryAt: new Date(lastAttemptMs + retryMs).toISOString(),
    };
  }

  return {
    shouldRefresh: true,
    reason: record ? 'invoice_missing' : 'closed_period_missing',
    expectedYear: expected.year,
    expectedMonth: expected.month,
  };
}

function readAutoHistoryState(filePath) {
  try {
    return fs.readJsonSync(filePath);
  } catch {
    return null;
  }
}

function writeAutoHistoryState(filePath, value) {
  fs.ensureDirSync(path.dirname(filePath));
  const tempPath = `${filePath}.tmp`;
  fs.writeJsonSync(tempPath, value, { spaces: 2 });
  fs.renameSync(tempPath, filePath);
}

module.exports = {
  evaluateAutoHistoryRefresh,
  findExpectedClosedRecord,
  hasPublishedBill,
  parsePortalMonth,
  readAutoHistoryState,
  writeAutoHistoryState,
};
