#!/usr/bin/env node
'use strict';

const express = require('express');
const fs      = require('fs-extra');
const path    = require('path');
const { loadPeriodDetail, savePeriodDetail } = require('./lib/period_detail_store');
const { URUGUAY_HOLIDAYS } = require('./lib/uruguay_holidays');
const { ensureRuntimeDirs, runtimePaths } = require('./lib/runtime_env');
const { buildDisplayContext } = require('./lib/portal_context');
const { SyncManager } = require('./lib/sync_manager');
const { logEvent, redact } = require('./lib/safe_log');
const { RuntimeStorage } = require('./lib/runtime_storage');
const { createUteDataSource } = require('./lib/ute_data_source');

const app  = express();
const PORT = process.env.PORT || 3000;
const DISPLAY_CONTEXT = buildDisplayContext();
app.use(express.json());
ensureRuntimeDirs();
const runtimeStorage = new RuntimeStorage(runtimePaths);
runtimeStorage.ensureSingleSupplyMigration();
app.use('/assets', express.static(path.join(__dirname, 'assets')));
app.use('/sample-data', express.static(path.join(__dirname, 'sample-data')));

// ── Data helpers ─────────────────────────────────────────────────────────────
const SYNC_STATE_PATH = path.join(runtimePaths.tempDir, 'sync-status.json');
const PERIOD_DETAIL_CACHE = new Map();
const DEMO_DATA_DIR = path.join(__dirname, 'sample-data');
const EXPORT_ALLOWLIST = Object.freeze({
  'consumo_ute_2024.xlsx': 'consumo_ute_2024.xlsx',
  'consumo_ute_2025.xlsx': 'consumo_ute_2025.xlsx',
  'consumo_ute_2026.xlsx': 'consumo_ute_2026.xlsx',
});
const SAFE_EXPORT_FILE_RE = /^[A-Za-z0-9._-]+$/;

function activeDataDir() {
  const portfolio = runtimeStorage.getPortfolio();
  if (!portfolio || portfolio.source === 'legacy-single-supply') return runtimePaths.dataDir;
  const supplyKey = runtimeStorage.loadSelectedSupplyKey();
  const active = supplyKey ? runtimeStorage.getActiveContext(supplyKey) : null;
  return active ? runtimeStorage.getSupplyDataPath(active.supplyKey) : null;
}
function consumoPath() { const root = activeDataDir(); return root ? path.join(root, 'consumo.json') : null; }
function periodoPath() { const root = activeDataDir(); return root ? path.join(root, 'periodo_actual.json') : null; }
function periodDetailsDir() { const root = activeDataDir(); return root ? path.join(root, 'periodos_detalle') : null; }

function normalizeExportFileName(rawName) {
  if (typeof rawName !== 'string' || !rawName.length) return null;

  const raw = rawName.trim();
  if (raw !== rawName || raw.includes('\u0000')) return null;
  if (raw.includes('/') || raw.includes('\\') || raw.includes('..')) return null;
  if (!SAFE_EXPORT_FILE_RE.test(raw)) return null;

  let decoded = raw;
  for (let index = 0; index < 3; index += 1) {
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    } catch (error) {
      return null;
    }
  }

  if (decoded.includes('/') || decoded.includes('\\') || decoded.includes('..') || decoded.includes('\u0000')) {
    return null;
  }
  if (!SAFE_EXPORT_FILE_RE.test(decoded) || path.isAbsolute(decoded)) return null;
  if (path.basename(decoded) !== decoded) return null;
  if (!Object.hasOwn(EXPORT_ALLOWLIST, decoded)) return null;
  return EXPORT_ALLOWLIST[decoded];
}

function resolveSafeExportPath(rawName) {
  const fileName = normalizeExportFileName(rawName);
  if (!fileName) return null;

  const dataRootPath = activeDataDir();
  if (!dataRootPath) return null;
  const candidate = path.join(dataRootPath, fileName);
  if (!fs.existsSync(candidate)) return null;

  try {
    const dataRoot = fs.realpathSync(dataRootPath);
    const realFile = fs.realpathSync(candidate);
    const relative = path.relative(dataRoot, realFile);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null;
    return realFile;
  } catch (error) {
    return null;
  }
}

function hasConfiguredCredentials() {
  return Boolean(process.env.UTE_EMAIL && process.env.UTE_PASSWORD);
}

function hasDemoQuery(req) {
  return req?.query?.demo === '1' || req?.query?.demo === 'true';
}

function parseDemoData(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); }
  catch(error) { return null; }
}

function loadDemoHistorical() {
  return parseDemoData(path.join(DEMO_DATA_DIR, 'consumo.json')) || [];
}

function loadDemoCurrent() {
  return parseDemoData(path.join(DEMO_DATA_DIR, 'periodo_actual.json')) || null;
}

function loadDemoPeriodDetailIndex() {
  try {
    const detailsDir = path.join(DEMO_DATA_DIR, 'periodos_detalle');
    if (!fs.existsSync(detailsDir)) return [];
    return fs.readdirSync(detailsDir)
      .filter(name => /^\d{4}-\d{2}\.json$/.test(name))
      .sort()
      .map((name) => {
        const fullPath = path.join(detailsDir, name);
        const parsed = fs.readJsonSync(fullPath);
        const endDate = parsePortalDateServer(parsed.periodo_fin);
        return {
          key: `hist:${endDate.getFullYear()}-${String(endDate.getMonth() + 1).padStart(2, '0')}`,
          mes: endDate.getMonth() + 1,
          año: endDate.getFullYear(),
          periodo_inicio: parsed.periodo_inicio,
          periodo_fin: parsed.periodo_fin,
          _daily_only: true,
          _source: 'local-cache',
        };
      });
  } catch (error) {
    return [];
  }
}

function loadDemoPeriodDetail(start, end) {
  const startDate = parsePortalDateServer(start);
  if (!startDate || Number.isNaN(startDate.getTime())) return null;
  const candidates = [];
  candidates.push(`${startDate.getFullYear()}-${String(startDate.getMonth() + 1).padStart(2, '0')}`);
  const fallbackStart = new Date(startDate.getFullYear(), startDate.getMonth() + 1, startDate.getDate());
  candidates.push(`${fallbackStart.getFullYear()}-${String(fallbackStart.getMonth() + 1).padStart(2, '0')}`);

  for (const fileKey of candidates) {
    const dataPath = path.join(DEMO_DATA_DIR, 'periodos_detalle', `${fileKey}.json`);
    const raw = parseDemoData(dataPath);
    if (!raw) continue;
    if (raw.periodo_inicio === start && raw.periodo_fin === end) return { ...raw, _source: 'local-cache' };
  }

  const detailsDir = path.join(DEMO_DATA_DIR, 'periodos_detalle');
  try {
    const files = fs.readdirSync(detailsDir).filter((name) => /^\d{4}-\d{2}\.json$/.test(name));
    for (const name of files) {
      const raw = parseDemoData(path.join(detailsDir, name));
      if (raw && raw.periodo_inicio === start && raw.periodo_fin === end) return { ...raw, _source: 'local-cache' };
    }
  } catch (error) {
    return null;
  }

  return null;
}

function missingCredentialsPayload() {
  return {
    error: 'missing_credentials',
    login_required: true,
    message: 'Login requerido',
    detail: 'Configurá Usuario UTE / número de cuenta y contraseña en las opciones del add-on.'
  };
}

function requireConfiguredCredentials(req, res) {
  if (hasDemoQuery(req) || hasConfiguredCredentials()) return true;
  res.status(428).json(missingCredentialsPayload());
  return false;
}

function requireSelectedSupplyForMutation(res) {
  const portfolio = runtimeStorage.getPortfolio();
  const supplies = (portfolio?.accounts || []).flatMap((account) => account.supplies || []);
  const health = runtimeStorage.getPortfolioHealth(portfolio);
  if (portfolio && portfolioHealthBlocksOperations(portfolio, health)) {
    res.status(409).json({ error: 'PORTFOLIO_REFRESH_REQUIRED', message: 'UTE debe redescubrir el suministro antes de sincronizar.' });
    return false;
  }
  const selected = runtimeStorage.loadSelectedSupplyKey() || runtimeStorage.getOrCreateSelectedSupply(portfolio);
  if (portfolio?.source !== 'legacy-single-supply' && supplies.length && (!selected || !runtimeStorage.supplyExists(selected))) {
    res.status(409).json({ error: 'SUPPLY_SELECTION_REQUIRED', message: 'Seleccioná un suministro antes de sincronizar.' });
    return false;
  }
  if (portfolio?.source !== 'legacy-single-supply' && selected && !runtimeStorage.isSupplySyncReady(selected)) {
    res.status(409).json({ error: 'MULTI_ACCOUNT_CONTEXT_INCOMPLETE', message: 'El suministro seleccionado todavía no tiene el contexto técnico completo para sincronizar.' });
    return false;
  }
  return true;
}

function portfolioHealthBlocksOperations(portfolio, health = runtimeStorage.getPortfolioHealth(portfolio)) {
  return Boolean(health.unsafe || (portfolio?.source !== 'legacy-single-supply' && health.contextIncomplete));
}

function requireReadableSupplyContext(res) {
  const portfolio = runtimeStorage.getPortfolio();
  if (!portfolio || portfolio.source === 'legacy-single-supply') return true;
  const health = runtimeStorage.getPortfolioHealth(portfolio);
  const selected = runtimeStorage.loadSelectedSupplyKey();
  const active = selected ? runtimeStorage.getActiveContext(selected) : null;
  if (health.unsafe || health.contextIncomplete || !active || !runtimeStorage.isSupplySyncReady(active.supplyKey)) {
    res.status(409).json({ error: 'SUPPLY_CONTEXT_UNAVAILABLE', message: 'No hay un suministro válido seleccionado para leer los datos.' });
    return false;
  }
  return true;
}

function loadHistorical() {
  const filePath = consumoPath();
  if (!filePath) return [];
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); }
  catch(e) { return []; }
}

function loadPeriodoActual() {
  const filePath = periodoPath();
  if (!filePath) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch(e) {
    return null;
  }
}

function loadPeriodDetailIndex() {
  try {
    const detailsDir = periodDetailsDir();
    if (!detailsDir || !fs.existsSync(detailsDir)) return [];
    const files = fs.readdirSync(detailsDir)
      .filter(name => /^\d{4}-\d{2}\.json$/.test(name))
      .sort();

    return files.map(name => {
      const fullPath = path.join(detailsDir, name);
      const parsed = fs.readJsonSync(fullPath);
      const endDate = parsePortalDateServer(parsed.periodo_fin);
      return {
        key: `hist:${endDate.getFullYear()}-${String(endDate.getMonth() + 1).padStart(2, '0')}`,
        mes: endDate.getMonth() + 1,
        año: endDate.getFullYear(),
        periodo_inicio: parsed.periodo_inicio,
        periodo_fin: parsed.periodo_fin,
        _daily_only: true,
        _source: 'local-cache'
      };
    });
  } catch (error) {
    return [];
  }
}

function parsePortalDateServer(text) {
  const [d, m, y] = String(text || '').split('-').map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}

const syncManager = new SyncManager({ cwd: __dirname, statePath: SYNC_STATE_PATH });
const AUTO_CURRENT_REFRESH_MAX_AGE_MS = 8 * 60 * 60 * 1000;
const AUTO_CURRENT_REFRESH_CHECK_MS = 3 * 60 * 60 * 1000;
let nextAutoRefreshAt = 0;
let portfolioRefreshRunning = false;

function startSync(kind, args) {
  if (portfolioRefreshRunning) return null;
  const storedKey = runtimeStorage.loadSelectedSupplyKey();
  const supplyKey = storedKey && runtimeStorage.getActiveContext(storedKey) ? storedKey : null;
  const env = { ...process.env };
  if (supplyKey) env.UTE_SUPPLY_KEY = supplyKey;
  return syncManager.start(kind, args, env);
}

function clearLocalRuntimeData() {
  const dataRoot = activeDataDir();
  if (!dataRoot) return [];
  const targets = [
    consumoPath(),
    periodoPath(),
    periodDetailsDir(),
    ...Object.values(EXPORT_ALLOWLIST).map(file => path.join(dataRoot, file)),
  ];
  const removed = [];
  for (const target of targets) {
    if (!fs.existsSync(target)) continue;
    fs.removeSync(target);
    removed.push(path.basename(target));
  }
  PERIOD_DETAIL_CACHE.clear();
  return removed;
}

function toClientPortfolio(portfolio) {
  return {
    schemaVersion: portfolio.schemaVersion,
    discoveryRevision: portfolio.discoveryRevision,
    generatedAt: portfolio.generatedAt,
    source: portfolio.source,
    accounts: (portfolio.accounts || []).map((account) => ({
      accountKey: account.accountKey,
      alias: account.alias,
      supplies: (account.supplies || []).map((supply) => ({
        supplyKey: supply.supplyKey,
        alias: supply.alias,
        location: supply.location,
        capabilities: supply.capabilities,
        tariffs: supply.tariffs,
        meters: (supply.meters || []).map((meter) => ({
          meterKey: meter.meterKey,
          label: meter.label,
          type: meter.type,
          status: meter.status,
        })),
      })),
    })),
  };
}

// ── API routes ────────────────────────────────────────────────────────────────
app.get('/api/data', (req, res) => {
  if (!requireConfiguredCredentials(req, res)) return;
  if (hasDemoQuery(req)) {
    res.json(loadDemoHistorical());
    return;
  }
  if (!requireReadableSupplyContext(res)) return;
  res.json(loadHistorical());
});

app.get('/api/config-status', (req, res) => {
  const demo = hasDemoQuery(req);
  const credentialsConfigured = demo || hasConfiguredCredentials();
  res.json({
    credentials_configured: credentialsConfigured,
    login_required: !credentialsConfigured,
    demo,
  });
});

app.get('/api/portfolio', (req, res) => {
  if (hasDemoQuery(req)) return res.json({ schemaVersion: '2.0.0', source: 'demo', accounts: [], selectedSupplyKey: 'k_0000000000000000' });
  const portfolio = runtimeStorage.getPortfolio();
  if (!portfolio) return res.status(404).json({ error: 'portfolio_not_discovered', login_required: !hasConfiguredCredentials() });
  return res.json({ ...toClientPortfolio(portfolio), selectedSupplyKey: runtimeStorage.loadSelectedSupplyKey() });
});

app.get('/api/supplies', (req, res) => {
  if (hasDemoQuery(req)) {
    return res.json({
      supplies: [{
        supplyKey: 'k_0000000000000000',
        accountKey: 'k_0000000000000000',
        accountAlias: 'Cuenta demo',
        alias: 'Suministro sintético',
        location: 'Datos de demostración',
        syncReady: true,
        capabilities: { hasAMI: true, supportsDailyDetail: true, canEstimateTRT: true },
        meters: [],
      }],
      selectedSupplyKey: 'k_0000000000000000',
      selectionRequired: false,
      source: 'demo',
      needsRefresh: false,
      unsafe: false,
      contextIncomplete: false,
    });
  }
  const portfolio = runtimeStorage.getPortfolio();
  if (!portfolio) return res.json({ supplies: [], selectedSupplyKey: null, selectionRequired: false, source: null, needsRefresh: false });
  const health = runtimeStorage.getPortfolioHealth(portfolio);
  const supplies = portfolio.accounts.flatMap((account) => (account.supplies || []).map((supply) => ({
    supplyKey: supply.supplyKey,
    accountKey: account.accountKey,
    accountAlias: account.alias,
    alias: supply.alias,
    location: supply.location,
    syncReady: runtimeStorage.isSupplySyncReady(supply.supplyKey),
    capabilities: supply.capabilities,
    meters: (supply.meters || []).map((meter) => ({
      meterKey: meter.meterKey,
      label: meter.label,
      type: meter.type,
      status: meter.status,
    })),
  })));
  const selectedCandidate = runtimeStorage.loadSelectedSupplyKey();
  const selectedSupplyKey = selectedCandidate && runtimeStorage.supplyExists(selectedCandidate)
    ? selectedCandidate
    : runtimeStorage.getOrCreateSelectedSupply(portfolio);
  return res.json({
    supplies,
    selectedSupplyKey,
    selectionRequired: supplies.length > 1 && (!selectedSupplyKey || !runtimeStorage.supplyExists(selectedSupplyKey) || !runtimeStorage.isSupplySyncReady(selectedSupplyKey)),
    source: portfolio.source,
    discoveryRevision: portfolio.discoveryRevision,
    needsRefresh: health.needsRefresh,
    unsafe: health.unsafe,
    contextIncomplete: portfolio.source === 'legacy-single-supply' ? false : health.contextIncomplete,
  });
});

app.post('/api/supply/select', (req, res) => {
  if (hasDemoQuery(req)) return res.status(404).json({ error: 'not_available_in_demo' });
  if (portfolioRefreshRunning) return res.status(409).json({ error: 'PORTFOLIO_REFRESH_BUSY' });
  const portfolio = runtimeStorage.getPortfolio();
  const health = runtimeStorage.getPortfolioHealth(portfolio);
  if (portfolioHealthBlocksOperations(portfolio, health)) {
    return res.status(409).json({ error: 'PORTFOLIO_REFRESH_REQUIRED', message: 'Redescubrí los suministros antes de seleccionar.' });
  }
  const supplyKey = runtimeStorage.resolveSupplyKey(req.body?.supplyKey);
  if (!supplyKey || !runtimeStorage.supplyExists(supplyKey)) return res.status(400).json({ error: 'invalid_supply_key' });
  if (!runtimeStorage.isSupplySyncReady(supplyKey)) {
    return res.status(409).json({ error: 'MULTI_ACCOUNT_CONTEXT_INCOMPLETE', message: 'Ese suministro todavía no tiene el contexto técnico completo para sincronizar.' });
  }
  try {
    runtimeStorage.setSelectedSupplyKey(supplyKey);
    PERIOD_DETAIL_CACHE.clear();
    return res.json({ ok: true, selectedSupplyKey: supplyKey });
  } catch (error) {
    if (error.code === 'PORTFOLIO_REFRESH_BUSY') return res.status(409).json({ error: error.code });
    throw error;
  }
});

app.post('/api/portfolio/refresh', async (req, res) => {
  if (hasDemoQuery(req)) return res.status(404).json({ error: 'not_available_in_demo' });
  if (!requireConfiguredCredentials(req, res)) return;
  if (syncManager.isRunning() || portfolioRefreshRunning) {
    return res.status(409).json({ error: 'PORTFOLIO_REFRESH_BUSY', message: 'Esperá a que termine la operación en curso.' });
  }
  portfolioRefreshRunning = true;
  const source = createUteDataSource({ userId: process.env.UTE_EMAIL, password: process.env.UTE_PASSWORD, mode: process.env.UTE_SOURCE || 'auto' });
  try {
    const portfolio = await source.discoverPortfolio();
    const stored = runtimeStorage.saveDiscoveredPortfolio(portfolio);
    PERIOD_DETAIL_CACHE.clear();
    return res.json({ ok: true, portfolio: toClientPortfolio(stored), selectedSupplyKey: runtimeStorage.loadSelectedSupplyKey() });
  } catch (error) {
    const conflict = ['SUPPLY_SELECTION_REQUIRED', 'PORTFOLIO_REFRESH_BUSY'].includes(error.code);
    return res.status(conflict ? 409 : 502).json({
      error: error.code || 'portfolio_discovery_failed',
      message: redact(error.message),
    });
  } finally {
    await source.close().catch(() => {});
    portfolioRefreshRunning = false;
  }
});

app.delete('/api/supply/:supplyKey', (req, res) => {
  if (hasDemoQuery(req)) return res.status(404).json({ error: 'not_available_in_demo' });
  if (portfolioRefreshRunning) return res.status(409).json({ error: 'PORTFOLIO_REFRESH_BUSY' });
  const supplyKey = runtimeStorage.resolveSupplyKey(req.params.supplyKey);
  if (!supplyKey || !runtimeStorage.supplyExists(supplyKey)) return res.status(404).json({ error: 'supply_not_found' });
  try {
    if (!runtimeStorage.removeSupply(supplyKey)) return res.status(404).json({ error: 'supply_not_found' });
    return res.json({ ok: true, selectedSupplyKey: runtimeStorage.loadSelectedSupplyKey() });
  } catch (error) {
    if (error.code === 'PORTFOLIO_REFRESH_BUSY') return res.status(409).json({ error: error.code });
    throw error;
  }
});

app.get('/api/diagnostic/download', (req, res) => {
  if (hasDemoQuery(req)) return res.status(404).json({ error: 'not_available_in_demo' });
  const diagnostic = runtimeStorage.exportDiagnostic(runtimeStorage.loadSelectedSupplyKey());
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('content-disposition', 'attachment; filename="ute-diagnostic.json"');
  return res.send(JSON.stringify(diagnostic, null, 2));
});

app.get('/api/sync-status', (req, res) => {
  if (hasDemoQuery(req)) return res.json({ status: 'idle', id: null, kind: null, stage: null, supplyKey: null, error: null });
  res.json(syncManager.getStatus());
});

// Serves data/periodo_actual.json — written by `node ute_monitor.js current` (or download)
app.get('/api/current', (req, res) => {
  if (!hasDemoQuery(req) && !hasConfiguredCredentials()) {
    return res.status(428).json(missingCredentialsPayload());
  }
  if (!hasDemoQuery(req) && !requireReadableSupplyContext(res)) return;

  const data = hasDemoQuery(req) ? loadDemoCurrent() : loadPeriodoActual();
  if (!data) {
    return res.status(503).json({
      error: 'Sin datos de período actual. Ejecutá: node ute_monitor.js current'
    });
  }
  const ageMs  = Date.now() - new Date(data.fetched_at).getTime();
  const ageMin = Math.round(ageMs / 60000);
  res.json({ ...data, age_minutes: ageMin });
});

app.get('/api/period-detail-index', (req, res) => {
  if (!requireConfiguredCredentials(req, res)) return;
  if (hasDemoQuery(req)) {
    res.json(loadDemoPeriodDetailIndex());
    return;
  }
  if (!requireReadableSupplyContext(res)) return;
  res.json(loadPeriodDetailIndex());
});

app.get('/api/period-detail', (req, res) => {
  if (!requireConfiguredCredentials(req, res)) return;
  if (hasDemoQuery(req)) {
    const { start, end } = req.query || {};
    const detail = loadDemoPeriodDetail(start, end);
    if (!detail) {
      return res.status(404).json({
        error: 'Ese período todavía no está guardado localmente (seed demo).',
        detail: 'Probá otro mes o actualizá los datos disponibles.'
      });
    }
    return res.json({
      ...detail,
      _source: 'local-cache',
      _demo: true,
    });
  }
  if (!requireReadableSupplyContext(res)) return;

  const { start, end } = req.query || {};
  const validDate = /^\d{2}-\d{2}-\d{4}$/;
  if (!validDate.test(String(start || '')) || !validDate.test(String(end || ''))) {
    return res.status(400).json({ error: 'Parámetros inválidos. Usá start y end en formato DD-MM-YYYY.' });
  }

  const cacheKey = `${runtimeStorage.loadSelectedSupplyKey() || 'legacy'}|${start}|${end}`;
  if (PERIOD_DETAIL_CACHE.has(cacheKey)) {
    return res.json(PERIOD_DETAIL_CACHE.get(cacheKey));
  }

  const dataRoot = activeDataDir();
  if (!dataRoot) return res.status(409).json({ error: 'SUPPLY_CONTEXT_UNAVAILABLE' });
  const local = loadPeriodDetail(dataRoot, start, end);
  if (local) {
    PERIOD_DETAIL_CACHE.set(cacheKey, local);
    return res.json(local);
  }

  const current = loadPeriodoActual();
  const closedPrev = current?.periodo_cerrado_anterior;
  if (closedPrev && closedPrev.periodo_inicio === start && closedPrev.periodo_fin === end) {
    const stored = {
      ...closedPrev,
      _source: 'current-snapshot'
    };
    savePeriodDetail(dataRoot, closedPrev, { storedAt: current?.fetched_at || new Date().toISOString() });
    PERIOD_DETAIL_CACHE.set(cacheKey, stored);
    return res.json(stored);
  }

  return res.status(404).json({
    error: 'Ese período no está guardado localmente todavía.',
    detail: 'Guardalo con node ute_monitor.js period-detail DD-MM-YYYY DD-MM-YYYY o dejando que current lo congele al cerrar el período.'
  });
});

// Trigger full historical download (also updates periodo_actual.json)
app.post('/api/refresh', (req, res) => {
  if (hasDemoQuery(req)) return res.status(404).json({ error: 'not_available_in_demo' });
  if (!hasConfiguredCredentials()) {
    return res.status(428).json(missingCredentialsPayload());
  }
  if (!requireSelectedSupplyForMutation(res)) return;

  const job = startSync('download', ['download']);
  if (!job) return res.status(409).json({ error: 'Ya hay una sincronización en curso.', job: syncManager.getStatus() });
  return res.status(202).json({ message: 'Descarga completa aceptada.', job });
});

// Trigger lightweight current-period-only refresh (~1 min vs ~5 min for full download)
app.post('/api/refresh-current', (req, res) => {
  if (hasDemoQuery(req)) return res.status(404).json({ error: 'not_available_in_demo' });
  if (!hasConfiguredCredentials()) {
    return res.status(428).json(missingCredentialsPayload());
  }
  if (!requireSelectedSupplyForMutation(res)) return;

  const job = startSync('current', ['current']);
  if (!job) return res.status(409).json({ error: 'Ya hay una sincronización en curso.', job: syncManager.getStatus() });
  return res.status(202).json({ message: 'Actualización de período actual aceptada.', job });
});

app.post('/api/refresh-all', (req, res) => {
  if (hasDemoQuery(req)) return res.status(404).json({ error: 'not_available_in_demo' });
  if (!hasConfiguredCredentials()) return res.status(428).json(missingCredentialsPayload());
  if (portfolioRefreshRunning) return res.status(409).json({ error: 'PORTFOLIO_REFRESH_BUSY' });
  const portfolio = runtimeStorage.getPortfolio();
  const supplies = (portfolio?.accounts || []).flatMap((account) => account.supplies || []);
  if (!supplies.length || portfolio.source === 'legacy-single-supply') return res.status(409).json({ error: 'portfolio_not_discovered' });
  const health = runtimeStorage.getPortfolioHealth(portfolio);
  if (portfolioHealthBlocksOperations(portfolio, health)) {
    return res.status(409).json({ error: 'PORTFOLIO_REFRESH_REQUIRED', message: 'Redescubrí los suministros antes de sincronizar todos.' });
  }
  const env = { ...process.env, UTE_SYNC_ALL: 'true' };
  const job = syncManager.start('sync-all', ['sync-all'], env);
  if (!job) return res.status(409).json({ error: 'Ya hay una sincronización en curso.', job: syncManager.getStatus() });
  return res.status(202).json({ message: 'Sincronización de todos los suministros aceptada.', job, supplyCount: supplies.length });
});

// Operator-only reset used for clean-install acceptance testing. It never
// touches Home Assistant options, therefore UTE credentials remain configured.
app.post('/api/admin/reset-local-data', (req, res) => {
  if (hasDemoQuery(req)) return res.status(404).json({ error: 'not_available_in_demo' });
  if (!requireConfiguredCredentials(req, res)) return;
  if (req.get('X-UTE-Clean-Reset') !== '1' || req.body?.confirm !== 'DELETE_LOCAL_DATA') {
    return res.status(400).json({
      error: 'Confirmación inválida.',
      detail: 'Se requiere X-UTE-Clean-Reset: 1 y {"confirm":"DELETE_LOCAL_DATA"}.',
    });
  }
  if (syncManager.isRunning()) {
    return res.status(409).json({ error: 'No se puede limpiar mientras hay una sincronización en curso.', job: syncManager.getStatus() });
  }
  const removed = clearLocalRuntimeData();
  logEvent('warn', 'runtime.clean_reset', { removed_count: removed.length });
  return res.status(200).json({ ok: true, removed, credentials_preserved: true });
});

app.get('/api/ha/summary', (req, res) => {
  if (!requireConfiguredCredentials(req, res)) return;
  if (!hasDemoQuery(req) && !requireReadableSupplyContext(res)) return;

  const historical = hasDemoQuery(req) ? loadDemoHistorical() : loadHistorical();
  const current = hasDemoQuery(req) ? loadDemoCurrent() : loadPeriodoActual();
  const latest = historical[historical.length - 1] || null;

  res.json({
    generated_at: new Date().toISOString(),
    current_period: current,
    latest_month: latest,
    history_count: historical.length,
  });
});

// ── Excel download ────────────────────────────────────────────────────────────
app.get('/data/:file', (req, res) => {
  if (hasDemoQuery(req)) return res.status(404).send('Not found');
  if (!requireConfiguredCredentials(req, res)) return;
  if (!hasDemoQuery(req) && !requireReadableSupplyContext(res)) return;

  const exportPath = resolveSafeExportPath(req.params.file);
  if (!exportPath) return res.status(404).send('Not found');
  return res.sendFile(exportPath);
});

app.get('/health', (_req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

// ── Background current-period refresh ────────────────────────────────────────
// UTE viene publicando con un atraso visible cercano a 48h, asi que alcanza
// con refrescar el periodo actual unas pocas veces por dia.
setInterval(() => {
  if (!hasConfiguredCredentials()) return;
  if (Date.now() < nextAutoRefreshAt) return;
  const portfolio = runtimeStorage.getPortfolio();
  const health = runtimeStorage.getPortfolioHealth(portfolio);
  if (portfolioRefreshRunning || portfolioHealthBlocksOperations(portfolio, health)) return;
  const supplies = (portfolio?.accounts || []).flatMap((account) => account.supplies || []);
  if (supplies.length > 1 && !runtimeStorage.loadSelectedSupplyKey()) return;
  const selected = runtimeStorage.loadSelectedSupplyKey();
  if (portfolio?.source !== 'legacy-single-supply' && selected && !runtimeStorage.isSupplySyncReady(selected)) return;
  if (syncManager.isRunning()) return;

  const data = loadPeriodoActual();
  const ageMs = data
    ? Date.now() - new Date(data.fetched_at).getTime()
    : Infinity;
  if (ageMs > AUTO_CURRENT_REFRESH_MAX_AGE_MS) {
    logEvent('info', 'sync.auto_requested', { kind: 'current' });
    startSync('current-auto', ['current']);
    nextAutoRefreshAt = Date.now() + AUTO_CURRENT_REFRESH_CHECK_MS + Math.floor(Math.random() * 15 * 60 * 1000);
  }
}, AUTO_CURRENT_REFRESH_CHECK_MS);

function scheduleInitialSync() {
  if (!hasConfiguredCredentials() || syncManager.isRunning() || portfolioRefreshRunning) return;
  const portfolio = runtimeStorage.getPortfolio();
  const health = runtimeStorage.getPortfolioHealth(portfolio);
  if (portfolioHealthBlocksOperations(portfolio, health)) return;
  const supplies = (portfolio?.accounts || []).flatMap((account) => account.supplies || []);
  if (supplies.length > 1 && !runtimeStorage.loadSelectedSupplyKey()) return;
  const hasHistory = loadHistorical().length > 0;
  const hasCurrent = Boolean(loadPeriodoActual());
  if (hasHistory && hasCurrent) return;
  logEvent('info', 'sync.initial_requested', { has_history: hasHistory, has_current: hasCurrent });
  startSync('initial-download', ['download']);
}

// ── SPA ───────────────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.send(buildDashboardHTML(hasDemoQuery(req))));

app.listen(PORT, () => {
  console.log('\n╔════════════════════════════════════════╗');
  console.log('║  ⚡ UTE Monitor Dashboard              ║');
  console.log(`║  🌐 http://localhost:${PORT}              ║`);
  console.log('╚════════════════════════════════════════╝\n');
  setTimeout(scheduleInitialSync, 750);
});

// ═══════════════════════════════════════════════════════════════════════════════
// FRONTEND HTML (SPA)
// ═══════════════════════════════════════════════════════════════════════════════
function buildDashboardHTML(isDemo = false) {
  const demoBadge = isDemo
    ? '<span class="demo-badge" aria-label="Modo demo">DEMO</span>'
    : '';
  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>UTE Monitor</title>
<script src="assets/chart.umd.min.js"></script>
<style>
  :root {
    --blue: #1a56db;
    --blue-light: #e8f0fe;
    --green: #0e9f6e;
    --green-light: #def7ec;
    --orange: #ff5a1f;
    --orange-light: #feecdc;
    --purple: #7e3af2;
    --purple-light: #edebfe;
    --rose: #e11d48;
    --rose-light: #ffe4e6;
    --gray: #6b7280;
    --bg: #f3f4f6;
    --card: #fff;
    --border: #e5e7eb;
    --text: #111827;
    --text-soft: #6b7280;
    --shadow-soft: 0 20px 45px rgba(15, 23, 42, .08);
    --shadow-card: 0 12px 30px rgba(15, 23, 42, .07);
  }
  * { margin:0; padding:0; box-sizing:border-box; }
  :where(*) { min-width: 0; }
  :where(img,video,canvas,svg,iframe) { max-width: 100%; }
  body {
    font-family: 'Avenir Next', 'Segoe UI', sans-serif;
    background:
      radial-gradient(circle at top left, rgba(26,86,219,.12), transparent 26%),
      radial-gradient(circle at top right, rgba(225,29,72,.08), transparent 22%),
      linear-gradient(180deg, #f8fafc 0%, #eef2ff 48%, #f8fafc 100%);
    color: var(--text);
    min-height: 100vh;
  }

  /* ── Header ── */
  header {
    max-width: 1280px;
    margin: 18px auto 0;
    background:
      linear-gradient(135deg, rgba(15,23,42,.94) 0%, rgba(26,86,219,.9) 54%, rgba(126,58,242,.88) 100%);
    color: #fff; padding: 18px 32px;
    display: flex; align-items: center; justify-content: space-between;
    box-shadow: 0 24px 50px rgba(30, 41, 59, .18);
    border-radius: 24px;
    border: 1px solid rgba(255,255,255,.12);
    backdrop-filter: blur(16px);
  }
  .header-left h1 {
    font-family: 'Avenir Next Condensed', 'Avenir Next', 'Segoe UI', sans-serif;
    font-size: 1.5rem;
    font-weight: 800;
    letter-spacing: .01em;
  }
  .header-left span { font-size: .85rem; opacity: .8; display: block; margin-top: 2px; }
  .demo-badge {
    padding: 4px 10px;
    border-radius: 999px;
    border: 1px solid rgba(255,255,255,.35);
    background: rgba(30,41,59,.45);
    font-size: .75rem;
    font-weight: 700;
    letter-spacing: .02em;
    align-self: flex-start;
  }
  .demo-badge-wrap {
    margin-top: 6px;
    display: inline-flex;
    align-items: center;
    gap: 8px;
  }
  .header-right { display: flex; gap: 10px; align-items: center; }
  .btn { padding: 8px 18px; border-radius: 8px; border: none; cursor: pointer;
         font-size: .85rem; font-weight: 700; transition: all .2s; }
  .btn:hover { transform: translateY(-1px); }
  .btn:focus-visible,
  .filter-select:focus-visible,
  .pill:focus-visible,
  .sync-action:focus-visible,
  .sync-summary:focus-visible {
    outline: 2px solid rgba(59,130,246,.85);
    outline-offset: 2px;
  }
  .btn:disabled { opacity: .55; cursor: not-allowed; transform: none; }
  .btn-ghost { background: rgba(255,255,255,.12); color: #fff; border: 1px solid rgba(255,255,255,.12); }
  .btn-ghost:hover { background: rgba(255,255,255,.2); }
  .btn-primary {
    background: linear-gradient(135deg, #fff 0%, #eef4ff 100%);
    color: var(--blue);
    box-shadow: 0 10px 22px rgba(15, 23, 42, .16);
  }
  .btn-primary:hover { background: #f8fbff; }
  #refreshStatus { font-size: .8rem; opacity: .7; }
  .sync-menu { position: relative; }
  .sync-menu[aria-disabled="true"] .sync-summary {
    opacity: .58;
    cursor: not-allowed;
    pointer-events: none;
  }
  .sync-summary {
    list-style: none;
    display: inline-flex;
    align-items: center;
    gap: 8px;
  }
  .sync-summary::-webkit-details-marker { display: none; }
  .sync-popover {
    position: absolute;
    right: 0;
    top: calc(100% + 10px);
    width: 250px;
    padding: 8px;
    border-radius: 14px;
    border: 1px solid rgba(148, 163, 184, .2);
    background: rgba(15, 23, 42, .96);
    box-shadow: 0 20px 45px rgba(15, 23, 42, .2);
    display: grid;
    gap: 6px;
    z-index: 20;
  }
  .sync-action {
    width: 100%;
    border: none;
    border-radius: 10px;
    padding: 10px 12px;
    text-align: left;
    font: inherit;
    cursor: pointer;
    color: #e5eefc;
    background: rgba(255,255,255,.05);
  }
  .sync-action:hover { background: rgba(255,255,255,.12); }
  .sync-action:focus-visible { background: rgba(255,255,255,.18); }
  .sync-action:disabled {
    opacity: .55;
    cursor: not-allowed;
    background: rgba(255,255,255,.04);
  }
  .sync-action strong { display: block; font-size: .92rem; }
  .sync-action span {
    display: block;
    margin-top: 2px;
    font-size: .77rem;
    color: rgba(226, 232, 240, .78);
  }
  .sync-status {
    min-height: 18px;
    margin-bottom: 10px;
    font-size: .8rem;
    color: var(--text-soft);
    min-height: 2.1rem;
  }

  /* ── Layout ── */
  .page { max-width: 1280px; margin: 0 auto; padding: 18px 16px 28px; }

  /* ── Time filter bar ── */
  .filter-bar {
    display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
    background: rgba(255,255,255,.82); padding: 12px 16px; border-radius: 18px;
    border: 1px solid rgba(226,232,240,.92); margin-bottom: 24px;
    box-shadow: var(--shadow-card);
    backdrop-filter: blur(14px);
  }
  .filter-bar label { font-size: .8rem; color: var(--text-soft); font-weight: 600;
                       text-transform: uppercase; letter-spacing: .04em; margin-right: 4px; }
  .filter-pills { display: flex; gap: 6px; flex-wrap: wrap; }
  .pill { padding: 6px 14px; border-radius: 20px; border: 1px solid var(--border);
          background: #fff; cursor: pointer; font-size: .85rem; font-weight: 500;
          color: var(--text-soft); transition: all .15s; font: inherit; appearance: none; }
  .pill:hover { border-color: var(--blue); color: var(--blue); }
  .pill[aria-pressed="false"] { background: #fff; }
  .pill:focus-visible {
    outline: 2px solid rgba(37,99,235,.45);
    outline-offset: 2px;
  }
  .pill.active { background: var(--blue); color: #fff; border-color: var(--blue); }
  .pill[aria-pressed="true"] { background: var(--blue); color: #fff; border-color: var(--blue); }
  .filter-sep { width: 1px; height: 28px; background: var(--border); margin: 0 8px; }
  .filter-select {
    padding: 6px 10px; border-radius: 8px; border: 1px solid var(--border);
    font-size: .85rem; background: #fff; color: var(--text); cursor: pointer;
  }

  /* ── KPI cards ── */
  .kpi-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 16px; margin-bottom: 24px; }
  .kpi-card {
    background:
      linear-gradient(180deg, rgba(255,255,255,.98) 0%, rgba(248,250,252,.98) 100%);
    border-radius: 20px; padding: 20px;
    border: 1px solid rgba(226,232,240,.9); position: relative; overflow: hidden;
    box-shadow: var(--shadow-card);
    backdrop-filter: blur(12px);
    transition: transform .18s ease, box-shadow .18s ease;
  }
  .kpi-card:hover { transform: translateY(-2px); box-shadow: var(--shadow-soft); }
  .kpi-card::before {
    content: ''; position: absolute; top: 0; left: 0; right: 0; height: 4px;
    border-radius: 20px 20px 0 0;
  }
  .kpi-blue::before  { background: var(--blue); }
  .kpi-green::before { background: var(--green); }
  .kpi-orange::before{ background: var(--orange); }
  .kpi-purple::before{ background: var(--purple); }
  .kpi-rose::before  { background: var(--rose); }
  .kpi-icon { font-size: 1.5rem; margin-bottom: 8px; }
  .kpi-label { font-size: .8rem; color: var(--text-soft); font-weight: 500;
               text-transform: uppercase; letter-spacing: .04em; margin-bottom: 6px; }
  .kpi-value { font-size: 1.9rem; font-weight: 700; line-height: 1; }
  .kpi-unit  { font-size: .9rem; color: var(--text-soft); font-weight: 400; margin-left: 4px; }
  .kpi-sub   { font-size: .78rem; color: var(--text-soft); margin-top: 6px; }
  .kpi-badge { display: inline-block; padding: 2px 8px; border-radius: 12px;
               font-size: .75rem; font-weight: 600; margin-top: 6px; }
  .badge-up   { background: #fee2e2; color: #b91c1c; }
  .badge-down { background: #dcfce7; color: #166534; }
  .badge-neutral { background: #f3f4f6; color: #6b7280; }
  .kpi-loading { color: var(--text-soft); font-size: .9rem; }
  .kpi-trendline {
    min-height: 22px;
    display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
    margin-top: 8px;
  }
  .kpi-trendnote { font-size: .72rem; color: var(--text-soft); }
  .kpi-state {
    display: inline-block;
    margin-top: 6px;
    padding: 3px 8px;
    border-radius: 12px;
    font-size: .72rem;
    font-weight: 700;
    color: #1e293b;
    background: #f1f5f9;
  }
  .kpi-state.real { background: #dcfce7; color: #166534; }
  .kpi-state.estimado { background: #ffedd5; color: #9a3412; }
  .kpi-state.proyectado { background: #dbeafe; color: #1e40af; }
  .kpi-shadow-box {
    margin-top: 0;
    padding: 10px 12px;
    border-radius: 12px;
    background: linear-gradient(180deg, rgba(126,58,242,.09) 0%, rgba(59,130,246,.04) 100%);
    border: 1px solid rgba(126,58,242,.14);
  }
  .kpi-shadow-head {
    display: flex; justify-content: space-between; align-items: center; gap: 8px;
    font-size: .72rem; font-weight: 700; text-transform: uppercase;
    letter-spacing: .04em; color: #6d28d9; margin-bottom: 8px;
  }
  .kpi-shadow-ref {
    font-size: .72rem; color: var(--text-soft); font-weight: 600;
    text-transform: none; letter-spacing: 0;
  }
  .kpi-shadow-bars {
    position: relative;
    height: 12px;
    border-radius: 999px;
    background: rgba(107,114,128,.10);
    overflow: hidden;
  }
  .kpi-shadow-prev,
  .kpi-shadow-current {
    position: absolute; left: 0; top: 0; bottom: 0;
    border-radius: 999px;
  }
  .kpi-shadow-prev {
    background: rgba(107,114,128,.28);
    box-shadow: inset 0 0 0 1px rgba(107,114,128,.12);
  }
  .kpi-shadow-current {
    background: linear-gradient(90deg, rgba(126,58,242,.82) 0%, rgba(59,130,246,.82) 100%);
  }
  .kpi-shadow-meta {
    margin-top: 8px;
    display: flex; justify-content: space-between; align-items: center; gap: 10px;
    font-size: .78rem; color: var(--text-soft);
  }
  .kpi-shadow-current-val { color: var(--text); font-weight: 700; }

  /* ── Charts section ── */
  .charts-grid { display: grid; grid-template-columns: 2fr 1fr; gap: 16px; margin-bottom: 24px; }
  @media (max-width: 900px) { .charts-grid { grid-template-columns: 1fr; } }
  .chart-card {
    background: linear-gradient(180deg, rgba(255,255,255,.98) 0%, rgba(248,250,252,.98) 100%);
    border-radius: 20px; padding: 20px;
    border: 1px solid rgba(226,232,240,.9);
    box-shadow: var(--shadow-card);
  }
  .chart-header { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 16px; }
  .chart-title {
    display: inline-block;
    font-family: 'Avenir Next Condensed', 'Avenir Next', 'Segoe UI', sans-serif;
    font-size: 1.05rem;
    font-weight: 800;
    letter-spacing: .01em;
  }
  .chart-subtitle { font-size: .8rem; color: var(--text-soft); margin-top: 2px; }
  .chart-container { position: relative; height: 280px; }

  /* ── Current period card ── */
  .current-card {
    background:
      linear-gradient(180deg, rgba(255,255,255,.98) 0%, rgba(248,250,252,.98) 100%);
    border-radius: 24px; padding: 20px;
    border: 1px solid rgba(226,232,240,.9); margin-bottom: 24px;
    box-shadow: var(--shadow-soft);
  }
  .current-header { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 16px; }
  .current-header-right { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; justify-content: flex-end; }
  .current-period { font-size: .8rem; color: var(--text-soft); margin-top: 2px; }
  .current-select { min-width: 220px; }
  .tramo-grid { display: flex; gap: 12px; margin-bottom: 16px; flex-wrap: wrap; }
  .tramo-badge {
    flex: 1; min-width: 120px; padding: 12px 16px; border-radius: 10px;
    text-align: center;
    box-shadow: inset 0 1px 0 rgba(255,255,255,.65);
  }
  .tramo-punta  { background: #fee2e2; }
  .tramo-llano  { background: #fef9c3; }
  .tramo-valle  { background: #dcfce7; }
  .tramo-label { font-size: .75rem; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; color: var(--text-soft); }
  .tramo-value { font-size: 1.4rem; font-weight: 700; margin-top: 4px; }
  .tramo-punta  .tramo-value { color: #b91c1c; }
  .tramo-llano  .tramo-value { color: #92400e; }
  .tramo-valle  .tramo-value { color: #166534; }
  .tramo-compare {
    margin-top: 7px;
    font-size: .72rem;
    color: rgba(17,24,39,.64);
    line-height: 1.35;
  }
  .chart-daily-container { position: relative; height: 180px; }
  .current-loading { padding: 32px; text-align: center; color: var(--text-soft); }

  /* ── Projection row ── */
  .proj-row {
    display: flex; gap: 10px; flex-wrap: wrap;
    background: linear-gradient(135deg, #f8fafc 0%, #eef2ff 100%);
    border-radius: 14px; padding: 12px 16px;
    margin-bottom: 16px; border: 1px solid var(--border);
  }
  .proj-item { flex: 1; min-width: 110px; text-align: center; }
  .proj-label { display: block; font-size: .72rem; font-weight: 600; text-transform: uppercase;
                letter-spacing: .04em; color: var(--text-soft); margin-bottom: 3px; }
  .proj-value { display: block; font-size: 1.05rem; font-weight: 700; color: var(--text); }
  .proj-value.accent { color: var(--rose); }
  .proj-note { font-size: .75rem; color: var(--text-soft); margin-top: 6px; margin-bottom: 16px; }
  .current-compare {
    background: linear-gradient(135deg, rgba(239,246,255,.9) 0%, rgba(248,250,252,.96) 100%);
    border: 1px solid #dbe7fb;
    border-radius: 16px;
    padding: 14px 16px;
    margin-top: 16px;
  }
  .current-compare-head {
    display: flex; justify-content: space-between; align-items: baseline; gap: 10px; flex-wrap: wrap;
    margin-bottom: 12px;
  }
  .current-compare-title { font-size: .86rem; font-weight: 700; color: var(--text); }
  .current-compare-ref { font-size: .75rem; color: var(--text-soft); }
  .current-compare-grid {
    display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 10px;
  }
  .current-compare-item {
    background: #fff;
    border: 1px solid #e6edf8;
    border-radius: 12px;
    padding: 10px 12px;
    box-shadow: 0 8px 20px rgba(59,130,246,.06);
  }
  .current-compare-label {
    font-size: .7rem; font-weight: 700; text-transform: uppercase;
    letter-spacing: .04em; color: var(--text-soft); margin-bottom: 4px;
  }
  .current-compare-value { font-size: 1.1rem; font-weight: 700; color: var(--text); }
  .current-compare-accent { color: var(--blue); }
  .current-compare-note { margin-top: 10px; font-size: .75rem; color: var(--text-soft); line-height: 1.45; }

  /* ── Data table ── */
  .table-card {
    background: linear-gradient(180deg, rgba(255,255,255,.98) 0%, rgba(248,250,252,.98) 100%);
    border-radius: 20px; padding: 20px;
    border: 1px solid rgba(226,232,240,.9);
    box-shadow: var(--shadow-card);
  }
  .table-state {
    margin-top: 8px;
    border-radius: 10px;
    padding: 4px 8px;
    display: inline-block;
    font-size: .76rem;
  }
  .table-state-info { background: #eff6ff; color: #1d4ed8; }
  .table-state-warning { background: #fffbeb; color: #92400e; }
  .table-state-error { background: #fee2e2; color: #b91c1c; }
  .table-state-empty { background: #f1f5f9; color: #64748b; }
  .table-scroll {
    border: 1px solid rgba(226,232,240,.6);
    border-radius: 14px;
    overflow-x: auto;
    overflow-y: hidden;
    -webkit-overflow-scrolling: touch;
  }
  .table-hint {
    margin-top: 8px;
    color: var(--text-soft);
    font-size: .72rem;
    display: none;
  }
  .table-cards {
    margin-top: 12px;
    display: none;
    gap: 10px;
  }
  .table-empty-card {
    padding: 12px;
    border: 1px dashed #e5e7eb;
    border-radius: 12px;
    color: var(--text-soft);
    font-size: .82rem;
    background: #f8fafc;
  }
  .month-cards { display: none; }
  .month-card {
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 12px;
    margin-bottom: 10px;
    background: #fff;
    box-shadow: 0 8px 16px rgba(15,23,42,.05);
    display: grid;
    gap: 8px;
  }
  .month-card button {
    border: none;
    background: transparent;
    color: inherit;
    width: 100%;
    padding: 0;
    text-align: left;
    font: inherit;
    cursor: default;
    min-width: 0;
  }
  .month-card .month-card-button {
    cursor: default;
    border: none;
    background: transparent;
    color: inherit;
    width: 100%;
    padding: 0;
    text-align: left;
    font: inherit;
  }
  .month-card .month-card-button[aria-disabled='false'] {
    cursor: pointer;
  }
  .month-card.selected {
    border-color: #bfdbfe;
    box-shadow: 0 0 0 2px rgba(59,130,246,.24);
    background: #eff6ff;
  }
  .month-card[aria-disabled='true'] {
    opacity: .74;
  }
  .month-card-main {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 10px;
  }
  .month-card-main-inner {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    min-width: 0;
  }
  .month-card .month-title { font-weight: 700; font-size: .95rem; margin-bottom: 6px; }
  .month-card-meta {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .month-badge {
    display: inline-flex;
    align-items: center;
    height: 20px;
    padding: 0 8px;
    border-radius: 999px;
    font-size: .68rem;
    font-weight: 700;
    color: #1e293b;
    background: #f1f5f9;
  }
  .month-badge.provisional { color: #7c2d12; background: #ffedd5; }
  .month-badge.interactive { color: #166534; background: #dcfce7; }
  .month-badge.disabled { color: #6b7280; background: #eef2f7; }
  .month-card-note {
    font-size: .72rem;
    color: var(--text-soft);
    line-height: 1.35;
  }
  .month-card-note strong {
    color: #111827;
    font-weight: 700;
  }
  .month-card-cta {
    justify-self: end;
    margin-top: 2px;
    border: 1px solid var(--border);
    border-radius: 999px;
    background: #f8fafc;
    color: var(--blue);
    font-size: .74rem;
    padding: 4px 10px;
    font-weight: 700;
    min-height: 28px;
  }
  .month-card-cta[aria-disabled='true'] {
    opacity: .7;
    cursor: not-allowed;
  }
  .month-card .month-card-details {
    border-radius: 10px;
    background: #f8fafc;
    border: 1px solid #e5e7eb;
    padding: 8px 10px;
  }
  .month-card .month-card-details summary {
    font-size: .76rem;
    color: #1d4ed8;
    cursor: pointer;
    font-weight: 600;
  }
  .month-card .month-card-details summary::marker {
    color: #1d4ed8;
  }
  .month-card .month-card-details .month-row {
    margin-top: 8px;
  }
  .table-cards .month-card button:focus-visible,
  .table-cards .month-card-cta:focus-visible,
  .table-cards .month-card .month-card-chartlink:focus-visible {
    outline: 2px solid #1d4ed8;
    outline-offset: 2px;
  }
  .month-row {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-top: 8px;
    font-size: .74rem;
    color: var(--text-soft);
  }
  .month-row span {
    background: var(--bg);
    padding: 2px 7px;
    border-radius: 999px;
    border: 1px solid var(--border);
  }
  .month-card .month-detail {
    margin-top: 8px;
    display: flex;
    justify-content: space-between;
    gap: 8px;
    flex-wrap: wrap;
    font-size: .82rem;
  }
  .month-card .month-detail div { min-width: 110px; }
  .table-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; }
  .data-table { width: 100%; border-collapse: collapse; font-size: .875rem; }
  .data-table th {
    text-align: left; padding: 10px 12px; border-bottom: 2px solid var(--border);
    font-size: .75rem; text-transform: uppercase; letter-spacing: .04em; color: var(--text-soft);
    max-width: 0;
    overflow-wrap: anywhere;
    word-break: break-word;
    position: sticky;
    top: 0;
    background: rgba(255,255,255,.96);
    backdrop-filter: blur(10px);
    z-index: 1;
  }
  .data-table td { padding: 10px 12px; border-bottom: 1px solid var(--border); }
  .data-table tr:focus-visible { outline: 2px solid #1d4ed8; outline-offset: -2px; }
  .data-table tr[data-row-action='1'] { cursor: pointer; }
  .data-table tr:last-child td { border-bottom: none; }
  .data-table tr:hover td { background: var(--bg); }
  .data-table .bar-cell { width: 120px; }
  .mini-bar-wrap { display: flex; gap: 2px; height: 16px; align-items: flex-end; }
  .mini-bar { border-radius: 2px; }
  .bar-punta { background: #f87171; }
  .bar-llano  { background: #fcd34d; }
  .bar-valle  { background: #6ee7b7; }
  .month-label { font-weight: 600; }
  .cost-cell { font-weight: 600; color: var(--text); }
  .kwh-total { font-weight: 700; }
  .top-month td { background: #fffbeb !important; }
  .tr-selected td { background: #eff6ff !important; outline: 2px solid #3b82f6; outline-offset: -1px; }
  .tr-provisional td { font-style: italic; }
  .tr-provisional .month-label::after { content: ' (prov.)'; font-size: .72rem; color: var(--text-soft); font-weight: 400; }
  .section-title {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 3px 0;
    font-family: 'Avenir Next Condensed', 'Avenir Next', 'Segoe UI', sans-serif;
    font-size: 1.12rem;
    font-weight: 800;
    letter-spacing: .01em;
    background: linear-gradient(120deg, rgba(59,130,246,.16), rgba(251,191,36,.14));
    box-shadow: inset 0 -12px 0 rgba(59,130,246,.09);
  }

  /* ── Spinner ── */
  .spinner { display: inline-block; width: 16px; height: 16px; border: 2px solid rgba(255,255,255,.3);
             border-top-color: #fff; border-radius: 50%; animation: spin .6s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }

  /* ── Factura estimada ── */
  .factura-card {
    background: #fff; border-radius: 20px; border: 1px solid var(--border);
    margin-bottom: 24px; overflow: hidden;
    box-shadow: var(--shadow-soft);
  }
  .factura-hdr {
    background: linear-gradient(135deg, #1e3a8a 0%, #1a56db 100%);
    color: #fff; padding: 16px 20px;
    display: flex; justify-content: space-between; align-items: flex-start;
  }
  .factura-hdr-left h3 { font-size: 1rem; font-weight: 700; letter-spacing: .02em; }
  .factura-hdr-left p  { font-size: .8rem; opacity: .8; margin-top: 3px; }
  .factura-table-wrap {
    overflow-x: auto;
    -webkit-overflow-scrolling: touch;
    border-top: 1px solid var(--border);
  }
  .factura-badge {
    display: inline-block; padding: 3px 10px; border-radius: 12px;
    background: rgba(255,255,255,.2); font-size: .75rem; font-weight: 600;
    letter-spacing: .03em; backdrop-filter: blur(4px);
  }
  .ftable { width: 100%; border-collapse: collapse; font-size: .875rem; min-width: 650px; }
  .ftable td { padding: 9px 16px; border-bottom: 1px solid #f1f5f9; }
  .ftable .fhd td {
    background: #f8fafc; font-size: .71rem; font-weight: 700; text-transform: uppercase;
    letter-spacing: .05em; color: var(--text-soft); padding: 7px 16px;
    border-top: 1px solid var(--border); border-bottom: 1px solid var(--border);
  }
  .ftable .frow-punta    td { background: #fff8f8; }
  .ftable .frow-punta-nh td { background: #fffcfc; }
  .ftable .frow-llano    td { background: #fffef0; }
  .ftable .frow-valle    td { background: #f0fdf4; }
  .ftable .frow-sub      td { background: #f8fafc; font-weight: 600; border-top: 2px solid var(--border); }
  .ftable .frow-fixed    td { background: #f8fafc; }
  .ftable .frow-grav     td { background: #eff6ff; font-weight: 600; border-top: 2px solid #bfdbfe; }
  .ftable .frow-iva      td { background: #eff6ff; font-style: italic; color: #1d4ed8; }
  .ftable .frow-nongrav  td { background: #f8fafc; }
  .ftable .frow-total    td {
    background: #1e3a8a; color: #fff; font-weight: 700; font-size: 1rem;
    border-top: 2px solid #1e3a8a; padding: 12px 16px;
  }
  .fc-desc { width: 46%; }
  .fc-kwh  { width: 14%; text-align: right; color: var(--text-soft); }
  .fc-rate { width: 18%; text-align: right; color: var(--text-soft); font-size: .82rem; }
  .fc-amt  { width: 22%; text-align: right; font-weight: 600; }
  .ftable .frow-total .fc-amt { color: #fff; }
  .factura-footer {
    padding: 10px 16px; background: #f8fafc; border-top: 1px solid var(--border);
    font-size: .78rem; color: var(--text-soft); display: flex; justify-content: space-between;
    align-items: center; flex-wrap: wrap; gap: 8px;
  }
  .factura-cmp { display: flex; gap: 12px; align-items: center; }
  .factura-cmp-badge {
    padding: 2px 10px; border-radius: 12px; font-weight: 600; font-size: .78rem;
  }

  /* ── KPI hover tooltip ── */
  .kpi-has-tooltip { cursor: default; }
  .kpi-tooltip-wrap { position: relative; }
  .kpi-tooltip-wrap[aria-expanded="true"] .kpi-tooltip { display: block; }
  .kpi-tooltip {
    display: none;
    position: absolute;
    top: calc(100% + 10px);
    left: 0;
    min-width: 310px;
    background: #fff;
    border: 1px solid var(--border);
    border-radius: 14px;
    box-shadow: 0 10px 32px rgba(0,0,0,.13);
    padding: 16px;
    z-index: 200;
    font-size: .82rem;
    line-height: 1.4;
    pointer-events: auto;
  }
  .kpi-tooltip-toggle {
    appearance: none;
    border: none;
    margin: 0;
    padding: 0;
    color: inherit;
    background: transparent;
    text-align: left;
    width: 100%;
    cursor: pointer;
    font: inherit;
  }
  /* last two cards: align right so tooltip doesn't overflow viewport */
  .kpi-grid > :nth-last-child(-n+2) .kpi-tooltip { left: auto; right: 0; }
  .tt-title { font-weight: 700; font-size: .88rem; margin-bottom: 10px; color: var(--text); }
  .tt-section { font-size: .72rem; font-weight: 700; text-transform: uppercase;
                letter-spacing: .05em; color: var(--text-soft); margin: 10px 0 5px; }
  .tt-row {
    display: flex; justify-content: space-between; align-items: center;
    padding: 5px 8px; border-radius: 7px; margin-bottom: 3px;
  }
  .tt-row.punta   { background: #fee2e2; color: #7f1d1d; }
  .tt-row.punta-nh{ background: #fef2f2; color: #991b1b; }
  .tt-row.valle   { background: #dcfce7; color: #14532d; }
  .tt-row.llano   { background: #fef9c3; color: #78350f; }
  .tt-row.fixed   { background: #f3f4f6; color: var(--text); }
  .tt-row.iva     { background: #dbeafe; color: #1e40af; }
  .tt-row.total   { background: var(--rose-light); color: var(--rose); font-weight: 700; font-size: .88rem; }
  .tt-row.sub     { background: #f9fafb; color: var(--text); font-weight: 600; }
  .tt-lbl { flex: 1; }
  .tt-val { font-weight: 700; font-variant-numeric: tabular-nums; margin-left: 8px; white-space: nowrap; }
  .tt-hr  { border: none; border-top: 1px solid var(--border); margin: 8px 0; }
  .tt-note{ font-size: .73rem; color: var(--text-soft); margin-top: 8px; line-height: 1.5; }

  /* ── Tariff info (donut legend chips) ── */
  .tariff-row { display: flex; gap: 12px; flex-wrap: wrap; margin-top: 8px; }
  .tariff-chip { padding: 6px 14px; border-radius: 20px; font-size: .8rem; font-weight: 500; }
  .tariff-chip.punta  { background: #fee2e2; color: #b91c1c; }
  .tariff-chip.llano  { background: #fef9c3; color: #92400e; }
  .tariff-chip.valle  { background: #dcfce7; color: #166534; }
  .tariff-chip.info   { background: #dbeafe; color: #1d4ed8; }

  /* ── Tariff structure card ── */
  .tariff-struct-card {
    background: linear-gradient(180deg, rgba(255,255,255,.98) 0%, rgba(248,250,252,.98) 100%);
    border-radius: 20px; padding: 20px;
    border: 1px solid rgba(226,232,240,.9); margin-bottom: 24px;
    box-shadow: var(--shadow-card);
  }
  .tariff-struct-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 10px;
    flex-wrap: wrap;
  }
  .tariff-toggle {
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 5px 10px;
    background: #fff;
    color: var(--text);
    cursor: pointer;
    font: inherit;
    font-size: .78rem;
    font-weight: 700;
  }
  .tariff-struct-content[hidden] { display: none; }
  .tariff-struct-content[hidden] + * { display: none; }
  .tariff-struct-subtitle { font-size: .8rem; color: var(--text-soft); margin-top: 2px; margin-bottom: 16px; }
  .tariff-struct-cols { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 16px; }
  .tariff-col-title {
    font-size: .72rem; font-weight: 700; text-transform: uppercase;
    letter-spacing: .05em; color: var(--text-soft); margin-bottom: 8px;
  }
  .tl { display: flex; justify-content: space-between; align-items: center;
        padding: 7px 10px; border-radius: 8px; margin-bottom: 4px; font-size: .83rem; }
  .tl.punta    { background: #fee2e2; color: #7f1d1d; }
  .tl.punta-nh { background: #fef2f2; color: #991b1b; }
  .tl.llano    { background: #fef9c3; color: #78350f; }
  .tl.valle    { background: #dcfce7; color: #14532d; }
  .tl.fixed    { background: #f3f4f6; color: var(--text); }
  .tl.divider  { background: #dbeafe; color: #1e40af; font-weight: 600; }
  .tl-label    { flex: 1; }
  .tl-value    { font-weight: 700; font-variant-numeric: tabular-nums; margin-left: 12px; }
  .tariff-note { font-size: .78rem; color: var(--text-soft); line-height: 1.65; }
  .tariff-note p { margin-bottom: 3px; }
  .current-loading {
    padding: 40px 18px;
    text-align: center;
    color: var(--text-soft);
    border: 1px dashed #d7dfef;
    border-radius: 16px;
    background: linear-gradient(135deg, rgba(248,250,252,.92), rgba(239,246,255,.92));
  }
  .login-card {
    max-width: 560px;
    margin: 0 auto;
    padding: 28px;
    text-align: left;
    color: var(--text);
    border: 1px solid rgba(26,86,219,.16);
    border-radius: 22px;
    background:
      radial-gradient(circle at top right, rgba(26,86,219,.12), transparent 34%),
      linear-gradient(180deg, rgba(255,255,255,.98), rgba(248,250,252,.96));
    box-shadow: var(--shadow-card);
  }
  .login-eyebrow {
    display: inline-flex;
    margin-bottom: 12px;
    padding: 4px 10px;
    border-radius: 999px;
    background: var(--blue-light);
    color: var(--blue);
    font-size: .76rem;
    font-weight: 800;
    text-transform: uppercase;
    letter-spacing: .08em;
  }
  .login-card h2 {
    margin-bottom: 10px;
    font-size: 1.35rem;
  }
  .login-card p {
    color: var(--text-soft);
    line-height: 1.55;
    margin-bottom: 16px;
  }
  .login-card code {
    padding: 2px 5px;
    border-radius: 6px;
    background: #eef2ff;
    color: #1e3a8a;
  }
  .login-action {
    padding: 9px 16px;
    border: 0;
    border-radius: 10px;
    background: var(--blue);
    color: #fff;
    font-weight: 800;
    cursor: pointer;
    box-shadow: 0 10px 22px rgba(26,86,219,.18);
  }

  @media (max-width: 860px) {
    header { margin: 12px 12px 0; padding: 18px 18px 16px; border-radius: 20px; }
    .header-left span { max-width: 100%; }
    .header-right { width: 100%; justify-content: flex-start; margin-top: 12px; }
    header { flex-direction: column; align-items: flex-start; }
    .current-header { flex-direction: column; gap: 12px; }
    .current-header-right { width: 100%; justify-content: flex-start; }
  }

  @media (max-width: 640px) {
    .kpi-grid { grid-template-columns: 1fr; }
    .charts-grid .chart-container { height: 250px; }
    .table-card { padding: 14px; }
    .table-scroll { overflow-x: auto; }
    .table-cards { display: grid; }
    .table-hint { display: block; }
    .page {
      display: grid;
      grid-template-columns: 1fr;
      grid-template-areas:
        "filter"
        "kpis"
        "current"
        "charts"
        "table"
        "tariff"
        "factura";
      gap: 18px;
    }
    .page > .filter-bar { grid-area: filter; }
    .page > .kpi-grid { grid-area: kpis; }
    .page > .current-card { grid-area: current; }
    .page > .charts-grid { grid-area: charts; }
    .page > .table-card { grid-area: table; }
    .page > .tariff-struct-card { grid-area: tariff; }
    #facturaEstimada { grid-area: factura; }
  }

  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after {
      animation-duration: 0.01ms !important;
      animation-iteration-count: 1 !important;
      transition-duration: 0.01ms !important;
      scroll-behavior: auto !important;
    }
    .btn:hover,
    .sync-action:hover,
    .kpi-card:hover { transform: none; }
  }
</style>
</head>
<body>

<header>
  <div class="header-left">
    <h1>⚡ UTE Monitor</h1>
    <span>${DISPLAY_CONTEXT.accountLabel} · ${DISPLAY_CONTEXT.tariffLabel} · ${DISPLAY_CONTEXT.locationLabel}</span>
    <div class="demo-badge-wrap">${demoBadge}</div>
  </div>
</header>

<div class="page">

  <!-- Time filter bar -->
  <div class="filter-bar">
    <label>Período:</label>
    <div class="filter-pills">
      <button type="button" class="pill" data-range="3m" aria-pressed="false" onclick="setRange(this)">3 meses</button>
      <button type="button" class="pill" data-range="6m" aria-pressed="false" onclick="setRange(this)">6 meses</button>
      <button type="button" class="pill active" data-range="1y" aria-pressed="true" onclick="setRange(this)">12 meses</button>
      <button type="button" class="pill" data-range="ytd" aria-pressed="false" onclick="setRange(this)">Este año</button>
      <button type="button" class="pill" data-range="all" aria-pressed="false" onclick="setRange(this)">Todo</button>
    </div>
    <div class="filter-sep"></div>
    <label>Año:</label>
    <select class="filter-select" id="yearFilter" onchange="setYear(this.value)">
      <option value="">Todos</option>
    </select>
    <label>Desde:</label>
    <select class="filter-select" id="fromMonth" onchange="setCustomRange()">
      <option value="">-</option>
    </select>
    <label>Hasta:</label>
    <select class="filter-select" id="toMonth" onchange="setCustomRange()">
      <option value="">-</option>
    </select>
  </div>

  <!-- KPI cards -->
  <div class="kpi-grid" id="kpiGrid">
    <div class="kpi-card kpi-blue">
      <div class="kpi-icon">🔋</div>
      <div class="kpi-label">Último mes facturado</div>
      <div class="kpi-value" id="kpiLastKwh">–<span class="kpi-unit">kWh</span></div>
      <div class="kpi-sub" id="kpiLastMonth">–</div>
    </div>
    <div class="kpi-card kpi-orange">
      <div class="kpi-icon">💵</div>
      <div class="kpi-label">Costo último mes</div>
      <div class="kpi-value" id="kpiLastCost">–<span class="kpi-unit">$</span></div>
      <div class="kpi-sub" id="kpiLastCostSub">–</div>
    </div>
    <div class="kpi-card kpi-green">
      <div class="kpi-icon">📊</div>
      <div class="kpi-label">Promedio anual</div>
      <div class="kpi-value" id="kpiAvgKwh">–<span class="kpi-unit">kWh/mes</span></div>
      <div class="kpi-sub" id="kpiAvgSub">–</div>
    </div>
    <div class="kpi-card kpi-purple kpi-has-tooltip kpi-tooltip-wrap">
      <div class="kpi-icon">⚡</div>
      <div class="kpi-label">Consumo período actual</div>
      <div class="kpi-value" id="kpiCurrent"><span class="kpi-loading">Cargando…</span></div>
      <div class="kpi-sub" id="kpiCurrentSub">–</div>
      <div class="kpi-trendline" id="kpiCurrentTrend"></div>
      <div class="kpi-tooltip" id="kpiCurrentTooltip">
        <div class="tt-title">⚡ Ritmo vs período anterior</div>
        <div id="kpiCurrentTooltipBody">–</div>
      </div>
    </div>
    <div class="kpi-card kpi-rose kpi-has-tooltip kpi-tooltip-wrap">
      <div class="kpi-icon">🧮</div>
      <div class="kpi-label">Costo estimado período actual</div>
      <div class="kpi-value" id="kpiEstCost"><span class="kpi-loading">Cargando…</span></div>
      <div class="kpi-sub" id="kpiEstSub">Hover para ver desglose ↓</div>
      <div class="kpi-trendline" id="kpiEstTrend"></div>
      <div class="kpi-tooltip" id="kpiEstTooltip">
        <div class="tt-title">🧮 Desglose estimado del período actual</div>
        <div id="ttBody">–</div>
        <div class="tt-note" id="ttNote"></div>
      </div>
    </div>
  </div>

  <!-- Main chart + tramo donut -->
  <div class="charts-grid">
    <div class="chart-card">
      <div class="chart-header">
        <div>
          <div class="chart-title">Consumo mensual (kWh)</div>
          <div class="chart-subtitle" id="chartSubtitle">Últimos 12 meses</div>
        </div>
      </div>
      <div class="chart-container">
        <canvas id="mainChart"></canvas>
      </div>
    </div>
    <div class="chart-card">
      <div class="chart-header">
        <div>
          <div class="chart-title">Distribución por tramo</div>
          <div class="chart-subtitle" id="tramoSubtitle">Período seleccionado</div>
        </div>
      </div>
      <div class="chart-container">
        <canvas id="tramoChart"></canvas>
      </div>
      <div class="tariff-row" id="tramoPct"></div>
    </div>
  </div>

  <!-- Current period -->
  <div class="current-card">
    <div class="current-header">
      <div>
        <div class="section-title">📈 Consumo diario por período</div>
        <div class="current-period" id="currentPeriod">Cargando datos del portal UTE…</div>
      </div>
      <div class="current-header-right">
        <select class="filter-select current-select" id="supplySelector" onchange="selectSupply(this.value)" aria-label="Suministro UTE" hidden></select>
        <select class="filter-select current-select" id="dailyPeriodSel" onchange="onDailyPeriodChange(this.value)">
          <option value="current">⚡ Período actual</option>
        </select>
        <div id="cacheLabel" style="font-size:.8rem;color:var(--text-soft)"></div>
            <details class="sync-menu" id="syncMenu" aria-disabled="false">
              <summary class="btn btn-primary sync-summary">↻ Sincronizar</summary>
              <div class="sync-popover">
              <button class="sync-action" id="syncCurrentBtn" onclick="runSyncAction('current')" aria-label="Actualizar período actual">
                <strong>Actualizar período actual</strong>
                <span>Trae la última curva visible del portal. Demora cerca de 1 minuto.</span>
              </button>
              <button class="sync-action" id="syncFullBtn" onclick="runSyncAction('full')" aria-label="Descargar historial completo">
                <strong>Descargar historial completo</strong>
                <span>Refresca facturas, historial mensual y después vuelve a traer el período actual.</span>
              </button>
            </div>
          </details>
          <a class="btn btn-primary" href="api/diagnostic/download" download="ute-diagnostic.json" title="Descargar diagnóstico anonimizado" aria-label="Descargar diagnóstico anonimizado">Diagnóstico</a>
        </div>
      </div>
    <div id="refreshStatus" class="sync-status" role="status" aria-live="polite"></div>
    <div id="currentContent" class="current-loading">Conectando con el portal UTE…</div>
  </div>

  <!-- Tariff structure -->
  <div class="tariff-struct-card">
    <div class="section-title">🧾 Estructura tarifaria — TRT Residencial Triple</div>
    <div class="tariff-struct-subtitle">Precios en $UYU sin IVA · vigentes según última factura (Marzo 2026) · IVA 22% aplica sobre energía + potencia (cargo fijo y alumbrado NO son gravables)</div>
    <div class="tariff-struct-cols">
      <div>
        <div class="tariff-col-title">Energía (por kWh)</div>
        <div class="tl punta">
          <span class="tl-label">Punta — días hábiles</span>
          <span class="tl-value">$12,034</span>
        </div>
        <div class="tl punta-nh">
          <span class="tl-label">Punta — días no hábiles</span>
          <span class="tl-value">$5,172</span>
        </div>
        <div class="tl llano">
          <span class="tl-label">Llano</span>
          <span class="tl-value">$5,172</span>
        </div>
        <div class="tl valle">
          <span class="tl-label">Valle</span>
          <span class="tl-value">$2,443</span>
        </div>
      </div>
      <div>
        <div class="tariff-col-title">Cargos fijos (por mes, sin IVA)</div>
        <div class="tl fixed">
          <span class="tl-label">Cargo fijo conexión</span>
          <span class="tl-value">$488</span>
        </div>
        <div class="tl fixed">
          <span class="tl-label">Potencia contratada 5 kW</span>
          <span class="tl-value">$416</span>
        </div>
        <div class="tl fixed">
          <span class="tl-label">Alumbrado público</span>
          <span class="tl-value">$326</span>
        </div>
        <div class="tl divider">
          <span class="tl-label">Total fijos estimado c/IVA</span>
          <span class="tl-value">~$1,430</span>
        </div>
      </div>
      <div>
        <div class="tariff-col-title">Notas</div>
        <div class="tariff-note">
          <p>• El IVA 22% aplica sobre energía consumida y potencia — cargo fijo y alumbrado NO son gravables</p>
          <p>• Punta hábiles: 17:30–22:30 h días de semana</p>
          <p>• Valle: 22:30–06:00 h todos los días</p>
          <p>• Llano: resto de horas (incluye fines de semana y feriados)</p>
          <p>• El <b>$/kWh efectivo</b> de la tabla incluye todos los cargos fijos prorrateados</p>
        </div>
      </div>
    </div>
  </div>

  <!-- Data table -->
  <div class="table-card">
    <div class="table-header">
      <div class="section-title">📋 Detalle mensual</div>
      <div id="tableHint" style="font-size:.8rem;color:var(--text-soft)">👆 Entrá una fila para ver su factura estimada abajo</div>
    </div>
    <div class="table-state table-state-info" id="tableState" role="status">Cargando histórico mensual…</div>
    <div class="table-scroll">
      <table class="data-table" id="dataTable" aria-describedby="tableHint">
        <thead>
          <tr>
            <th>Mes</th>
            <th>Total kWh</th>
            <th style="color:#b91c1c">Punta kWh</th>
            <th style="color:#166534">Valle kWh</th>
            <th style="color:#92400e">Llano kWh</th>
            <th>Tramos</th>
            <th>Costo total</th>
            <th title="Energía estimada c/IVA, sin cargos fijos. Punta ~$9/kWh blended">Energía est. c/IVA</th>
            <th title="(Costo total) / kWh — incluye todos los cargos fijos prorrateados">$/kWh efectivo</th>
            <th>vs Promedio</th>
          </tr>
        </thead>
        <tbody id="tableBody"></tbody>
      </table>
    </div>
    <div class="table-cards" id="tableCards" aria-live="polite" aria-label="Detalle mensual en tarjetas"></div>
    <div class="table-hint" id="tableScrollHint">↔ Arrastrá la tabla horizontalmente para ver toda la grilla.</div>
  </div>

  <!-- Factura estimada (below table, populated by JS) -->
  <div id="facturaEstimada"></div>

</div>

<script>
// ─── State ───────────────────────────────────────────────────────────────────
let HIST_DATA  = [];
let ALL_DATA   = [];
let VIEW_DATA  = [];
let _tableMonths = [];
let mainChart  = null;
let tramoChart = null;
let activeRange = '1y';
let activeYear  = '';
let fromKey = '', toKey = '';
let CURRENT_DATA = null;
let ACTIVE_DAILY_PERIOD = 'current';
let DAILY_DETAIL_CACHE = {};
let dailyDetailRequestId = 0;
let DAILY_PERIOD_INDEX = [];
let CONFIG_STATUS = { credentials_configured: true, login_required: false };
let SYNC_BUSY = false;
let PORTFOLIO_SUPPLIES = [];
const URUGUAY_HOLIDAYS = ${JSON.stringify(URUGUAY_HOLIDAYS)};
const URUGUAY_HOLIDAY_SET = new Set(URUGUAY_HOLIDAYS);
const IS_DEMO_MODE = new URLSearchParams(window.location.search).get('demo') === '1';

function apiUrl(pathname) {
  if (!IS_DEMO_MODE) return pathname;
  return pathname.includes('?')
    ? pathname + '&demo=1'
    : pathname + '?demo=1';
}

const MONTHS = ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];
const MONTHS_FULL = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];

function setTableState(kind, text) {
  const state = document.getElementById('tableState');
  if (!state) return;
  const normalized = ['loading', 'empty', 'error', 'warning', 'info'].includes(kind) ? kind : 'info';
  state.textContent = text || '';
  state.className = 'table-state table-state-' + normalized;
  state.dataset.state = normalized;
}

function clearMonthCards(message) {
  const container = document.getElementById('tableCards');
  if (!container) return;
  container.innerHTML = '<div class="table-empty-card">' + (message || 'Sin meses para mostrar.') + '</div>';
}

function setActiveMonthSelection(idx) {
  const rows = document.querySelectorAll('#dataTable tbody tr');
  rows.forEach((row) => {
    row.classList.remove('tr-selected');
    row.removeAttribute('aria-current');
  });

  const cards = document.querySelectorAll('#tableCards .month-card');
  cards.forEach((card, i) => {
    card.classList.toggle('selected', i === idx);
    card.removeAttribute('aria-current');
    card.querySelector('.month-card-cta')?.removeAttribute('aria-current');
  });

  const selectedIdx = idx >= 0 ? rows[idx] : null;
  if (selectedIdx) {
    selectedIdx.classList.add('tr-selected');
    selectedIdx.setAttribute('aria-current', 'true');
  }

  if (_tableMonths[idx]) {
    const action = isHistoryRecordInteractive(_tableMonths[idx]);
    const cta = cards[idx]?.querySelector('.month-card-cta');
    if (cta && action) {
      cta.setAttribute('aria-current', 'true');
    }
  }
}

function renderHistoryCards() {
  const container = document.getElementById('tableCards');
  if (!container) return;
  if (!_tableMonths.length) {
    clearMonthCards('No hay meses para mostrar.');
    return;
  }
  container.innerHTML = _tableMonths.map((d, i) => renderHistoryMonthCard(d, i)).join('');
  setActiveMonthSelection(-1);
}

function onMonthCardKeydown(event, idx) {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  event.preventDefault();
  const btn = event.currentTarget;
  if (btn && btn.getAttribute('aria-disabled') === 'true') return;
  showFacturaForMonth(idx);
}

function isHistoryRecordInteractive(d) {
  return ((d?.punta_kwh || 0) + (d?.valle_kwh || 0) + (d?.llano_kwh || 0)) > 0;
}

function safeToLocale(number, digits = 1) {
  return Number(number || 0).toLocaleString('es-UY', { maximumFractionDigits: digits });
}

function renderHistoryMonthCard(d, idx) {
  const interactive = isHistoryRecordInteractive(d);
  const totalKwh = (d.punta_kwh || 0) + (d.valle_kwh || 0) + (d.llano_kwh || 0);
  const totalCost = d.costo_uyu || 0;
  const title = MONTHS_FULL[d.mes - 1] + ' ' + d.año;
  const rowLabel = getRowLabel(d);
  const actionAttrs = interactive
    ? ' role="button" tabindex="0" aria-disabled="false"' +
      ' onclick="showFacturaForMonth(' + idx + ')" onkeydown="onMonthCardKeydown(event, ' + idx + ')"'
    : ' role="button" tabindex="-1" aria-disabled="true"';

  const sourceLabel = d._source === 'local-cache'
    ? 'cache local'
    : d._daily_only && !isHistoryRecordInteractive(d)
      ? 'detalle diario guardado'
      : 'histórico mensual';

  return '<article class="month-card" aria-label="' + rowLabel + '">' +
    '<div class="month-card-main">' +
      '<div class="month-card-main-inner">' +
        '<span class="month-title">' + title + '</span>' +
        '<div class="month-card-meta">' +
          (d._provisional ? '<span class="month-badge provisional">Provisional</span>' : '') +
          (interactive ? '<span class="month-badge interactive">Con tramos</span>' : '<span class="month-badge disabled">Sin tramos</span>') +
        '</div>' +
        '<span class="month-card-note"><strong>Total:</strong> ' + safeToLocale(totalKwh, 2) + ' kWh</span>' +
        '<span class="month-card-note"><strong>Costo:</strong> ' + (totalCost ? '$' + safeToLocale(totalCost, 0) : 'Sin costo') + '</span>' +
        '<span class="month-card-note"><strong>Fuente:</strong> ' + sourceLabel + '</span>' +
        (d._provisional ? '<span class="month-card-note"><strong>Estimado:</strong> mes provisional</span>' : '') +
        (d.periodo_inicio && d.periodo_fin ? '<span class="month-card-note"><strong>Período:</strong> ' + d.periodo_inicio + ' → ' + d.periodo_fin + '</span>' : '') +
      '</div>' +
      '<button type="button" class="month-card-cta" ' + actionAttrs + ' aria-label="Ver factura estimada de ' + title + '">' +
        (interactive ? 'Ver factura estimada' : 'Sin detalle de tramos') +
      '</button>' +
    '</div>' +
    '<details class="month-card-details">' +
      '<summary>Detalle por tramo</summary>' +
      '<div class="month-row">' +
        '<span style="color:#b91c1c">Punta: ' + safeToLocale(d.punta_kwh || 0, 2) + '</span>' +
        '<span style="color:#166534">Valle: ' + safeToLocale(d.valle_kwh || 0, 2) + '</span>' +
        '<span style="color:#92400e">Llano: ' + safeToLocale(d.llano_kwh || 0, 2) + '</span>' +
      '</div>' +
    '</details>' +
  '</article>';
}

function getRowLabel(d) {
  return 'Ver factura estimada de ' + MONTHS_FULL[d.mes - 1] + ' ' + d.año + (d._provisional ? ' (provisional)' : '');
}

async function loadConfigStatus() {
  try {
    return await fetch(apiUrl('api/config-status')).then(r => r.json());
  } catch (e) {
    return { credentials_configured: true, login_required: false };
  }
}

function setLoginRequiredUi(required) {
  const syncCurrentBtn = document.getElementById('syncCurrentBtn');
  const syncFullBtn = document.getElementById('syncFullBtn');
  const syncMenu = document.getElementById('syncMenu');
  if (syncCurrentBtn) syncCurrentBtn.disabled = required;
  if (syncFullBtn) syncFullBtn.disabled = required;
  if (syncMenu) {
    syncMenu.setAttribute('aria-disabled', required ? 'true' : 'false');
    if (required) syncMenu.open = false;
  }
}

async function loadSupplies() {
  let response = await fetch(apiUrl('api/supplies'));
  let payload = await response.json();
  if (!payload.supplies?.length || payload.source === 'legacy-single-supply' || payload.needsRefresh || payload.unsafe || payload.contextIncomplete) {
    const refreshed = await fetch(apiUrl('api/portfolio/refresh'), { method: 'POST' });
    if (refreshed.ok) {
      response = await fetch(apiUrl('api/supplies'));
      payload = await response.json();
    } else {
      const detail = await refreshed.json().catch(() => ({}));
      payload.discoveryError = detail.error || 'portfolio_discovery_failed';
    }
  }
  PORTFOLIO_SUPPLIES = payload.supplies || [];
  const selector = document.getElementById('supplySelector');
  if (!selector) return payload;
  selector.innerHTML = '';
  if (payload.selectionRequired) {
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = 'Seleccioná un suministro…';
    placeholder.disabled = true;
    placeholder.selected = true;
    selector.appendChild(placeholder);
  }
  PORTFOLIO_SUPPLIES.forEach((supply) => {
    const option = document.createElement('option');
    option.value = supply.supplyKey;
    option.textContent = (supply.accountAlias || supply.accountNumber || 'Cuenta') + ' · ' + (supply.alias || supply.location || supply.supplyKey) + (supply.syncReady ? '' : ' (no disponible)');
    option.disabled = !supply.syncReady;
    option.selected = supply.supplyKey === payload.selectedSupplyKey;
    selector.appendChild(option);
  });
  selector.hidden = PORTFOLIO_SUPPLIES.length < 2;
  return payload;
}

async function selectSupply(supplyKey) {
  if (!supplyKey) return;
  const response = await fetch(apiUrl('api/supply/select'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ supplyKey }) });
  if (!response.ok) { document.getElementById('refreshStatus').textContent = 'No se pudo seleccionar el suministro'; return; }
  document.getElementById('refreshStatus').textContent = 'Suministro seleccionado';
  window.location.reload();
}

function renderSelectionRequired(payload) {
  setLoginRequiredUi(true);
  setTableState('warning', 'Seleccioná un suministro para continuar.');
  document.getElementById('currentPeriod').textContent = 'Seleccioná un suministro para continuar';
  document.getElementById('currentContent').className = 'current-loading';
  document.getElementById('currentContent').innerHTML = '<div class="login-card"><div class="login-eyebrow">Portfolio UTE</div><h2>Elegí el suministro</h2><p>El portal devolvió más de un suministro. Elegí uno en el selector para evitar sincronizar la cuenta equivocada.</p></div>';
  document.getElementById('refreshStatus').textContent = 'Hay ' + (payload.supplies || []).length + ' suministros disponibles';
}

function renderDiscoveryError() {
  document.getElementById('currentPeriod').textContent = 'No se pudieron descubrir los suministros';
  setTableState('error', 'No se pudo completar el discovery de portales.');
  document.getElementById('currentContent').className = 'current-loading';
  document.getElementById('currentContent').innerHTML = '<div class="login-card"><div class="login-eyebrow">Conexión UTE</div><h2>Necesitamos revisar el acceso</h2><p>El portal no devolvió una cuenta utilizable. Descargá el diagnóstico anonimizado y compartilo con soporte; tu contraseña y tus identificadores no se incluyen.</p><p><a href="api/diagnostic/download" download="ute-diagnostic.json">Descargar diagnóstico</a></p></div>';
  document.getElementById('refreshStatus').textContent = 'Discovery incompleto';
}

function clearHistoricalUi() {
  HIST_DATA = [];
  ALL_DATA = [];
  VIEW_DATA = [];
  _tableMonths = [];
  CURRENT_DATA = null;
  DAILY_PERIOD_INDEX = [];
  DAILY_DETAIL_CACHE = {};
  ACTIVE_DAILY_PERIOD = 'current';

  document.getElementById('kpiLastKwh').innerHTML = '<span class="kpi-loading">Login</span>';
  document.getElementById('kpiLastMonth').textContent = 'Configurá el add-on';
  document.getElementById('kpiLastCost').innerHTML = '<span class="kpi-loading">Login</span>';
  document.getElementById('kpiLastCostSub').textContent = 'Sin historial visible hasta configurar credenciales';
  document.getElementById('kpiAvgKwh').innerHTML = '<span class="kpi-loading">Login</span>';
  document.getElementById('kpiAvgSub').textContent = 'El historial se desbloquea cuando el add-on tiene login';
  document.getElementById('chartSubtitle').textContent = 'Login requerido';
  document.getElementById('tramoSubtitle').textContent = 'Login requerido';
  document.getElementById('tramoPct').innerHTML = '';
  setTableState('info', IS_DEMO_MODE ? 'Modo DEMO activo: datos de prueba y sync bloqueadas' : 'Sin historial cargado todavía.');
  document.getElementById('tableBody').innerHTML =
    '<tr><td colspan="10" style="padding:18px;text-align:center;color:#64748b">Login requerido para ver historial y detalle mensual.</td></tr>';
  clearMonthCards('Login requerido para ver historial y detalle mensual.');
  document.getElementById('facturaEstimada').innerHTML = '';

  if (mainChart) {
    mainChart.destroy();
    mainChart = null;
  }
  if (tramoChart) {
    tramoChart.destroy();
    tramoChart = null;
  }
}

function renderLoginRequired() {
  clearHistoricalUi();
  setLoginRequiredUi(true);
  setTableState('warning', 'Login requerido para ver historial completo y mutaciones.');
  document.getElementById('refreshStatus').textContent = 'Login requerido';
  document.getElementById('kpiCurrent').innerHTML = '<span class="kpi-loading">Login</span>';
  document.getElementById('kpiCurrentSub').textContent = 'Configurá el add-on';
  document.getElementById('kpiCurrentTrend').innerHTML = '';
  document.getElementById('kpiCurrentTooltipBody').innerHTML =
    '<div class="tt-note">El add-on todavía no tiene usuario y contraseña de UTE.</div>';
  document.getElementById('kpiEstCost').innerHTML = '<span class="kpi-loading">Login</span>';
  document.getElementById('kpiEstSub').textContent = 'Configurá el add-on';
  document.getElementById('kpiEstTrend').innerHTML = '';
  document.getElementById('ttBody').textContent = 'Login requerido';
  document.getElementById('ttNote').textContent = 'Guardá la configuración y reiniciá el add-on.';
  document.getElementById('currentPeriod').textContent = 'Login requerido';
  document.getElementById('cacheLabel').textContent = '';
  document.getElementById('currentContent').className = 'current-loading';
  document.getElementById('currentContent').innerHTML =
    '<div class="login-card">' +
      '<div class="login-eyebrow">Login</div>' +
      '<h2>Conectá tu cuenta de UTE</h2>' +
      '<p>Este add-on todavía no tiene un login configurado. Abrí la pestaña <b>Configuration</b> del add-on, cargá tu <b>Usuario UTE / número de cuenta</b> (no email) y la contraseña, guardá y reiniciá el add-on.</p>' +
      '<button class="login-action" onclick="checkLoginStatus()">Revisar estado</button>' +
    '</div>';
}

async function ensureLoginReady() {
  CONFIG_STATUS = await loadConfigStatus();
  if (CONFIG_STATUS.login_required) {
    renderLoginRequired();
    return false;
  }
  setLoginRequiredUi(false);
  return true;
}

async function checkLoginStatus() {
  const s = document.getElementById('refreshStatus');
  CONFIG_STATUS = await loadConfigStatus();
  if (CONFIG_STATUS.login_required) {
    renderLoginRequired();
    s.textContent = 'Login pendiente';
    return;
  }
  s.textContent = 'Login detectado, cargando…';
  setLoginRequiredUi(false);
  await loadCurrent();
  setTimeout(() => { s.textContent = ''; }, 2500);
}

function parsePortalDate(text) {
  const [d, m, y] = String(text || '').split('-').map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}

function parseIsoDate(text) {
  const [y, m, d] = String(text || '').split('-').map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}

function diffDays(start, end) {
  return Math.round((end - start) / 86400000);
}

function formatDateShort(date) {
  return String(date.getDate()).padStart(2, '0') + '/' + String(date.getMonth() + 1).padStart(2, '0');
}

function formatPortalDate(date) {
  return String(date.getDate()).padStart(2, '0') + '-' +
    String(date.getMonth() + 1).padStart(2, '0') + '-' +
    date.getFullYear();
}

function formatIsoDate(date) {
  return date.getFullYear() + '-' +
    String(date.getMonth() + 1).padStart(2, '0') + '-' +
    String(date.getDate()).padStart(2, '0');
}

function countBillingDays(periodoInicio, periodoFin) {
  const start = parsePortalDate(periodoInicio);
  const end = parsePortalDate(periodoFin);
  const totDays = Math.max(0, Math.round((end - start) / 86400000));
  let habCount = 0;
  let noHabCount = 0;

  for (let dt = new Date(start); dt < end; dt.setDate(dt.getDate() + 1)) {
    const dow = dt.getDay();
    const isWeekend = dow === 0 || dow === 6;
    const isHoliday = URUGUAY_HOLIDAY_SET.has(formatPortalDate(dt));
    if (isWeekend || isHoliday) noHabCount += 1;
    else habCount += 1;
  }

  return { totDays, habCount, noHabCount };
}

function getHistoricalPeriodMeta(record) {
  if (!record || !record.fecha) return null;
  const end = parseIsoDate(record.fecha);
  const start = new Date(end.getFullYear(), end.getMonth() - 1, end.getDate());
  return {
    start,
    end,
    days: Math.max(1, diffDays(start, end)),
    label: formatDateShort(start) + ' → ' + formatDateShort(end)
  };
}

function buildPreviousPeriodShadow(currentData, fallbackPrevRecord) {
  const elapsedDays = (currentData?.dias || []).length;
  if (!currentData || !elapsedDays) return null;

  const prevPeriod = currentData.comparativa_anterior;
  if (prevPeriod && Array.isArray(prevPeriod.dias) && prevPeriod.dias.length) {
    const prevDays = prevPeriod.dias;
    const compareDays = Math.min(elapsedDays, prevDays.length);
    const prevDailySeries = prevDays.slice(0, compareDays).map(d => +(d.kwh || 0));
    const prevToDate = prevDailySeries.reduce((sum, v) => sum + v, 0);
    const currentToDate = currentData.consumo_kwh || 0;
    const diffPct = prevToDate > 0
      ? Math.round((currentToDate - prevToDate) / prevToDate * 100)
      : 0;
    const prevDayCount = Math.max(prevDays.length, 1);
    const tramoFactor = compareDays / prevDayCount;

    return {
      prevRecord: fallbackPrevRecord || null,
      prevMeta: {
        start: parsePortalDate(prevPeriod.periodo_inicio),
        end: parsePortalDate(prevPeriod.periodo_fin),
        days: prevDayCount,
        label: prevPeriod.periodo_inicio + ' → ' + prevPeriod.periodo_fin
      },
      prevPeriod,
      elapsedDays,
      compareDays,
      prevDailyAvg: prevToDate / compareDays,
      prevDailySeries,
      prevToDate,
      currentToDate,
      diffPct,
      prevPuntaToDate: (prevPeriod.punta_kwh || 0) * tramoFactor,
      prevLlanoToDate: (prevPeriod.llano_kwh || 0) * tramoFactor,
      prevValleToDate: (prevPeriod.valle_kwh || 0) * tramoFactor,
      hasActualDailySeries: true
    };
  }

  const prev = fallbackPrevRecord || null;
  if (!prev) return null;
  const prevMeta = getHistoricalPeriodMeta(prev);
  if (!prevMeta) return null;

  const compareDays = Math.min(elapsedDays, prevMeta.days);
  const prevDailyAvg = prev.consumo_kwh / prevMeta.days;
  const prevToDate = prevDailyAvg * compareDays;
  const currentToDate = currentData.consumo_kwh || 0;
  const diffPct = prevToDate > 0
    ? Math.round((currentToDate - prevToDate) / prevToDate * 100)
    : 0;

  return {
    prevRecord: prev,
    prevMeta,
    elapsedDays,
    compareDays,
    prevDailyAvg,
    prevDailySeries: Array.from({ length: compareDays }, () => prevDailyAvg),
    prevToDate,
    currentToDate,
    diffPct,
    prevPuntaToDate: ((prev.punta_kwh || 0) / prevMeta.days) * compareDays,
    prevLlanoToDate: ((prev.llano_kwh || 0) / prevMeta.days) * compareDays,
    prevValleToDate: ((prev.valle_kwh || 0) / prevMeta.days) * compareDays,
    hasActualDailySeries: false
  };
}

// ─── Init ─────────────────────────────────────────────────────────────────────
async function init() {
  CONFIG_STATUS = await loadConfigStatus();
  setLoginRequiredUi(Boolean(CONFIG_STATUS.login_required));

  if (CONFIG_STATUS.login_required) {
    clearHistoricalUi();
    populateFilterSelects();
    populateDailyPeriodSelect();
    renderLoginRequired();
    return;
  }

  const supplies = await loadSupplies().catch(() => ({ supplies: [], selectionRequired: false }));
  if (supplies.discoveryError && (!(supplies.supplies || []).length || supplies.unsafe || supplies.contextIncomplete)) {
    renderDiscoveryError();
    return;
  }
  if (supplies.contextIncomplete || supplies.unsafe) {
    renderDiscoveryError();
    return;
  }
  if (supplies.selectionRequired) {
    renderSelectionRequired(supplies);
    return;
  }

  setTableState('loading', 'Cargando historial mensual…');
  try {
    const dataResponse = await fetch(apiUrl('api/data'));
    if (!dataResponse.ok) {
      throw new Error('No se pudo descargar el histórico mensual (' + dataResponse.status + ').');
    }
    const data = await dataResponse.json();

    const periodIndexResponse = await fetch(apiUrl('api/period-detail-index'));
    DAILY_PERIOD_INDEX = periodIndexResponse.ok ? (await periodIndexResponse.json()) : [];

    HIST_DATA = data.sort((a, b) => a.año !== b.año ? a.año - b.año : a.mes - b.mes);
    rebuildAllData();
    populateFilterSelects();
    populateDailyPeriodSelect();
    applyFilter();
    await loadCurrent();
  } catch (e) {
    clearHistoricalUi();
    setTableState('error', e.message || 'No se pudo descargar el histórico mensual.');
    document.getElementById('chartSubtitle').textContent = 'Sin datos';
    document.getElementById('tramoSubtitle').textContent = 'Sin datos';
    document.getElementById('tableBody').innerHTML = '<tr><td colspan="10" style="padding:18px;text-align:center;color:#64748b">No se pudo cargar el historial mensual.</td></tr>';
    clearMonthCards('No se pudo cargar el historial mensual.');
    updateMainChart();
    updateTramoChart();
  }
}

function populateFilterSelects() {
  const currentYearVal = document.getElementById('yearFilter')?.value || activeYear || '';
  const currentFromVal = document.getElementById('fromMonth')?.value || fromKey || '';
  const currentToVal = document.getElementById('toMonth')?.value || toKey || '';
  const years = [...new Set(ALL_DATA.map(d => d.año))].sort();
  const yearSel = document.getElementById('yearFilter');
  yearSel.innerHTML = '<option value="">Todos</option>';
  years.forEach(y => {
    const o = document.createElement('option'); o.value = y; o.textContent = y;
    yearSel.appendChild(o);
  });

  const fromSel = document.getElementById('fromMonth');
  const toSel   = document.getElementById('toMonth');
  fromSel.innerHTML = '<option value="">-</option>';
  toSel.innerHTML = '<option value="">-</option>';
  if (ALL_DATA.length === 0) {
    yearSel.value = currentYearVal;
    fromSel.value = '';
    toSel.value = '';
    return;
  }
  ALL_DATA.forEach(d => {
    const key = d.año + '-' + String(d.mes).padStart(2,'0');
    const label = MONTHS[d.mes-1] + ' ' + d.año + (d._provisional ? ' (prov.)' : '');
    for (const sel of [fromSel, toSel]) {
      const o = document.createElement('option'); o.value = key; o.textContent = label;
      sel.appendChild(o);
    }
  });
  yearSel.value = currentYearVal;
  fromSel.value = currentFromVal;
  toSel.value = currentToVal || (ALL_DATA[ALL_DATA.length-1].año + '-' + String(ALL_DATA[ALL_DATA.length-1].mes).padStart(2,'0'));
}

function buildProvisionalMonthFromCurrent(currentData) {
  const prevPeriod = currentData?.periodo_cerrado_anterior || currentData?.comparativa_anterior;
  const lastHist = HIST_DATA[HIST_DATA.length - 1];
  if (!prevPeriod || !lastHist) return null;

  const periodEnd = parsePortalDate(prevPeriod.periodo_fin);
  const readingDate = new Date(periodEnd);
  readingDate.setDate(readingDate.getDate() + 1);
  const lastHistDate = parseIsoDate(lastHist.fecha);

  if (readingDate <= lastHistDate) return null;

  const month = readingDate.getMonth() + 1;
  const year = readingDate.getFullYear();
  if (lastHist.mes === month && lastHist.año === year) return null;

  const calc = calcFactura(
    prevPeriod.punta_kwh || 0,
    prevPeriod.valle_kwh || 0,
    prevPeriod.llano_kwh || 0,
    prevPeriod.periodo_inicio,
    formatPortalDate(readingDate)
  );

  return {
    mes: month,
    año: year,
    fecha: formatIsoDate(readingDate),
    consumo_kwh: Math.round(prevPeriod.consumo_kwh || 0),
    punta_kwh: Math.round(prevPeriod.punta_kwh || 0),
    valle_kwh: Math.round(prevPeriod.valle_kwh || 0),
    llano_kwh: Math.round(prevPeriod.llano_kwh || 0),
    costo_uyu: Math.round(calc.total),
    _provisional: true,
    _periodo_inicio: prevPeriod.periodo_inicio,
    _periodo_fin: prevPeriod.periodo_fin
  };
}

function rebuildAllData() {
  ALL_DATA = HIST_DATA.slice();
  const provisional = buildProvisionalMonthFromCurrent(CURRENT_DATA);
  if (provisional) ALL_DATA.push(provisional);
  ALL_DATA.sort((a,b) => a.año !== b.año ? a.año - b.año : a.mes - b.mes);
}

function getPeriodRecordKey(record) {
  return 'hist:' + record.año + '-' + String(record.mes).padStart(2, '0');
}

function getAllDailyPeriodRecords() {
  const merged = new Map();
  DAILY_PERIOD_INDEX.forEach(d => {
    const key = getPeriodRecordKey(d);
    const hist = ALL_DATA.find(x => getPeriodRecordKey(x) === key);
    merged.set(key, hist ? { ...d, ...hist, periodo_inicio: d.periodo_inicio, periodo_fin: d.periodo_fin, _daily_only: d._daily_only, _source: d._source } : d);
  });
  return Array.from(merged.values()).sort((a, b) => {
    const aKey = a.año * 100 + a.mes;
    const bKey = b.año * 100 + b.mes;
    return aKey - bKey;
  });
}

function getPeriodRecordByKey(key) {
  return getAllDailyPeriodRecords().find(d => getPeriodRecordKey(d) === key) || null;
}

function getPeriodBounds(record) {
  if (!record) return null;
  if (record.periodo_inicio && record.periodo_fin) {
    return {
      start: record.periodo_inicio,
      end: record.periodo_fin
    };
  }
  const prevMes = record.mes === 1 ? 12 : record.mes - 1;
  const prevAño = record.mes === 1 ? record.año - 1 : record.año;
  return {
    start: record._periodo_inicio || ('27-' + String(prevMes).padStart(2, '0') + '-' + prevAño),
    end: record._periodo_fin || ('27-' + String(record.mes).padStart(2, '0') + '-' + record.año)
  };
}

function getPreviousRecord(record) {
  const records = getAllDailyPeriodRecords();
  const idx = records.findIndex(d => d.año === record.año && d.mes === record.mes);
  return idx > 0 ? records[idx - 1] : null;
}

function populateDailyPeriodSelect() {
  const sel = document.getElementById('dailyPeriodSel');
  if (!sel) return;
  const selected = ACTIVE_DAILY_PERIOD || sel.value || 'current';
  const histOptions = getAllDailyPeriodRecords().slice().reverse().map(d => {
    const bounds = getPeriodBounds(d);
    const label = MONTHS_FULL[d.mes - 1] + ' ' + d.año +
      (d._provisional ? ' (prov.)' : '') +
      (d._daily_only && !ALL_DATA.find(x => x.año === d.año && x.mes === d.mes) ? ' (solo diario)' : '');
    return '<option value="' + getPeriodRecordKey(d) + '">' +
      label + ' · ' + bounds.start + ' → ' + bounds.end +
      '</option>';
  }).join('');
  sel.innerHTML =
    '<option value="current">⚡ Período actual</option>' +
    histOptions;
  sel.value = sel.querySelector('option[value="' + selected + '"]') ? selected : 'current';
  ACTIVE_DAILY_PERIOD = sel.value;
}

function getPeriodDetailStatusLabel(data) {
  const source = data?._source || '';
  if (source === 'local-cache') return '💾 Detalle local guardado';
  if (source === 'current-snapshot') return '💾 Detalle recuperado del snapshot local';
  if (source === 'live-fetch') return '📡 Detalle traído del portal y guardado';
  return '📚 Detalle diario disponible';
}

// ─── Filters ──────────────────────────────────────────────────────────────────
function setRange(el) {
  document.querySelectorAll('.pill').forEach(p => p.classList.remove('active'));
  el.classList.add('active');
  activeRange = el.dataset.range;
  activeYear  = '';
  fromKey     = '';
  toKey       = '';
  document.getElementById('yearFilter').value  = '';
  document.getElementById('fromMonth').value   = '';
  document.getElementById('toMonth').value     = '';
  applyFilter();
}

function setYear(y) {
  activeYear  = y;
  activeRange = y ? 'year' : '1y';
  fromKey = '';
  toKey   = '';
  document.querySelectorAll('.pill').forEach(p => p.classList.remove('active'));
  if (!y) {
    document.querySelector('[data-range="1y"]').classList.add('active');
    activeRange = '1y';
  }
  applyFilter();
}

function setCustomRange() {
  fromKey = document.getElementById('fromMonth').value;
  toKey   = document.getElementById('toMonth').value;
  if (fromKey || toKey) {
    activeRange = 'custom';
    activeYear  = '';
    document.querySelectorAll('.pill').forEach(p => p.classList.remove('active'));
    document.getElementById('yearFilter').value = '';
  }
  applyFilter();
}

function applyFilter() {
  if (!ALL_DATA.length) {
    setTableState('empty', 'No hay datos históricos para mostrar.');
    clearHistoricalUi();
    setTableState('empty', 'No hay datos históricos para mostrar.');
    document.getElementById('tableBody').innerHTML =
      '<tr><td colspan="10" style="padding:18px;text-align:center;color:#64748b">No hay datos históricos para mostrar.</td></tr>';
    document.getElementById('chartSubtitle').textContent = 'Sin datos';
    document.getElementById('tramoSubtitle').textContent = 'Sin datos';
    updateMainChart();
    updateTramoChart();
    return;
  }

  const last = ALL_DATA[ALL_DATA.length - 1];
  const lastDate = new Date(last.año, last.mes - 1);

  if (activeRange === 'year' && activeYear) {
    VIEW_DATA = ALL_DATA.filter(d => d.año === parseInt(activeYear));
  } else if (activeRange === 'custom' && (fromKey || toKey)) {
    VIEW_DATA = ALL_DATA.filter(d => {
      const key = d.año + '-' + String(d.mes).padStart(2,'0');
      if (fromKey && key < fromKey) return false;
      if (toKey   && key > toKey)   return false;
      return true;
    });
  } else if (activeRange === 'ytd') {
    VIEW_DATA = ALL_DATA.filter(d => d.año === lastDate.getFullYear());
  } else if (activeRange === 'all') {
    VIEW_DATA = ALL_DATA;
  } else {
    const months = activeRange === '3m' ? 3 : activeRange === '6m' ? 6 : 12;
    VIEW_DATA = ALL_DATA.slice(-months);
  }

  const subtitle = VIEW_DATA.length > 0
    ? MONTHS[VIEW_DATA[0].mes-1] + ' ' + VIEW_DATA[0].año + ' – ' + MONTHS[VIEW_DATA[VIEW_DATA.length-1].mes-1] + ' ' + VIEW_DATA[VIEW_DATA.length-1].año
    : '–';

  if (!VIEW_DATA.length) {
    setTableState('empty', 'No hay períodos para el rango seleccionado.');
    document.getElementById('tableBody').innerHTML =
      '<tr><td colspan="10" style="padding:18px;text-align:center;color:#64748b">No hay períodos para el rango actual.</td></tr>';
    clearMonthCards('No hay períodos para el rango actual.');
    document.getElementById('chartSubtitle').textContent  = 'Sin datos';
    document.getElementById('tramoSubtitle').textContent  = 'Sin datos';
    updateMainChart();
    updateTramoChart();
    return;
  }

  document.getElementById('chartSubtitle').textContent  = subtitle;
  document.getElementById('tramoSubtitle').textContent  = subtitle;
  setTableState('info', 'Seleccioná una fila para ver su factura estimada.');

  updateKPIs();
  updateMainChart();
  updateTramoChart();
  updateTable();
}

// ─── KPIs ─────────────────────────────────────────────────────────────────────
function updateKPIs() {
  const last    = ALL_DATA[ALL_DATA.length - 1];
  const prev    = ALL_DATA[ALL_DATA.length - 2];
  const yearData = ALL_DATA.filter(d => d.año === last.año);
  const avgKwh   = Math.round(yearData.reduce((s,d) => s + d.consumo_kwh, 0) / yearData.length);
  const avgCost  = Math.round(yearData.reduce((s,d) => s + d.costo_uyu,  0) / yearData.length);

  document.getElementById('kpiLastKwh').innerHTML =
    '<b>' + last.consumo_kwh.toLocaleString('es-UY') + '</b><span class="kpi-unit">kWh</span>';
  document.getElementById('kpiLastMonth').textContent =
    MONTHS_FULL[last.mes-1] + ' ' + last.año + (last._provisional ? ' · estimado hasta confirmación UTE' : '');

  document.getElementById('kpiLastCost').innerHTML =
    '<b>' + (last._provisional ? '~' : '') + '$' + last.costo_uyu.toLocaleString('es-UY') + '</b>';
  if (prev) {
    const diff = Math.round((last.costo_uyu - prev.costo_uyu) / prev.costo_uyu * 100);
    const cls  = diff > 0 ? 'badge-up' : diff < 0 ? 'badge-down' : 'badge-neutral';
    const sign = diff > 0 ? '↑' : diff < 0 ? '↓' : '~';
    document.getElementById('kpiLastCostSub').innerHTML =
      '<span class="kpi-badge ' + cls + '">' + sign + ' ' + Math.abs(diff) + '% vs mes anterior</span>' +
      (last._provisional ? '<span class="kpi-trendnote">estimado</span>' : '');
  }

  document.getElementById('kpiAvgKwh').innerHTML =
    '<b>' + avgKwh.toLocaleString('es-UY') + '</b><span class="kpi-unit">kWh/mes</span>';
  document.getElementById('kpiAvgSub').textContent =
    'Costo promedio: $' + avgCost.toLocaleString('es-UY') + '/mes (' + last.año + ')';
}

// ─── Main chart ───────────────────────────────────────────────────────────────
function updateMainChart() {
  const labels = VIEW_DATA.map(d => MONTHS[d.mes-1] + ' ' + String(d.año).slice(2));
  const kwh    = VIEW_DATA.map(d => d.consumo_kwh);
  const costos = VIEW_DATA.map(d => d.costo_uyu);
  const avg    = VIEW_DATA.reduce((s,d) => s + d.consumo_kwh, 0) / (VIEW_DATA.length || 1);
  const avgArr = VIEW_DATA.map(() => Math.round(avg));

  const ctx = document.getElementById('mainChart').getContext('2d');
  if (mainChart) mainChart.destroy();

  mainChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [
        {
          label: 'kWh', data: kwh, backgroundColor: VIEW_DATA.map(d =>
            d._provisional ? 'rgba(251,146,60,.78)' :
            d.consumo_kwh > avg * 1.15 ? 'rgba(239,68,68,.8)' :
            d.consumo_kwh < avg * 0.85 ? 'rgba(16,185,129,.8)' :
            'rgba(59,130,246,.7)'),
          borderRadius: 4, borderSkipped: false, order: 2
        },
        {
          label: 'Promedio', data: avgArr, type: 'line',
          borderColor: 'rgba(107,114,128,.6)', borderDash: [4,4], borderWidth: 1.5,
          pointRadius: 0, fill: false, order: 1
        }
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: ctx => ctx.dataset.label === 'kWh'
              ? ' ' + ctx.raw.toLocaleString('es-UY') + ' kWh' + (VIEW_DATA[ctx.dataIndex]?._provisional ? ' (estimado)' : '')
              : ' Promedio: ' + ctx.raw.toLocaleString('es-UY') + ' kWh'
          }
        }
      },
      scales: {
        y: { beginAtZero: true, grid: { color: '#f0f0f0' },
             ticks: { callback: v => v.toLocaleString('es-UY') + ' kWh' } },
        x: { grid: { display: false } }
      }
    }
  });
}

// ─── Tramo donut ──────────────────────────────────────────────────────────────
function updateTramoChart() {
  const totP = VIEW_DATA.reduce((s,d) => s + (d.punta_kwh||0), 0);
  const totV = VIEW_DATA.reduce((s,d) => s + (d.valle_kwh||0), 0);
  const totL = VIEW_DATA.reduce((s,d) => s + (d.llano_kwh||0), 0);
  const tot  = totP + totV + totL || 1;

  const pct = v => Math.round(v / tot * 100);

  const ctx = document.getElementById('tramoChart').getContext('2d');
  if (tramoChart) tramoChart.destroy();

  tramoChart = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: ['Punta (cara)', 'Valle (barata)', 'Llano (media)'],
      datasets: [{
        data: [totP, totV, totL],
        backgroundColor: ['rgba(239,68,68,.85)','rgba(16,185,129,.85)','rgba(245,158,11,.85)'],
        borderWidth: 2, borderColor: '#fff'
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { position: 'bottom', labels: { boxWidth: 12, font: { size: 12 } } },
        tooltip: { callbacks: {
          label: ctx => ' ' + ctx.raw.toLocaleString('es-UY') + ' kWh (' + pct(ctx.raw) + '%)'
        }}
      },
      cutout: '60%'
    }
  });

  document.getElementById('tramoPct').innerHTML =
    '<span class="tariff-chip punta">Punta ' + pct(totP) + '%</span>' +
    '<span class="tariff-chip llano">Llano ' + pct(totL) + '%</span>' +
    '<span class="tariff-chip valle">Valle ' + pct(totV) + '%</span>';
}

// ─── Table ────────────────────────────────────────────────────────────────────
// Tariff rates for energy cost estimate (without IVA)
// Punta blended: ~71% hábiles × $12.034 + ~29% no-hábiles × $5.172 ≈ $9.54
const RATE_PUNTA_BLEND = 9.54;
const RATE_VALLE = 2.443;
const RATE_LLANO = 5.172;
const IVA = 1.22;

function estimatedEnergyCost(d) {
  if (!d.punta_kwh && !d.valle_kwh && !d.llano_kwh) return null;
  const varCost = (d.punta_kwh||0) * RATE_PUNTA_BLEND
                + (d.valle_kwh||0) * RATE_VALLE
                + (d.llano_kwh||0) * RATE_LLANO;
  return Math.round(varCost * IVA);
}

function updateTable() {
  const tbody  = document.getElementById('tableBody');
  const avg    = VIEW_DATA.reduce((s,x) => s + x.consumo_kwh, 0) / (VIEW_DATA.length || 1);
  const maxKwh = Math.max(...VIEW_DATA.map(d => d.consumo_kwh), 1);

  _tableMonths = VIEW_DATA.slice().reverse(); // stored for onclick

  const rows = _tableMonths.map((d, i) => {
    const tot  = d.punta_kwh + d.valle_kwh + d.llano_kwh || d.consumo_kwh;
    const bP   = Math.round(d.punta_kwh / tot * 80);
    const bL   = Math.round(d.llano_kwh  / tot * 80);
    const bV   = Math.round(d.valle_kwh  / tot * 80);
    const rate = d.costo_uyu && d.consumo_kwh ? (d.costo_uyu / d.consumo_kwh).toFixed(1) : '–';
    const diff = Math.round((d.consumo_kwh - avg) / avg * 100);
    const cls  = d.consumo_kwh === maxKwh ? 'top-month' : '';
    const estEnergy = estimatedEnergyCost(d);

    const hasTramos = isHistoryRecordInteractive(d);
    const actionAttrs = hasTramos
      ? ' tabindex="0" role="button" data-row-action="1" aria-label="' + getRowLabel(d) + '"' +
        ' onclick="showFacturaForMonth(' + i + ')" onkeydown="onMonthRowKeydown(event, ' + i + ')"'
      : ' tabindex="-1" data-row-action="0" aria-label="' + getRowLabel(d) + '"';
    return '<tr class="' + cls + (d._provisional ? ' tr-provisional' : '') + '"' + actionAttrs +
      (hasTramos ? ' style="cursor:pointer" title="Enter para abrir factura estimada"' : '') + '>' +
      '<td class="month-label">' + MONTHS_FULL[d.mes-1] + ' ' + d.año + '</td>' +
      '<td class="kwh-total">' + d.consumo_kwh.toLocaleString('es-UY') + '</td>' +
      '<td style="color:#b91c1c">' + (d.punta_kwh||'–') + '</td>' +
      '<td style="color:#166534">' + (d.valle_kwh||'–') + '</td>' +
      '<td style="color:#92400e">' + (d.llano_kwh||'–') + '</td>' +
      '<td class="bar-cell"><div class="mini-bar-wrap">' +
        '<div class="mini-bar bar-punta" style="width:' + bP + 'px;height:14px"></div>' +
        '<div class="mini-bar bar-llano"  style="width:' + bL + 'px;height:10px"></div>' +
        '<div class="mini-bar bar-valle"  style="width:' + bV + 'px;height:7px"></div>' +
      '</div></td>' +
      '<td class="cost-cell">' + (d.costo_uyu ? (d._provisional ? '~$' : '$') + d.costo_uyu.toLocaleString('es-UY') : '–') + '</td>' +
      '<td style="color:var(--text-soft)">' + (estEnergy ? '$' + estEnergy.toLocaleString('es-UY') : '–') + '</td>' +
      '<td style="color:var(--text-soft)">$' + rate + '</td>' +
      '<td>' + (diff > 0
        ? '<span class="kpi-badge badge-up">+' + diff + '%</span>'
        : diff < 0
          ? '<span class="kpi-badge badge-down">' + diff + '%</span>'
          : '<span class="kpi-badge badge-neutral">~</span>') + '</td>' +
    '</tr>';
  });
  tbody.innerHTML = rows.join('');
  renderHistoryCards();
  setTableState('info', 'Tabla cargada: ' + _tableMonths.length + ' filas.');
}

function onMonthRowKeydown(event, idx) {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  event.preventDefault();
  showFacturaForRow(idx);
}

function showFacturaForRow(idx) {
  const rows = document.querySelectorAll('#dataTable tbody tr');
  const row = rows[idx];
  if (row) {
    row.focus();
  }
  setActiveMonthSelection(idx);
  showFacturaForMonth(idx);
}

// ─── Factura card renderer ────────────────────────────────────────────────────
// Tariff constants (TRT TRIPLERES17, verified March 2026 invoice)
const TARIFA = { R_PH: 12.034, R_PNH: 5.172, R_V: 2.443, R_L: 5.172,
                 POTENCIA: 416, CARGO_FIJO: 488, ALUMBRADO: 326.22 };

function calcFactura(pKwh, vKwh, lKwh, periodoInicio, periodoFin) {
  const { totDays, habCount, noHabCount } = countBillingDays(periodoInicio, periodoFin);

  const t = TARIFA;
  const pHab   = totDays > 0 ? pKwh * (habCount   / totDays) : 0;
  const pNoHab = totDays > 0 ? pKwh * (noHabCount / totDays) : 0;
  const ePH    = pHab   * t.R_PH;
  const ePNH   = pNoHab * t.R_PNH;
  const eV     = vKwh   * t.R_V;
  const eL     = lKwh   * t.R_L;
  const eTotal = ePH + ePNH + eV + eL;
  const gravable = eTotal + t.POTENCIA;
  const iva      = gravable * 0.22;
  const total    = gravable + iva + t.CARGO_FIJO + t.ALUMBRADO;

  return { pHab, pNoHab, habCount, noHabCount, totDays,
           ePH, ePNH, eV, eL, eTotal, gravable, iva, total };
}

function renderFacturaCard(opts) {
  const { pHab, pNoHab, habCount, noHabCount,
          pKwh, vKwh, lKwh, ePH, ePNH, eV, eL, eTotal, gravable, iva, total,
          periodo_inicio, periodo_fin, dias_count, costo_real, label, is_current } = opts;

  const t = TARIFA;
  const fmt     = n => '$\u202f' + Math.round(n).toLocaleString('es-UY');
  const fmtKwh  = n => (+n).toLocaleString('es-UY', {maximumFractionDigits: 1});
  const fmtRate = n => '$' + n.toFixed(3).replace('.', ',');

  const fRow = (cls, desc, kwh, rate, amt) =>
    '<tr class="' + cls + '">' +
      '<td class="fc-desc">' + desc + '</td>' +
      '<td class="fc-kwh">'  + (kwh  || '') + '</td>' +
      '<td class="fc-rate">' + (rate || '') + '</td>' +
      '<td class="fc-amt">'  + amt + '</td>' +
    '</tr>';
  const fHdr = label2 =>
    '<tr class="fhd"><td colspan="4">' + label2 + '</td></tr>';

  // Comparison badges
  const lastHist = ALL_DATA.filter(r => !r._provisional).slice(-1)[0];
  const cmpKwh   = lastHist ? lastHist.consumo_kwh : null;
  const cmpCost  = lastHist ? lastHist.costo_uyu   : null;
  const cmpMes   = lastHist ? (MONTHS_FULL[lastHist.mes-1] + ' ' + lastHist.año) : '';
  const totalKwh = pKwh + vKwh + lKwh;

  // For current period: project to full month so comparisons are apples-to-apples
  let projTotal = null, projKwh = null;
  if (is_current && dias_count > 0) {
    const [piD0, piM0, piY0] = periodo_inicio.split('-').map(Number);
    const pS0 = new Date(piY0, piM0 - 1, piD0);
    const pE0 = piM0 === 12 ? new Date(piY0 + 1, 0, piD0) : new Date(piY0, piM0, piD0);
    const totD0 = Math.round((pE0 - pS0) / 86400000);
    const f = totD0 / dias_count;
    const projP = pKwh * f;
    const projV = vKwh * f;
    const projL = lKwh * f;
    projTotal   = Math.round(calcFactura(projP, projV, projL, periodo_inicio, formatPortalDate(pE0)).total);
    projKwh     = Math.round(totalKwh * f);
  }

  // Use projected values for current period comparisons; nothing for historical (real cost badge covers it)
  const compTotal = is_current ? projTotal : null;
  const compKwh   = is_current ? projKwh   : null;
  const diffCost  = (compTotal != null && cmpCost) ? Math.round(compTotal - cmpCost) : null;
  const pctCost   = (diffCost  != null && cmpCost) ? Math.round(diffCost / cmpCost * 100) : null;
  const diffKwh   = (compKwh   != null && cmpKwh)  ? Math.round(compKwh  - cmpKwh)  : null;
  const pctKwh    = (diffKwh   != null && cmpKwh)  ? Math.round(diffKwh  / cmpKwh   * 100) : null;

  const mkBadge = (diff, pct, suffix) => diff == null ? '' :
    '<span class="factura-cmp-badge" style="background:' +
    (diff > 0 ? '#fee2e2;color:#b91c1c' : '#dcfce7;color:#166534') + '">' +
    (diff > 0 ? '↑' : '↓') + ' ' + Math.abs(diff).toLocaleString('es-UY') + suffix +
    (pct != null ? ' (' + Math.abs(pct) + '%)' : '') + ' vs ' + cmpMes + '</span>';

  // Projection badge shown only for current period
  const projBadge = (is_current && projTotal)
    ? '<span class="factura-cmp-badge" style="background:#eff6ff;color:#1d4ed8">📈 Proyección fin de período: $ ' +
      projTotal.toLocaleString('es-UY') + ' (~' + projKwh.toLocaleString('es-UY') + ' kWh)</span>'
    : '';

  // If real cost is known, show comparison
  let realCompar = '';
  if (costo_real > 0) {
    const diff = Math.round(costo_real - total);
    realCompar = '<span class="factura-cmp-badge" style="background:#eff6ff;color:#1d4ed8">Factura real: ' +
      fmt(costo_real) + ' (' + (diff >= 0 ? '+' : '') + fmt(diff) + ' vs estimado)</span>';
  }

  const noteText = is_current
    ? 'Estimación basada en ' + (dias_count || 0) + ' días de datos · Split punta por días hábiles/no hábiles del período · No considera feriados'
    : 'Estimación basada en datos del portal · Split punta proporcional a días hábiles/no hábiles · No considera feriados';

  // Build month selector options from ALL_DATA (newest first)
  const monthOpts = ALL_DATA.slice().reverse().map((d, i) => {
    const sel = (!is_current && label === MONTHS_FULL[d.mes-1] + ' ' + d.año) ? ' selected' : '';
    const hasT = (d.punta_kwh||0)+(d.valle_kwh||0)+(d.llano_kwh||0) > 0;
    return hasT ? '<option value="hist:' + i + '"' + sel + '>' + MONTHS_FULL[d.mes-1] + ' ' + d.año + (d._provisional ? ' (prov.)' : '') + '</option>' : '';
  }).join('');
  const currentOpt = is_current ? ' selected' : '';
  const monthSelector =
    '<select id="facturaMonthSel" onchange="onFacturaMonthChange(this.value)" style="margin-left:10px;padding:3px 8px;border-radius:8px;border:1px solid var(--border);font-size:.82rem;background:#fff;cursor:pointer">' +
      '<option value="current"' + currentOpt + '>⚡ Período actual</option>' +
      monthOpts +
    '</select>';

  document.getElementById('facturaEstimada').innerHTML =
    '<div class="factura-card">' +
      '<div class="factura-hdr">' +
        '<div class="factura-hdr-left">' +
          '<h3>📄 FACTURA ESTIMADA' + monthSelector + '</h3>' +
          '<p>${DISPLAY_CONTEXT.accountLabel} · ${DISPLAY_CONTEXT.tariffLabel} · ' + periodo_inicio + ' – ' + periodo_fin + '</p>' +
        '</div>' +
        '<span class="factura-badge">' + (is_current ? 'PERÍODO ACTUAL' : 'HISTORIAL') + ' · ESTIMACIÓN</span>' +
      '</div>' +
      '<table class="ftable">' +
        '<colgroup><col class="fc-desc"><col class="fc-kwh"><col class="fc-rate"><col class="fc-amt"></colgroup>' +
        '<thead><tr style="background:#f1f5f9">' +
          '<td class="fc-desc" style="font-size:.72rem;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:#64748b;padding:7px 16px">Concepto</td>' +
          '<td class="fc-kwh"  style="font-size:.72rem;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:#64748b;padding:7px 16px">kWh</td>' +
          '<td class="fc-rate" style="font-size:.72rem;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:#64748b;padding:7px 16px">Precio/kWh</td>' +
          '<td class="fc-amt"  style="font-size:.72rem;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:#64748b;padding:7px 16px">Importe</td>' +
        '</tr></thead>' +
        '<tbody>' +
          fHdr('⚡ ENERGÍA CONSUMIDA (sin IVA)') +
          fRow('frow-punta',    'Punta días hábiles (' + habCount + ' días del período)',       fmtKwh(pHab),   fmtRate(t.R_PH),  fmt(ePH))  +
          fRow('frow-punta-nh', 'Punta días no hábiles (' + noHabCount + ' días del período)',  fmtKwh(pNoHab), fmtRate(t.R_PNH), fmt(ePNH)) +
          fRow('frow-llano',    'Llano (08:00–17:30 + 22:30–00:00 h)',                          fmtKwh(lKwh),   fmtRate(t.R_L),   fmt(eL))   +
          fRow('frow-valle',    'Valle (00:00–08:00 h · todos los días)',                        fmtKwh(vKwh),   fmtRate(t.R_V),   fmt(eV))   +
          fRow('frow-sub',      'Subtotal energía',  fmtKwh(totalKwh), '', fmt(eTotal)) +
          fHdr('📋 BASE GRAVABLE + IVA') +
          fRow('frow-fixed', 'Potencia contratada (5 kW × $83,20) — gravable', '', '', fmt(t.POTENCIA)) +
          fRow('frow-grav',  'Base gravable (energía + potencia)', '', '', fmt(gravable)) +
          fRow('frow-iva',   'IVA 22% sobre base gravable',         '', '', fmt(iva))      +
          fHdr('🏠 CARGOS FIJOS (no gravables)') +
          fRow('frow-nongrav', 'Cargo fijo conexión', '', '', fmt(t.CARGO_FIJO)) +
          fRow('frow-nongrav', 'Alumbrado público',   '', '', fmt(t.ALUMBRADO))  +
          '<tr class="frow-total"><td class="fc-desc">TOTAL ESTIMADO</td><td class="fc-kwh"></td><td class="fc-rate"></td><td class="fc-amt">' + fmt(total) + '</td></tr>' +
        '</tbody>' +
      '</table>' +
      '<div class="factura-footer">' +
        '<span>⚠ ' + noteText + '</span>' +
        '<div class="factura-cmp">' + realCompar + projBadge + mkBadge(diffCost, pctCost, ' $UYU proyectado') + mkBadge(diffKwh, pctKwh, ' kWh proyectados') + '</div>' +
      '</div>' +
    '</div>';
}

let _lastCurrentData = null; // saved for resetFactura()

function resetFactura() {
  if (_lastCurrentData) {
    document.querySelectorAll('.data-table tr.tr-selected').forEach(r => r.classList.remove('tr-selected'));
    renderFacturaCard(_lastCurrentData);
    setActiveMonthSelection(-1);
  }
}

function onFacturaMonthChange(val) {
  if (val === 'current') {
    resetFactura();
  } else if (val.startsWith('hist:')) {
    // index into ALL_DATA reversed (same order as the selector options)
    const i = parseInt(val.split(':')[1]);
    const d = ALL_DATA.slice().reverse()[i];
    if (!d) return;
    // find index in _tableMonths to highlight table row
    const tIdx = _tableMonths.findIndex(m => m.mes === d.mes && m.año === d.año);
    if (tIdx >= 0) showFacturaForMonth(tIdx);
    else {
      // not in current view — show anyway without table highlight
      const prevMes = d.mes === 1 ? 12 : d.mes - 1;
      const prevAño = d.mes === 1 ? d.año - 1 : d.año;
      const pi = d._periodo_inicio || ('27-' + String(prevMes).padStart(2,'0') + '-' + prevAño);
      const pf = d._periodo_fin || ('27-' + String(d.mes).padStart(2,'0')   + '-' + d.año);
      const calc = calcFactura(d.punta_kwh||0, d.valle_kwh||0, d.llano_kwh||0, pi, pf);
      renderFacturaCard({ ...calc, pKwh: d.punta_kwh||0, vKwh: d.valle_kwh||0, lKwh: d.llano_kwh||0,
        periodo_inicio: pi, periodo_fin: pf, dias_count: null, costo_real: d._provisional ? 0 : (d.costo_uyu||0),
        label: MONTHS_FULL[d.mes-1] + ' ' + d.año, is_current: false });
    }
  }
}

function showFacturaForMonth(idx) {
  const d = _tableMonths[idx];
  if (!d) return;
  if (!isHistoryRecordInteractive(d)) return;

  // Derive period dates: billing period ends on the 27th of the month (fecha)
  // and starts on the 27th of the previous month
  const prevMes = d.mes === 1 ? 12 : d.mes - 1;
  const prevAño = d.mes === 1 ? d.año - 1 : d.año;
  const periodoInicio = d._periodo_inicio || ('27-' + String(prevMes).padStart(2, '0') + '-' + prevAño);
  const periodoFin    = d._periodo_fin || ('27-' + String(d.mes).padStart(2, '0')   + '-' + d.año);

  const pKwh = d.punta_kwh || 0;
  const vKwh = d.valle_kwh || 0;
  const lKwh = d.llano_kwh || 0;

  if (pKwh + vKwh + lKwh === 0) {
    document.getElementById('facturaEstimada').innerHTML =
      '<div class="factura-card"><div style="padding:20px;color:var(--text-soft)">' +
      '⚠ Sin datos de tramos (Punta/Valle/Llano) para ' + MONTHS_FULL[d.mes-1] + ' ' + d.año +
      '. Ejecutá <code>node ute_monitor.js download</code> para obtenerlos.</div></div>';
    document.getElementById('facturaEstimada').scrollIntoView({ behavior: 'smooth', block: 'start' });
    return;
  }

  const calc = calcFactura(pKwh, vKwh, lKwh, periodoInicio, periodoFin);

  // Highlight selected row
  document.querySelectorAll('.data-table tr.tr-selected').forEach(r => r.classList.remove('tr-selected'));
  const rows = document.querySelectorAll('.data-table tbody tr');
  if (rows[idx]) rows[idx].classList.add('tr-selected');
  setActiveMonthSelection(idx);

  renderFacturaCard({
    ...calc,
    pKwh, vKwh, lKwh,
    periodo_inicio: periodoInicio,
    periodo_fin:    periodoFin,
    dias_count:     null,
    costo_real:     d._provisional ? 0 : (d.costo_uyu || 0),
    label:          MONTHS_FULL[d.mes - 1] + ' ' + d.año,
    is_current:     false,
  });

  document.getElementById('facturaEstimada').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ─── Current period ───────────────────────────────────────────────────────────
let dailyChart = null;

function buildCurrentAgeLabel(ageMin) {
  if (ageMin < 60) return '🕐 Actualizado hace ' + ageMin + ' min';
  if (ageMin < 1440) return '🕐 Actualizado hace ' + Math.round(ageMin / 60) + ' h';
  return '🕐 Actualizado hace ' + Math.round(ageMin / 1440) + ' días';
}

function getBillingCycleTotalDays(periodoInicio) {
  const [d, m, y] = String(periodoInicio || '').split('-').map(Number);
  const start = new Date(y, (m || 1) - 1, d || 1);
  const end = m === 12 ? new Date(y + 1, 0, d) : new Date(y, m, d);
  return Math.max(1, Math.round((end - start) / 86400000));
}

function renderDailyPeriodContent(d, opts = {}) {
  const content = document.getElementById('currentContent');
  const isCurrent = !!opts.isCurrent;
  const fallbackPrevRecord = opts.fallbackPrevRecord || null;
  const prevShadow = buildPreviousPeriodShadow(d, fallbackPrevRecord);
  const diasData = (d.dias || []).length;
  const totalDays = getBillingCycleTotalDays(d.periodo_inicio);
  const diasLeft = Math.max(0, totalDays - diasData);
  const avgDaily = diasData > 0 ? (d.consumo_kwh || 0) / diasData : 0;
  const projKwh = Math.round(avgDaily * totalDays);
  const pPct = d.consumo_kwh > 0 ? (d.punta_kwh || 0) / d.consumo_kwh : 0.2;
  const vPct = d.consumo_kwh > 0 ? (d.valle_kwh || 0) / d.consumo_kwh : 0.3;
  const lPct = d.consumo_kwh > 0 ? (d.llano_kwh || 0) / d.consumo_kwh : 0.5;
  const cycleEnd = (() => {
    const [day, month, year] = String(d.periodo_inicio || '').split('-').map(Number);
    if (!day || !month || !year) return d.periodo_fin;
    const end = month === 12 ? new Date(year + 1, 0, day) : new Date(year, month, day);
    return formatPortalDate(end);
  })();
  const projCost = Math.round(calcFactura(
    projKwh * pPct,
    projKwh * vPct,
    projKwh * lPct,
    d.periodo_inicio,
    cycleEnd
  ).total);
  const estCost = Math.round(calcFactura(
    d.punta_kwh || 0,
    d.valle_kwh || 0,
    d.llano_kwh || 0,
    d.periodo_inicio,
    d.periodo_fin
  ).total);

  const fmtKwh = n => Number(n || 0).toLocaleString('es-UY', { maximumFractionDigits: 1 });
  const sectionLabel = opts.recordLabel || 'Período actual';

  const daysMissing = Math.max(0, totalDays - diasData);
  document.getElementById('currentPeriod').textContent = isCurrent
    ? 'Período actual: ' + d.periodo_inicio + ' → ' + d.periodo_fin +
      ' · ' + diasData + ' días con datos · ' + (daysMissing > 0 ? ('faltan ' + daysMissing + ' días') : 'ciclo completo') +
      ' (UTE publica con ~48h de retraso)'
    : sectionLabel + ' · ' + d.periodo_inicio + ' → ' + d.periodo_fin +
      ' · ' + diasData + ' días de detalle diario';
  document.getElementById('cacheLabel').textContent = opts.statusLabel || '';

  const tramoHtml = [
    {
      label: 'Punta',
      val: d.punta_kwh,
      prevVal: prevShadow ? prevShadow.prevPuntaToDate : null,
      cls: 'punta'
    },
    {
      label: 'Llano',
      val: d.llano_kwh,
      prevVal: prevShadow ? prevShadow.prevLlanoToDate : null,
      cls: 'llano'
    },
    {
      label: 'Valle',
      val: d.valle_kwh,
      prevVal: prevShadow ? prevShadow.prevValleToDate : null,
      cls: 'valle'
    }
  ].map(t => {
    const currentVal = t.val || 0;
    const prevVal = t.prevVal || 0;
    const diffPct = prevVal > 0 ? Math.round((currentVal - prevVal) / prevVal * 100) : 0;
    const diffText = t.prevVal == null
      ? ''
      : (diffPct > 0 ? '+' : '') + diffPct + '% vs ' + (isCurrent ? 'ref. previa' : 'período anterior');
    const title = t.prevVal == null
      ? ''
      : ' title="Referencia previa: ~' + prevVal.toLocaleString('es-UY', { maximumFractionDigits: 1 }) + ' kWh"';
    return (
      '<div class="tramo-badge tramo-' + t.cls + '">' +
        '<div class="tramo-label">' + t.label + '</div>' +
        '<div class="tramo-value">' + fmtKwh(t.val) + ' <span style="font-size:.8rem;font-weight:400">kWh</span></div>' +
        (diffText ? '<div class="tramo-compare"' + title + '>' + diffText + '</div>' : '') +
      '</div>'
    );
  }).join('');

  const summaryHtml = isCurrent
    ? (diasData > 2 ? (
        '<div class="proj-row">' +
          '<div class="proj-item"><span class="proj-label">Consumo proyectado</span><span class="proj-value accent">~' + projKwh.toLocaleString('es-UY') + ' kWh</span></div>' +
          '<div class="proj-item"><span class="proj-label">Costo proyectado</span><span class="proj-value accent">~$' + projCost.toLocaleString('es-UY') + '</span></div>' +
          '<div class="proj-item"><span class="proj-label">Promedio diario</span><span class="proj-value">' + avgDaily.toFixed(1) + ' kWh/día</span></div>' +
          '<div class="proj-item"><span class="proj-label">Días restantes</span><span class="proj-value">' + diasLeft + ' días</span></div>' +
        '</div>' +
        '<p class="proj-note">Proyección lineal · ' + diasData + ' días con datos de ' + totalDays + ' totales en el período · contempla feriados nacionales confirmados</p>'
      ) : '')
    : (
        '<div class="proj-row">' +
          '<div class="proj-item"><span class="proj-label">Consumo total</span><span class="proj-value accent">' + fmtKwh(d.consumo_kwh) + ' kWh</span></div>' +
          '<div class="proj-item"><span class="proj-label">Costo estimado</span><span class="proj-value">~$' + estCost.toLocaleString('es-UY') + '</span></div>' +
          '<div class="proj-item"><span class="proj-label">Promedio diario</span><span class="proj-value">' + avgDaily.toFixed(1) + ' kWh/día</span></div>' +
          '<div class="proj-item"><span class="proj-label">Días del detalle</span><span class="proj-value">' + diasData + ' días</span></div>' +
        '</div>' +
        '<p class="proj-note">Detalle diario real del portal para ' + sectionLabel.toLowerCase() + '.</p>'
      );

  const compareHtml = prevShadow ? (
    '<div class="current-compare">' +
      '<div class="current-compare-head">' +
        '<div class="current-compare-title">' + (isCurrent ? 'Lectura rápida vs período anterior' : 'Comparación vs período anterior') + '</div>' +
        '<div class="current-compare-ref">' + prevShadow.compareDays + ' días comparados · ' +
          (prevShadow.hasActualDailySeries ? 'referencia real ' : 'referencia prorrateada ') +
          prevShadow.prevMeta.label + '</div>' +
      '</div>' +
      '<div class="current-compare-grid">' +
        '<div class="current-compare-item">' +
          '<div class="current-compare-label">' + (isCurrent ? 'Hoy acumulado' : 'Período seleccionado') + '</div>' +
          '<div class="current-compare-value current-compare-accent">' + fmtKwh(prevShadow.currentToDate) + ' kWh</div>' +
        '</div>' +
        '<div class="current-compare-item">' +
          '<div class="current-compare-label">' + (isCurrent ? 'Mes pasado a esta altura' : 'Período anterior') + '</div>' +
          '<div class="current-compare-value">~' + fmtKwh(prevShadow.prevToDate) + ' kWh</div>' +
        '</div>' +
        '<div class="current-compare-item">' +
          '<div class="current-compare-label">Cambio</div>' +
          '<div class="current-compare-value">' + (prevShadow.diffPct > 0 ? '+' : '') + prevShadow.diffPct + '%</div>' +
        '</div>' +
        '<div class="current-compare-item">' +
          '<div class="current-compare-label">' + (isCurrent ? 'Costo proyectado' : 'Costo estimado') + '</div>' +
          '<div class="current-compare-value">' + (isCurrent ? '~$' + projCost.toLocaleString('es-UY') : '~$' + estCost.toLocaleString('es-UY')) + '</div>' +
        '</div>' +
      '</div>' +
      '<div class="current-compare-note">' +
        (prevShadow.hasActualDailySeries
          ? 'La barra gris detrás de la azul usa la curva real del período anterior, día por día.'
          : 'La barra gris detrás de la azul marca el ritmo promedio diario equivalente del período anterior.') +
      '</div>' +
    '</div>'
  ) : '';

  const labels = (d.dias || []).map(x => x.fecha);
  const vals = (d.dias || []).map(x => x.kwh);
  const prevDailyShadow = prevShadow
    ? labels.map((_, i) => {
        if (prevShadow.prevDailySeries && prevShadow.prevDailySeries[i] != null) return prevShadow.prevDailySeries[i];
        return prevShadow.prevDailyAvg;
      })
    : [];

  content.innerHTML =
    '<div class="tramo-grid">' + tramoHtml + '</div>' +
    summaryHtml +
    '<div class="chart-daily-container"><canvas id="dailyChart"></canvas></div>' +
    compareHtml;

  const ctx = document.getElementById('dailyChart').getContext('2d');
  if (dailyChart) dailyChart.destroy();
  dailyChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [
        ...(prevShadow ? [{
          label: 'Shadow período anterior',
          data: prevDailyShadow,
          grouped: false,
          backgroundColor: 'rgba(148,163,184,.26)',
          borderColor: 'rgba(148,163,184,.42)',
          borderWidth: 1,
          borderRadius: 4,
          borderSkipped: false,
          barThickness: 24,
          order: 1
        }] : []),
        {
          label: isCurrent ? 'Período actual' : 'Período seleccionado',
          data: vals,
          grouped: false,
          backgroundColor: 'rgba(37,99,235,.82)',
          borderRadius: 4,
          borderSkipped: false,
          barThickness: 16,
          order: 2
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          display: !!prevShadow,
          position: 'bottom',
          labels: { boxWidth: 12, font: { size: 11 } }
        },
        tooltip: {
          callbacks: {
            label: ctx => {
              const prefix = String(ctx.dataset.label).includes('Shadow')
                ? (prevShadow && prevShadow.hasActualDailySeries ? ' Ref. período anterior: ' : ' Ref. promedio previa: ')
                : ' Consumo: ';
              return prefix + Number(ctx.raw).toLocaleString('es-UY', { maximumFractionDigits: 1 }) + ' kWh';
            }
          }
        }
      },
      scales: {
        y: {
          beginAtZero: true,
          grid: { color: '#eef2f7' },
          ticks: { callback: v => v.toLocaleString('es-UY') + ' kWh' }
        },
        x: { grid: { display: false } }
      }
    }
  });
}

async function onDailyPeriodChange(value) {
  ACTIVE_DAILY_PERIOD = value;
  await loadSelectedDailyPeriod();
}

async function loadSelectedDailyPeriod(force = false) {
  const content = document.getElementById('currentContent');
  const sel = document.getElementById('dailyPeriodSel');
  const selected = ACTIVE_DAILY_PERIOD || 'current';
  const requestId = ++dailyDetailRequestId;

  if (selected === 'current') {
    if (!CURRENT_DATA) {
      content.innerHTML = '<div class="current-loading">Conectando con el portal UTE…</div>';
      return;
    }
    const lastConfirmed = ALL_DATA.filter(r => !r._provisional).slice(-1)[0] || ALL_DATA[ALL_DATA.length - 1] || null;
    renderDailyPeriodContent(CURRENT_DATA, {
      isCurrent: true,
      recordLabel: 'Período actual',
      statusLabel: buildCurrentAgeLabel(CURRENT_DATA.age_minutes || 0),
      fallbackPrevRecord: lastConfirmed
    });
    return;
  }

  const record = getPeriodRecordByKey(selected);
  if (!record) {
    ACTIVE_DAILY_PERIOD = 'current';
    if (sel) sel.value = 'current';
    return loadSelectedDailyPeriod(force);
  }

  if (!force && DAILY_DETAIL_CACHE[selected]) {
    renderDailyPeriodContent(DAILY_DETAIL_CACHE[selected], {
      isCurrent: false,
      recordLabel: MONTHS_FULL[record.mes - 1] + ' ' + record.año + (record._provisional ? ' (prov.)' : ''),
      statusLabel: getPeriodDetailStatusLabel(DAILY_DETAIL_CACHE[selected]),
      fallbackPrevRecord: getPreviousRecord(record)
    });
    return;
  }

  const bounds = getPeriodBounds(record);
  if (sel) sel.disabled = true;
  content.innerHTML = '<div class="current-loading">Cargando detalle diario guardado de ' +
    MONTHS_FULL[record.mes - 1] + ' ' + record.año + '…</div>';

  try {
    const url = apiUrl('api/period-detail?start=' + encodeURIComponent(bounds.start) + '&end=' + encodeURIComponent(bounds.end));
    const data = await fetch(url).then(r => r.json());
    if (requestId !== dailyDetailRequestId) return;
    if (data.error) throw new Error(data.error);
    DAILY_DETAIL_CACHE[selected] = data;
    renderDailyPeriodContent(data, {
      isCurrent: false,
      recordLabel: MONTHS_FULL[record.mes - 1] + ' ' + record.año + (record._provisional ? ' (prov.)' : ''),
      statusLabel: getPeriodDetailStatusLabel(data),
      fallbackPrevRecord: getPreviousRecord(record)
    });
  } catch (e) {
    if (requestId !== dailyDetailRequestId) return;
    content.innerHTML = '<div class="current-loading" style="color:#b91c1c">⚠ Ese período todavía no está guardado localmente. ' +
      'Podés volver al período actual o persistirlo con el CLI.</div>';
    document.getElementById('cacheLabel').textContent = '💾 La web ya no consulta UTE para meses cerrados';
  } finally {
    if (requestId === dailyDetailRequestId && sel) sel.disabled = false;
  }
}

async function loadCurrent() {
  const content = document.getElementById('currentContent');
  const currentTrend = document.getElementById('kpiCurrentTrend');
  const currentTooltipBody = document.getElementById('kpiCurrentTooltipBody');
  const estTrend = document.getElementById('kpiEstTrend');
  try {
    if (!(await ensureLoginReady())) return;

    const d = await fetch(apiUrl('api/current')).then(r => r.json());
    if (d.login_required) {
      renderLoginRequired();
      return;
    }
    if (d.error) throw new Error(d.error);

    DAILY_PERIOD_INDEX = await fetch(apiUrl('api/period-detail-index')).then(r => r.json()).catch(() => DAILY_PERIOD_INDEX);
    CURRENT_DATA = d;
    DAILY_DETAIL_CACHE.current = d;
    rebuildAllData();
    populateFilterSelects();
    populateDailyPeriodSelect();
    applyFilter();

    document.getElementById('kpiCurrent').innerHTML =
      '<b>' + (d.consumo_kwh||0).toLocaleString('es-UY', {maximumFractionDigits:1}) + '</b>' +
      '<span class="kpi-unit">kWh</span>';
    document.getElementById('kpiCurrentSub').textContent =
      d.periodo_inicio + ' → ' + d.periodo_fin;

    const lastConfirmed = ALL_DATA.filter(r => !r._provisional).slice(-1)[0] || ALL_DATA[ALL_DATA.length - 1] || null;
    const prevShadow = buildPreviousPeriodShadow(d, lastConfirmed);

    // ── Bill calculation (TRT TRIPLERES17, verified against March 2026 invoice) ──
    // IVA 22% applies ONLY on: energy + potencia. Cargo fijo and alumbrado are NOT gravable.
    // Verified: (energy + potencia) × 1.22 + cargo_fijo + alumbrado = exact total ✓
    const R_PH  = 12.034;  // Punta hábiles $/kWh
    const R_PNH = 5.172;   // Punta no hábiles $/kWh
    const R_V   = 2.443;   // Valle $/kWh
    const R_L   = 5.172;   // Llano $/kWh
    const POTENCIA  = 416; // Potencia 5 kW × $83.20 — gravable
    const CARGO_FIJO= 488; // Cargo fijo conexión — NOT gravable
    const ALUMBRADO = 326.22; // Alumbrado público — NOT gravable

    const { totDays: totDays2, habCount, noHabCount } = countBillingDays(d.periodo_inicio, d.periodo_fin);

    const pKwh = d.punta_kwh || 0;
    const vKwh = d.valle_kwh || 0;
    const lKwh = d.llano_kwh || 0;

    const [piD, piM, piY] = d.periodo_inicio.split('-').map(Number);
    const periodStart = new Date(piY, piM - 1, piD);
    const periodEnd   = piM === 12 ? new Date(piY + 1, 0, piD) : new Date(piY, piM, piD);
    const totalDays   = Math.round((periodEnd - periodStart) / 86400000);
    const diasData    = (d.dias || []).length;
    const diasLeft    = Math.max(0, totalDays - diasData);
    const avgDaily    = diasData > 0 ? d.consumo_kwh / diasData : 0;
    const projKwh     = Math.round(avgDaily * totalDays);
    const pPct = d.consumo_kwh > 0 ? (d.punta_kwh || 0) / d.consumo_kwh : 0.2;
    const vPct = d.consumo_kwh > 0 ? (d.valle_kwh || 0) / d.consumo_kwh : 0.3;
    const lPct = d.consumo_kwh > 0 ? (d.llano_kwh || 0) / d.consumo_kwh : 0.5;
    const projCost = Math.round(calcFactura(
      projKwh * pPct,
      projKwh * vPct,
      projKwh * lPct,
      d.periodo_inicio,
      formatPortalDate(periodEnd)
    ).total);

    // Split punta proportionally by weekday/weekend share of total period
    const pHab   = pKwh * (habCount   / totDays2);
    const pNoHab = pKwh * (noHabCount / totDays2);

    const ePH    = pHab   * R_PH;
    const ePNH   = pNoHab * R_PNH;
    const eV     = vKwh   * R_V;
    const eL     = lKwh   * R_L;
    const eTotal = ePH + ePNH + eV + eL;

    const gravable = eTotal + POTENCIA;
    const iva      = gravable * 0.22;
    const total    = gravable + iva + CARGO_FIJO + ALUMBRADO;

    const fmt     = n => '$\u202f' + Math.round(n).toLocaleString('es-UY');
    const fmtKwh  = n => n.toLocaleString('es-UY', {maximumFractionDigits:1});
    const fmtRate = n => '$' + n.toFixed(3).replace('.', ',');

    // ── KPI card ────────────────────────────────────────────────────────────
    document.getElementById('kpiEstCost').innerHTML = '<b>' + fmt(total) + '</b>';
    document.getElementById('kpiEstSub').innerHTML  =
      'Proyección total del período · hover para desglose ↓';

    if (prevShadow) {
      const fmtKpiKwh = n => n.toLocaleString('es-UY', { maximumFractionDigits: 1 });
      const maxKwh = Math.max(prevShadow.currentToDate, prevShadow.prevToDate, 1);
      const prevWidth = Math.max(6, Math.round(prevShadow.prevToDate / maxKwh * 100));
      const currWidth = Math.max(6, Math.round(prevShadow.currentToDate / maxKwh * 100));
      const diffCls = prevShadow.diffPct > 0 ? 'badge-up' : prevShadow.diffPct < 0 ? 'badge-down' : 'badge-neutral';
      const diffLabel = prevShadow.diffPct > 0
        ? '+' + prevShadow.diffPct + '% vs ritmo previo'
        : prevShadow.diffPct < 0
          ? '-' + Math.abs(prevShadow.diffPct) + '% vs ritmo previo'
          : 'Mismo ritmo previo';
      const prevPartialEnd = new Date(prevShadow.prevMeta.start);
      prevPartialEnd.setDate(prevPartialEnd.getDate() + prevShadow.compareDays);
      const prevAdvanceCost = calcFactura(
        prevShadow.prevPuntaToDate,
        prevShadow.prevValleToDate,
        prevShadow.prevLlanoToDate,
        formatPortalDate(prevShadow.prevMeta.start),
        formatPortalDate(prevPartialEnd)
      ).total;
      const prevCostFull = prevShadow.prevRecord.costo_uyu || 0;
      const sameAdvanceCostDiffPct = prevAdvanceCost > 0
        ? Math.round((total - prevAdvanceCost) / prevAdvanceCost * 100)
        : 0;
      const sameAdvanceCostCls = sameAdvanceCostDiffPct > 0 ? 'badge-up' : sameAdvanceCostDiffPct < 0 ? 'badge-down' : 'badge-neutral';
      const sameAdvanceCostLabel = sameAdvanceCostDiffPct > 0
        ? '+' + sameAdvanceCostDiffPct + '% vs mismo avance'
        : sameAdvanceCostDiffPct < 0
          ? '-' + Math.abs(sameAdvanceCostDiffPct) + '% vs mismo avance'
          : 'Mismo avance que el mes anterior';

      currentTrend.innerHTML =
        '<span class="kpi-badge ' + diffCls + '">' + diffLabel + '</span>' +
        '<span class="kpi-trendnote">' + prevShadow.compareDays + ' días comparados</span>';
      currentTooltipBody.innerHTML =
        '<div class="kpi-shadow-box">' +
          '<div class="kpi-shadow-head">' +
            '<span>Shadow mes anterior</span>' +
            '<span class="kpi-shadow-ref">' + prevShadow.prevMeta.label + '</span>' +
          '</div>' +
          '<div class="kpi-shadow-bars">' +
            '<span class="kpi-shadow-prev" style="width:' + prevWidth + '%"></span>' +
            '<span class="kpi-shadow-current" style="width:' + currWidth + '%"></span>' +
          '</div>' +
          '<div class="kpi-shadow-meta">' +
            '<span>Mes pasado a esta altura: ~' + fmtKpiKwh(prevShadow.prevToDate) + ' kWh</span>' +
            '<span class="kpi-badge ' + diffCls + '">' + diffLabel + '</span>' +
          '</div>' +
          '<div class="kpi-shadow-meta">' +
            '<span class="kpi-shadow-current-val">Actual: ' + fmtKpiKwh(prevShadow.currentToDate) + ' kWh</span>' +
            '<span>Ritmo previo: ' + fmtKpiKwh(prevShadow.prevDailyAvg) + ' kWh/día</span>' +
          '</div>' +
        '</div>' +
        '<div class="tt-note">' +
          (prevShadow.hasActualDailySeries
            ? 'Comparación real día a día contra el período anterior (' + prevShadow.prevMeta.label + ').'
            : 'Comparación prorrateada contra los mismos ' + prevShadow.compareDays + ' días del período anterior.') +
        '</div>';

      estTrend.innerHTML =
        '<span class="kpi-badge ' + sameAdvanceCostCls + '">' + sameAdvanceCostLabel + '</span>' +
        '<span class="kpi-trendnote">Ref. previa: ' + fmt(prevAdvanceCost) + '</span>';

      document.getElementById('ttNote').innerHTML =
        'Período: ' + d.periodo_inicio + ' → ' + d.periodo_fin + ' · ' + (d.dias||[]).length + ' días de datos<br>' +
        'Split punta: proporción días hábiles/no hábiles del período, incluyendo feriados nacionales confirmados 2023-2026<br>' +
        'Comparativa de costo en el KPI: estimado de hoy vs el mismo avance del período anterior. En la lectura rápida de abajo, la proyección se compara contra la última factura cerrada.';
    } else {
      currentTrend.innerHTML = '';
      currentTooltipBody.innerHTML = '<div class="tt-note">Todavía no hay referencia suficiente para comparar contra el período anterior.</div>';
      estTrend.innerHTML = '';
      document.getElementById('ttNote').innerHTML =
        'Período: ' + d.periodo_inicio + ' → ' + d.periodo_fin + ' · ' + (d.dias||[]).length + ' días de datos<br>' +
        'Split punta: proporción días hábiles/no hábiles del período, incluyendo feriados nacionales confirmados 2023-2026';
    }

    document.getElementById('ttBody').innerHTML =
      '<div class="tt-section">Energía consumida</div>' +
      '<div class="tt-row punta"><span class="tt-lbl">Punta hábiles (' + habCount + ' días) · ' + fmtKwh(pHab) + ' kWh × ' + fmtRate(R_PH) + '</span><span class="tt-val">' + fmt(ePH) + '</span></div>' +
      '<div class="tt-row punta"><span class="tt-lbl">Punta no hábiles (' + noHabCount + ' días) · ' + fmtKwh(pNoHab) + ' kWh × ' + fmtRate(R_PNH) + '</span><span class="tt-val">' + fmt(ePNH) + '</span></div>' +
      '<div class="tt-row llano"><span class="tt-lbl">Llano · ' + fmtKwh(lKwh) + ' kWh × ' + fmtRate(R_L) + '</span><span class="tt-val">' + fmt(eL) + '</span></div>' +
      '<div class="tt-row valle"><span class="tt-lbl">Valle · ' + fmtKwh(vKwh) + ' kWh × ' + fmtRate(R_V) + '</span><span class="tt-val">' + fmt(eV) + '</span></div>' +
      '<div class="tt-row sub"><span class="tt-lbl">Subtotal energía</span><span class="tt-val">' + fmt(eTotal) + '</span></div>' +
      '<div class="tt-section">Base gravable + IVA</div>' +
      '<div class="tt-row fixed"><span class="tt-lbl">Potencia contratada 5 kW (gravable)</span><span class="tt-val">' + fmt(POTENCIA) + '</span></div>' +
      '<div class="tt-row sub"><span class="tt-lbl">Base gravable</span><span class="tt-val">' + fmt(gravable) + '</span></div>' +
      '<div class="tt-row iva"><span class="tt-lbl">IVA 22%</span><span class="tt-val">' + fmt(iva) + '</span></div>' +
      '<div class="tt-section">No gravables</div>' +
      '<div class="tt-row fixed"><span class="tt-lbl">Cargo fijo conexión</span><span class="tt-val">' + fmt(CARGO_FIJO) + '</span></div>' +
      '<div class="tt-row fixed"><span class="tt-lbl">Alumbrado público</span><span class="tt-val">' + fmt(ALUMBRADO) + '</span></div>' +
      (prevShadow ? (
        '<div class="tt-section">Comparación rápida</div>' +
        '<div class="tt-row fixed"><span class="tt-lbl">Proyección actual del período</span><span class="tt-val">$' + projCost.toLocaleString('es-UY') + '</span></div>' +
        '<div class="tt-row fixed"><span class="tt-lbl">Factura anterior (' + MONTHS[prevShadow.prevRecord.mes-1] + ' ' + prevShadow.prevRecord.año + ')</span><span class="tt-val">$' + (prevShadow.prevRecord.costo_uyu || 0).toLocaleString('es-UY') + '</span></div>'
      ) : '') +
      '<hr class="tt-hr"><div class="tt-row total"><span class="tt-lbl">TOTAL ESTIMADO</span><span class="tt-val">' + fmt(total) + '</span></div>';

    // ── Factura card ─────────────────────────────────────────────────────────
    _lastCurrentData = {
      pHab, pNoHab, habCount, noHabCount,
      pKwh, vKwh, lKwh,
      ePH, ePNH, eV, eL, eTotal, gravable, iva, total,
      periodo_inicio: d.periodo_inicio,
      periodo_fin:    d.periodo_fin,
      dias_count:     (d.dias || []).length,
      costo_real:     0,
      label:          'Período actual',
      is_current:     true,
    };
    renderFacturaCard(_lastCurrentData);
    await loadSelectedDailyPeriod();

  } catch(e) {
    content.innerHTML = '<div class="current-loading" style="color:#b91c1c">⚠ No se pudo obtener datos: ' + e.message + '</div>';
    document.getElementById('kpiCurrent').innerHTML  = '<span class="kpi-loading">No disponible</span>';
    document.getElementById('kpiCurrentSub').textContent = '';
    currentTrend.innerHTML = '';
    currentTooltipBody.innerHTML = '';
    setTableState('error', 'No se pudo obtener datos del período actual.');
    document.getElementById('kpiEstCost').innerHTML  = '<span class="kpi-loading">No disponible</span>';
    document.getElementById('kpiEstSub').textContent = '';
    estTrend.innerHTML = '';
    document.getElementById('facturaEstimada').innerHTML = '';
  }
}

// ─── Actions ──────────────────────────────────────────────────────────────────
async function waitForSync(job) {
  const s = document.getElementById('refreshStatus');
  const jobId = job?.id;
  if (!jobId) throw new Error('No se recibió el identificador de sincronización');
  const deadline = Date.now() + 10 * 60 * 1000;
  while (Date.now() < deadline) {
    const status = await fetch(apiUrl('api/sync-status')).then(r => r.json()).catch(() => null);
    if (!status || status.id !== jobId) {
      await new Promise(resolve => setTimeout(resolve, 1500));
      continue;
    }
    if (status.status === 'queued' || status.status === 'running') {
      s.textContent = 'Sincronizando: ' + (status.stage || 'procesando') + '…';
      await new Promise(resolve => setTimeout(resolve, 1500));
      continue;
    }
    if (status.status === 'succeeded') {
      s.textContent = '✓ Datos actualizados';
      await init();
      setTimeout(() => { s.textContent = ''; }, 3500);
      return;
    }
    const message = status.error?.message || 'La sincronización no se pudo completar. Revisá los logs del add-on.';
    throw new Error(message);
  }
  throw new Error('La sincronización sigue en curso. Revisá el estado y los logs del add-on.');
}

async function triggerDownload() {
  const s = document.getElementById('refreshStatus');
  if (!(await ensureLoginReady())) return;
  if (SYNC_BUSY) {
    s.textContent = 'Ya hay una sincronización en curso.';
    return;
  }
  SYNC_BUSY = true;
  s.textContent = 'Enviando descarga completa…';
  try {
    const response = await fetch(apiUrl('api/refresh'), { method: 'POST' });
    const body = await response.json().catch(() => ({}));
    if (body.login_required) {
      renderLoginRequired();
      return;
    }
    if (!response.ok) throw new Error(body.error || 'No se pudo aceptar la descarga');
    await waitForSync(body.job);
  } catch(e) {
    s.textContent = 'Error: ' + e.message;
  } finally {
    SYNC_BUSY = false;
  }
}

async function refreshCurrent() {
  const s = document.getElementById('refreshStatus');
  if (!(await ensureLoginReady())) return;
  if (SYNC_BUSY) {
    s.textContent = 'Ya hay una sincronización en curso.';
    return;
  }
  SYNC_BUSY = true;

  s.innerHTML = 'Enviando actualización <span class="spinner"></span>';
  try {
    const response = await fetch(apiUrl('api/refresh-current'), { method: 'POST' });
    const body = await response.json().catch(() => ({}));
    if (body.login_required) {
      renderLoginRequired();
      SYNC_BUSY = false;
      return;
    }
    if (!response.ok) throw new Error(body.error || 'No se pudo aceptar la actualización');
    await waitForSync(body.job);
  } catch(e) {
    s.textContent = 'Error: ' + e.message;
    SYNC_BUSY = false;
    return;
  }

  SYNC_BUSY = false;
}

function runSyncAction(action) {
  const syncMenu = document.getElementById('syncMenu');
  if (syncMenu) syncMenu.open = false;
  if (action === 'full') return triggerDownload();
  return refreshCurrent();
}

init();
</script>
</body>
</html>`;
}
