'use strict';

const fs = require('fs-extra');
const path = require('path');

const {
  discoverPortfolioFromLegacy,
  normalizePortalIdentity,
  sanitizeDiagnostic,
  validatePortalIdentity,
  computeStableKey,
  createSupplyContext,
} = require('./portfolio_contract');
const { getDetailsDir } = require('./period_detail_store');

const SUPPLY_KEY_RE = /^k_[0-9a-f]{16}$/;
const STATE_FILE = 'selected-supply.json';
const PORTFOLIO_FILE = 'portfolio.json';
const MIGRATION_FLAG = 'portfolio-migrated.json';

function isSafeSupplyKey(raw) {
  return SUPPLY_KEY_RE.test(String(raw || ''));
}

function toLegacySingleSupplyKey() {
  return computeStableKey(['legacy', 'single-supply']);
}

function hasCompleteSupplyTechnical(supply) {
  const technical = supply?.technical || {};
  return ['saId', 'spId', 'meterId', 'badge'].every((key) => Boolean(technical[key]));
}

class RuntimeStorage {
  constructor(runtimePaths) {
    this.runtimeRoot = runtimePaths.runtimeRoot || runtimePaths.appRoot || '/tmp/ute-runtime';
    this.dataDir = runtimePaths.dataDir || path.join(this.runtimeRoot, 'data');
    this.legacyDataDir = this.dataDir;
    this.suppliesRoot = path.join(this.runtimeRoot, 'supplies');
    this.portfolioPath = path.join(this.runtimeRoot, PORTFOLIO_FILE);
    this.selectionPath = path.join(this.runtimeRoot, STATE_FILE);
    this.migrationPath = path.join(this.runtimeRoot, MIGRATION_FLAG);
    this._legacyFallbackSupplyKey = toLegacySingleSupplyKey();
  }

  ensureDirs() {
    fs.ensureDirSync(this.runtimeRoot);
    fs.ensureDirSync(this.dataDir);
    fs.ensureDirSync(this.suppliesRoot);
  }

  resolveSupplyKey(raw) {
    const value = String(raw || '').trim();
    if (!isSafeSupplyKey(value)) return null;
    return value;
  }

  getPortfolio() {
    this.ensureDirs();
    const stored = safeReadJson(this.portfolioPath);
    if (stored) {
      const normalized = normalizePortalIdentity(stored);
      const validation = validatePortalIdentity(normalized);
      if (validation.ok) return normalized;
    }
    return null;
  }

  savePortfolio(portfolio) {
    this.ensureDirs();
    const normalized = normalizePortalIdentity(portfolio);
    const validation = validatePortalIdentity(normalized);
    if (!validation.ok) {
      const error = new Error(`Portfolio inválido: ${validation.errors.join(',')}`);
      error.code = 'PORTFOLIO_INVALID';
      throw error;
    }
    atomicWriteJson(this.portfolioPath, normalized);
    const selected = this.loadSelectedSupplyKey();
    const validKeys = new Set(normalized.accounts.flatMap((account) =>
      (account.supplies || []).map((supply) => supply.supplyKey)));
    if (selected && !validKeys.has(selected)) fs.removeSync(this.selectionPath);
    return normalized;
  }

  loadSelectedSupplyKey() {
    const stored = safeReadJson(this.selectionPath);
    const resolved = this.resolveSupplyKey(stored?.supplyKey);
    if (!resolved) return null;
    return resolved;
  }

  setSelectedSupplyKey(supplyKey) {
    this.ensureDirs();
    const resolved = this.resolveSupplyKey(supplyKey);
    if (!resolved) {
      const error = new Error('supplyKey inválido');
      error.code = 'INVALID_SUPPLY_KEY';
      throw error;
    }
    atomicWriteJson(this.selectionPath, { supplyKey: resolved, updatedAt: new Date().toISOString() });
    return resolved;
  }

  removeSupply(supplyKey) {
    const resolved = this.resolveSupplyKey(supplyKey);
    const portfolio = this.getPortfolio();
    if (!resolved || !portfolio) return false;
    let removed = false;
    const accounts = portfolio.accounts.map((account) => {
      const supplies = (account.supplies || []).filter((supply) => {
        if (supply.supplyKey !== resolved) return true;
        removed = true;
        return false;
      });
      return { ...account, supplies };
    }).filter((account) => account.supplies.length);
    if (!removed) return false;
    this.savePortfolio({ ...portfolio, accounts });
    if (this.loadSelectedSupplyKey() === resolved) {
      const remaining = accounts.flatMap((account) => account.supplies || []);
      if (remaining.length === 1) this.setSelectedSupplyKey(remaining[0].supplyKey);
      else fs.removeSync(this.selectionPath);
    }
    return true;
  }

  getOrCreateSelectedSupply(portfolio) {
    if (!portfolio || !Array.isArray(portfolio.accounts) || !portfolio.accounts.length) {
      return null;
    }

    const supplies = (portfolio.accounts || []).flatMap((account) => account.supplies || []);
    const selected = this.loadSelectedSupplyKey();
    if (selected && supplies.some((supply) => supply.supplyKey === selected)) {
      return selected;
    }
    if (selected) fs.removeSync(this.selectionPath);
    // La selección es obligatoria cuando hay más de un suministro. Nunca
    // elegimos silenciosamente el primero: eso puede sincronizar la cuenta
    // equivocada y fue la causa del fallo de la versión single-supply.
    if (supplies.length !== 1) return null;
    this.setSelectedSupplyKey(supplies[0].supplyKey);
    return supplies[0].supplyKey;
  }

  listAllSupplyKeys() {
    const portfolio = this.getPortfolio();
    if (!portfolio) {
      return [];
    }
    return portfolio.accounts.flatMap((account) => account.supplies.map((supply) => supply.supplyKey));
  }

  supplyExists(supplyKey) {
    const normalized = this.resolveSupplyKey(supplyKey);
    if (!normalized) return false;
    const portfolio = this.getPortfolio();
    const all = new Set(this.listAllSupplyKeys());
    return all.has(normalized);
  }

  isSupplySyncReady(supplyKey) {
    const normalized = this.resolveSupplyKey(supplyKey);
    const portfolio = this.getPortfolio();
    if (!normalized || !portfolio) return false;
    const supply = portfolio.accounts
      .flatMap((account) => account.supplies || [])
      .find((candidate) => candidate.supplyKey === normalized);
    return hasCompleteSupplyTechnical(supply);
  }

  getSupplyRoot(supplyKey) {
    const resolved = this.resolveSupplyKey(supplyKey);
    if (!resolved) {
      const error = new Error('supplyKey inválido');
      error.code = 'INVALID_SUPPLY_KEY';
      throw error;
    }
    const supplyRoot = path.join(this.suppliesRoot, resolved);
    fs.ensureDirSync(supplyRoot);
    return supplyRoot;
  }

  getSupplyDataPath(supplyKey) {
    return this.getSupplyRoot(supplyKey);
  }

  getLegacyFallbackPaths() {
    return {
      dataDir: this.legacyDataDir,
      files: [
        path.join(this.legacyDataDir, 'consumo.json'),
        path.join(this.legacyDataDir, 'periodo_actual.json'),
      ],
      periodoDir: path.join(this.legacyDataDir, 'periodos_detalle'),
      periodFilesGlob: getDetailsDir(this.legacyDataDir),
      exportFiles: findExcelFiles(this.legacyDataDir),
    };
  }

  fallbackLegacyProfile() {
    const legacy = this.getLegacyFallbackPaths();
    const hasLegacyData =
      fs.existsSync(legacy.files[0]) ||
      fs.existsSync(legacy.files[1]) ||
      fs.existsSync(legacy.periodoDir) ||
      legacy.exportFiles.length > 0;
    if (!hasLegacyData) return null;

    return discoverPortfolioFromLegacy({
      accountAlias: 'Cuenta personal UTE',
      supplyAlias: 'Suministro principal',
      location: 'Dirección no disponible',
      hasPasswordStored: true,
    });
  }

  ensureSingleSupplyMigration() {
    this.ensureDirs();
    if (this.getPortfolio()) return this.getPortfolio();
    const fallback = this.fallbackLegacyProfile();
    if (!fallback) return null;
    const portfolio = this.savePortfolio(fallback);
    const supplyKey = this.getOrCreateSelectedSupply(portfolio);
    this._migrateLegacyDataToSupply(supplyKey);
    atomicWriteJson(this.migrationPath, {
      completedAt: new Date().toISOString(),
      supplyKey,
      source: 'legacy-single',
      status: 'completed',
    }, { spaces: 2 });
    return portfolio;
  }

  _migrateLegacyDataToSupply(supplyKey) {
    const supplyRoot = this.getSupplyRoot(supplyKey);
    const txStamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const backupRoot = path.join(this.runtimeRoot, '.migrations', `legacy-${txStamp}`);

    const legacy = this.getLegacyFallbackPaths();
    const targets = [
      { from: legacy.files[0], to: path.join(supplyRoot, 'consumo.json') },
      { from: legacy.files[1], to: path.join(supplyRoot, 'periodo_actual.json') },
      { from: legacy.periodoDir, to: getDetailsDir(supplyRoot) },
    ].concat(legacy.exportFiles.map(file => ({ from: file, to: path.join(supplyRoot, path.basename(file)) })));

    if (!targets.some((item) => fs.existsSync(item.from))) return;

    for (const item of targets) {
      if (!fs.existsSync(item.from)) continue;
      if (item.from === legacy.periodoDir && fs.statSync(item.from).isDirectory()) {
        fs.ensureDirSync(item.to);
        fs.copySync(item.from, item.to, { overwrite: true });
      } else if (item.from !== legacy.periodoDir) {
        fs.ensureDirSync(path.dirname(item.to));
        fs.copySync(item.from, item.to, { overwrite: true });
      }
      fs.ensureDirSync(backupRoot);
      if (item.from !== legacy.periodoDir) {
        const backupTarget = path.join(backupRoot, path.basename(item.from));
        fs.ensureDirSync(path.dirname(backupTarget));
        fs.copySync(item.from, backupTarget, { overwrite: true });
      }
    }

    if (fs.existsSync(legacy.periodoDir)) {
      fs.ensureDirSync(path.join(backupRoot, 'periodos_detalle'));
      fs.copySync(legacy.periodoDir, path.join(backupRoot, 'periodos_detalle'), { overwrite: true });
    }
  }

  listSupplyDataFiles(supplyKey) {
    const supplyData = this.getSupplyDataPath(supplyKey);
    return {
      consumo: path.join(supplyData, 'consumo.json'),
      periodoActual: path.join(supplyData, 'periodo_actual.json'),
      periodos: getDetailsDir(supplyData),
      exports: findExcelFiles(supplyData),
    };
  }

  exportDiagnostic(supplyKey) {
    const portfolio = this.getPortfolio();
    const diagnostic = sanitizeDiagnostic(portfolio || {});
    const current = this.getActiveContext(supplyKey);
    return {
      ...diagnostic,
      schemaVersion: '2.0.0',
      selection: {
        hasSelectedSupply: Boolean(current),
        selectedSupplyKey: current?.supplyKey || null,
      },
      activeCapabilities: current
        ? { ...(current.snapshot.supply.capabilities || {}) }
        : null,
    };
  }

  getActiveContext(supplyKey) {
    const portfolio = this.getPortfolio();
    if (!portfolio) {
      return null;
    }

    const resolved = this.resolveSupplyKey(supplyKey || this.loadSelectedSupplyKey());
    if (!resolved) {
      return null;
    }
    const account = portfolio.accounts.find((entry) =>
      (entry.supplies || []).some((supply) => supply.supplyKey === resolved));
    const supply = account?.supplies.find((entry) => entry.supplyKey === resolved);
    if (!account || !supply) return null;
    const canonical = createSupplyContext(portfolio, resolved);
    const portfolioSupplyCount = portfolio.accounts.reduce(
      (count, entry) => count + (entry.supplies || []).length,
      0
    );
    return Object.freeze({
      ...canonical,
      portfolioSupplyCount,
      snapshot: Object.freeze({
        account: Object.freeze({ key: account.accountKey, alias: account.alias, accountNumber: account.accountNumber }),
        supply: Object.freeze({
          key: supply.supplyKey,
          alias: supply.alias,
          location: supply.location,
          technical: Object.freeze({ ...(supply.technical || {}) }),
          capabilities: Object.freeze({ ...(supply.capabilities || {}) }),
        }),
      }),
    });
  }

  clearLegacyForNewSupply(supplyKey) {
    const supplyRoot = this.getSupplyRoot(supplyKey);
    const paths = [
      path.join(supplyRoot, 'consumo.json'),
      path.join(supplyRoot, 'periodo_actual.json'),
      getDetailsDir(supplyRoot),
    ];

    for (const item of paths) {
      if (fs.existsSync(item)) {
        fs.removeSync(item);
      }
    }
  }
}

function pickPreferredSupply(portfolio) {
  for (const account of portfolio.accounts || []) {
    const match = (account.supplies || []).find((supply) => supply && supply.selectedByDefault);
    if (match) return match;
    if (account.supplies && account.supplies.length) return account.supplies[0];
  }
  return null;
}

function findExcelFiles(baseDir) {
  if (!fs.existsSync(baseDir)) return [];
  return fs.readdirSync(baseDir).filter((name) => /^consumo_ute_\d{4}\.xlsx$/i.test(name));
}

function safeReadJson(filePath) {
  try {
    return fs.readJsonSync(filePath);
  } catch (error) {
    return null;
  }
}

function atomicWriteJson(filePath, value) {
  fs.ensureDirSync(path.dirname(filePath));
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeJsonSync(tempPath, value, { spaces: 2 });
  fs.renameSync(tempPath, filePath);
}

module.exports = {
  RuntimeStorage,
  SUPPLY_KEY_RE,
};
