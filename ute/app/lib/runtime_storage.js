'use strict';

const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');

const {
  CURRENT_DISCOVERY_REVISION,
  discoverPortfolioFromLegacy,
  normalizePortalIdentity,
  sanitizeDiagnostic,
  validatePortalIdentity,
  computeStableKey,
  createSupplyContext,
} = require('./portfolio_contract');
const { getDetailsDir, isUsablePeriodDetail } = require('./period_detail_store');

const SUPPLY_KEY_RE = /^k_[0-9a-f]{16}$/;
const STATE_FILE = 'selected-supply.json';
const PORTFOLIO_FILE = 'portfolio.json';
const MIGRATION_FLAG = 'portfolio-migrated.json';
const PORTFOLIO_LOCK_STALE_MS = 10 * 60 * 1000;

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

function hasCompleteMobileApiIdentity(supply) {
  const api = supply?.providers?.mobileApi || {};
  return ['accountId', 'serviceAgreementId', 'servicePointId'].every((key) => Boolean(api[key]));
}

function isSupplyOperational(supply, source) {
  return String(source || '').startsWith('mobile-api')
    ? hasCompleteMobileApiIdentity(supply)
    : hasCompleteSupplyTechnical(supply);
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
    this.portfolioLockPath = path.join(this.runtimeRoot, '.locks', 'portfolio-state.lock');
    this._portfolioLockDepth = 0;
    this._legacyFallbackSupplyKey = toLegacySingleSupplyKey();
  }

  ensureDirs() {
    fs.ensureDirSync(this.runtimeRoot);
    fs.ensureDirSync(this.dataDir);
    fs.ensureDirSync(this.suppliesRoot);
    if (!this._portfolioRecoveryChecked) {
      const release = this._acquirePortfolioStateLock({ throwIfBusy: false });
      if (release) {
        try {
          this._recoverPreparedPortfolioTransactions();
          this._portfolioRecoveryChecked = true;
        } finally {
          release();
        }
      }
    }
  }

  _acquirePortfolioStateLock(options = {}) {
    const throwIfBusy = options.throwIfBusy !== false;
    fs.ensureDirSync(path.dirname(this.portfolioLockPath));
    const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      let fd;
      try {
        fd = fs.openSync(this.portfolioLockPath, 'wx', 0o600);
        fs.writeFileSync(fd, JSON.stringify({ token, pid: process.pid, createdAt: new Date().toISOString() }));
        let released = false;
        return () => {
          if (released) return;
          released = true;
          try { fs.closeSync(fd); } catch (_) {}
          const current = safeReadJson(this.portfolioLockPath);
          if (current?.token === token) {
            try { fs.unlinkSync(this.portfolioLockPath); } catch (_) {}
          }
        };
      } catch (error) {
        if (fd !== undefined) {
          try { fs.closeSync(fd); } catch (_) {}
          try { fs.unlinkSync(this.portfolioLockPath); } catch (_) {}
        }
        if (error.code !== 'EEXIST' || attempt > 0 || !this._clearStalePortfolioStateLock()) {
          if (!throwIfBusy && error.code === 'EEXIST') return null;
          const busy = new Error('Hay otra reparación del portfolio en curso; volvé a intentar en unos segundos.');
          busy.code = error.code === 'EEXIST' ? 'PORTFOLIO_REFRESH_BUSY' : 'PORTFOLIO_LOCK_FAILED';
          throw busy;
        }
      }
    }
    return null;
  }

  _clearStalePortfolioStateLock() {
    if (!fs.existsSync(this.portfolioLockPath)) return true;
    let ageMs = 0;
    try { ageMs = Date.now() - fs.statSync(this.portfolioLockPath).mtimeMs; }
    catch (_) { return false; }
    const lock = safeReadJson(this.portfolioLockPath);
    const pid = Number(lock?.pid || 0);
    if (!lock || pid <= 0) {
      if (ageMs < PORTFOLIO_LOCK_STALE_MS) return false;
      try { fs.unlinkSync(this.portfolioLockPath); return true; }
      catch (_) { return false; }
    }
    let ownerAlive = false;
    if (pid > 0) {
      try { process.kill(pid, 0); ownerAlive = true; }
      catch (error) { ownerAlive = error.code !== 'ESRCH'; }
    }
    // La sección crítica sólo contiene escrituras síncronas muy breves. Un
    // lock que supera el TTL pertenece a una ejecución colgada o a un PID
    // reutilizado después de reiniciar el contenedor, incluso si ese número
    // de PID vuelve a existir.
    if (ownerAlive && ageMs < PORTFOLIO_LOCK_STALE_MS) return false;
    try { fs.unlinkSync(this.portfolioLockPath); return true; }
    catch (_) { return false; }
  }

  _withPortfolioStateLock(callback) {
    if (this._portfolioLockDepth > 0) return callback();
    const release = this._acquirePortfolioStateLock();
    this._portfolioLockDepth += 1;
    try {
      this._recoverPreparedPortfolioTransactions();
      this._portfolioRecoveryChecked = true;
      return callback();
    } finally {
      this._portfolioLockDepth -= 1;
      release();
    }
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

  needsPortfolioRefresh(portfolio = this.getPortfolio()) {
    return Boolean(
      portfolio &&
      portfolio.source === 'ute-portal' &&
      Number(portfolio.discoveryRevision || 0) < CURRENT_DISCOVERY_REVISION
    );
  }

  getPortfolioHealth(portfolio = this.getPortfolio()) {
    const supplies = (portfolio?.accounts || []).flatMap((account) => account.supplies || []);
    const keys = supplies.map((supply) => supply.supplyKey).filter(Boolean);
    const duplicateKeyCount = Math.max(0, keys.length - new Set(keys).size);
    const { duplicateIdentityCount, identityConflictCount } = portfolioIdentityIssues(supplies);
    const incompleteCount = supplies.filter((supply) => !isSupplyOperational(supply, portfolio?.source)).length;
    return {
      supplyCount: supplies.length,
      duplicateKeyCount,
      duplicateIdentityCount,
      identityConflictCount,
      incompleteCount,
      unsafe: duplicateKeyCount > 0 || duplicateIdentityCount > 0 || identityConflictCount > 0,
      contextIncomplete: incompleteCount > 0,
      needsRefresh: this.needsPortfolioRefresh(portfolio),
    };
  }

  savePortfolio(portfolio) {
    this.ensureDirs();
    return this._withPortfolioStateLock(() => this._savePortfolioUnlocked(portfolio));
  }

  _savePortfolioUnlocked(portfolio) {
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

  saveDiscoveredPortfolio(portfolio) {
    this.ensureDirs();
    return this._withPortfolioStateLock(() => {
      const normalized = normalizePortalIdentity(portfolio);
      const validation = validatePortalIdentity(normalized);
      if (!validation.ok) {
        const error = new Error(`Portfolio inválido: ${validation.errors.join(',')}`);
        error.code = 'PORTFOLIO_INVALID';
        throw error;
      }

      assertDiscoveredPortfolioOperable(normalized);
      assertDiscoveredPortfolioIdentitySafe(normalized);
      const previous = safeReadJson(this.portfolioPath);
      const namespaceRecoveryPlan = previous
        ? this._preserveKnownSupplyKeys(previous, normalized)
        : null;
      if (previous) {
        assertPortfolioShrinkSafe(previous, normalized, namespaceRecoveryPlan, this.suppliesRoot);
      }
      assertUniqueSupplyKeys(normalized);
      assertDiscoveredPortfolioIdentitySafe(normalized);
      if (previous && portfoliosEquivalent(previous, normalized)) {
        this.getOrCreateSelectedSupply(normalized);
        return normalized;
      }
      const backup = previous
        ? this._preparePortfolioDiscoveryBackup(previous, normalized, namespaceRecoveryPlan?.manifest || null)
        : null;

      try {
        // El web serializa refresh/sync dentro del proceso y el lock protege el
        // portfolio entre procesos. Esta segunda lectura cierra además la
        // ventana best-effort frente a un escritor externo de datos que no use
        // ese lock. No hay awaits ni otra operación entre este gate y el commit.
        this._assertNamespaceRecoveryUnchanged(namespaceRecoveryPlan);
        const saved = this._savePortfolioUnlocked(normalized);
        this.getOrCreateSelectedSupply(saved);
        if (backup) {
          atomicWriteJson(backup.manifestPath, {
            ...backup.manifest,
            status: 'completed',
            completedAt: new Date().toISOString(),
          });
        }
        return saved;
      } catch (error) {
        if (backup) this._restorePortfolioDiscoveryBackup(backup);
        throw error;
      }
    });
  }

  _preserveKnownSupplyKeys(previous, next) {
    const oldPortfolio = normalizePortalIdentity(previous);
    const oldEntries = oldPortfolio.accounts.flatMap((account) =>
      (account.supplies || []).map((supply) => ({ account, supply })));
    const oldSupplies = oldEntries.map((entry) => entry.supply);
    const nextSupplies = (next.accounts || []).flatMap((account) => account.supplies || []);
    const selected = this.loadSelectedSupplyKey();
    const assignedKeys = new Set();
    const recoveries = [];
    const recoveryGuards = new Map();

    if (oldPortfolio.source === 'legacy-single-supply' && oldSupplies.length === 1 && nextSupplies.length === 1) {
      const legacyKey = oldSupplies[0].supplyKey;
      if (isSafeSupplyKey(legacyKey)) {
        this._migrateLegacyDataToSupply(legacyKey);
        nextSupplies[0].supplyKey = legacyKey;
        assignedKeys.add(legacyKey);
      }
    }

    // Los proveedores no comparten IDs de suministro. La única promoción
    // automática admitida es 1→1 con la misma identidad de cuenta: conserva
    // el namespace y la selección, pero nunca colapsa una cartera múltiple.
    const oldAccount = oldPortfolio.accounts?.[0];
    const nextAccount = next.accounts?.[0];
    const isProviderTransition = oldPortfolio.source !== next.source &&
      oldPortfolio.source !== 'legacy-single-supply' &&
      oldSupplies.length === 1 && nextSupplies.length === 1 &&
      oldAccount?.accountId && oldAccount.accountId === nextAccount?.accountId;
    if (isProviderTransition) {
      const oldKey = oldSupplies[0].supplyKey;
      if (isSafeSupplyKey(oldKey)) {
        nextSupplies[0].supplyKey = oldKey;
        assignedKeys.add(oldKey);
      }
    }

    for (const account of next.accounts || []) {
      for (const supply of account.supplies || []) {
        if (assignedKeys.has(supply.supplyKey)) continue;
        const matches = oldEntries.filter((candidate) =>
          accountScopesStronglyMatch(candidate.account, account) &&
          suppliesRepresentSamePersistentService(candidate.supply, supply));
        const keys = [...new Set(matches.map((candidate) => candidate.supply.supplyKey).filter(Boolean))]
          .filter((key) => !assignedKeys.has(key));
        let chosen = null;

        if (nextSupplies.length === 1) {
          const namespaceRecords = groupSupplyEntriesByNamespace(oldEntries, assignedKeys);
          const competing = [...namespaceRecords.entries()]
            .filter(([, records]) => records.some((candidate) =>
              suppliesMayReferToSameService(candidate.supply, supply)))
            .map(([key, records]) => ({
              key,
              records,
              snapshot: inspectNamespaceData(this.suppliesRoot, key),
            }))
            .filter((entry) => entry.snapshot.populated || entry.snapshot.invalidArtifactCount > 0);

          if (competing.length) {
            const allowPrimaryRotation = competing.length === 1;
            const allStrong = competing.every((entry) => entry.records.every((candidate) =>
              suppliesStronglyMatchCanonicalIdentity(
                candidate.supply,
                supply,
                candidate.account,
                account,
                { allowPrimaryRotation }
              )));
            if (!allStrong) {
              const error = new Error('Los namespaces con datos no prueban de forma unívoca que pertenezcan al suministro descubierto; se conservó el estado anterior.');
              error.code = 'PORTFOLIO_NAMESPACE_CONFLICT';
              throw error;
            }
          }

          // Un falso multicuenta puede haber escrito el mismo suministro en
          // más de un namespace. Sólo adoptamos uno si es equivalente o un
          // superset semántico probado de todos los demás. Así nunca ocultamos
          // meses complementarios ni elegimos entre valores contradictorios.
          const semanticChoice = competing.length
            ? chooseSemanticallySafeNamespace(competing, selected)
            : null;
          if (competing.length && !semanticChoice) {
            const error = new Error('Los namespaces del mismo suministro contienen datos complementarios, contradictorios o inválidos; se conservó el estado anterior.');
            error.code = 'PORTFOLIO_NAMESPACE_CONFLICT';
            throw error;
          }
          chosen = semanticChoice?.winner.key ||
            (selected && keys.includes(selected) ? selected : keys.length === 1 ? keys[0] : null);
          if (semanticChoice) {
            for (const entry of competing) {
              recoveryGuards.set(entry.key, buildNamespaceRecoveryGuard(entry.key, entry.snapshot));
            }
          }
          if (semanticChoice && competing.length > 1) {
            recoveries.push(buildNamespaceRecoverySummary(competing, semanticChoice));
          }
        } else {
          // No ampliamos la reconciliación en portfolios multicuenta reales:
          // conservar el gate anterior evita atribuir datos a otro suministro.
          const scored = keys
            .map((key) => ({ key, score: namespaceDataScore(this.suppliesRoot, key) }))
            .filter((entry) => entry.score > 0);
          if (scored.length > 1) {
            const error = new Error('Hay más de un namespace con datos para el mismo suministro; la reparación se bloqueó para evitar ocultar o mezclar historial.');
            error.code = 'PORTFOLIO_NAMESPACE_CONFLICT';
            throw error;
          }
          chosen = scored[0]?.key || (selected && keys.includes(selected) ? selected : keys.length === 1 ? keys[0] : null);
        }
        if (!chosen) continue;
        supply.supplyKey = chosen;
        assignedKeys.add(chosen);
      }
    }
    return recoveries.length || recoveryGuards.size
      ? {
          manifest: recoveries.length
            ? { resolutionCount: recoveries.length, resolutions: recoveries }
            : null,
          guards: [...recoveryGuards.values()],
        }
      : null;
  }

  _assertNamespaceRecoveryUnchanged(plan) {
    for (const guard of plan?.guards || []) {
      const current = inspectNamespaceData(this.suppliesRoot, guard.key);
      const unchanged =
        current.stateFingerprint === guard.stateFingerprint &&
        current.fingerprint === guard.semanticFingerprint &&
        current.comparable === guard.comparable &&
        current.items.size === guard.evidenceCount &&
        current.invalidArtifactCount === guard.invalidArtifactCount;
      if (unchanged) continue;
      const error = new Error('Los datos de un namespace cambiaron durante la reparación; se restauró el portfolio anterior.');
      error.code = 'PORTFOLIO_NAMESPACE_CHANGED';
      throw error;
    }
  }

  _recoverPreparedPortfolioTransactions() {
    const migrationsRoot = path.join(this.runtimeRoot, '.migrations');
    if (!fs.existsSync(migrationsRoot)) return;
    const candidates = fs.readdirSync(migrationsRoot)
      .filter((name) => name.startsWith('portfolio-discovery-'))
      .sort();
    for (const name of candidates) {
      const backupRoot = path.join(migrationsRoot, name);
      const manifestPath = path.join(backupRoot, 'manifest.json');
      const manifest = safeReadJson(manifestPath);
      if (!manifest || manifest.status !== 'prepared') continue;
      this._restorePortfolioDiscoveryBackup({ backupRoot, manifestPath, manifest }, 'recovered');
    }
  }

  _preparePortfolioDiscoveryBackup(previous, next, namespaceRecovery = null) {
    const txStamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const backupRoot = path.join(this.runtimeRoot, '.migrations', `portfolio-discovery-${txStamp}`);
    fs.ensureDirSync(backupRoot);
    fs.copySync(this.portfolioPath, path.join(backupRoot, PORTFOLIO_FILE), { overwrite: false });
    const selectionExisted = fs.existsSync(this.selectionPath);
    if (selectionExisted) {
      fs.copySync(this.selectionPath, path.join(backupRoot, STATE_FILE), { overwrite: false });
    }
    const manifestPath = path.join(backupRoot, 'manifest.json');
    const manifest = {
      version: 1,
      status: 'prepared',
      createdAt: new Date().toISOString(),
      selectionExisted,
      before: portfolioCounts(previous),
      after: portfolioCounts(next),
      ...(namespaceRecovery ? { namespaceRecovery } : {}),
    };
    atomicWriteJson(manifestPath, manifest);
    return { backupRoot, manifestPath, manifest };
  }

  _restorePortfolioDiscoveryBackup(backup, status = 'rolled_back') {
    const portfolioBackup = path.join(backup.backupRoot, PORTFOLIO_FILE);
    const selectionBackup = path.join(backup.backupRoot, STATE_FILE);
    if (fs.existsSync(portfolioBackup)) {
      atomicWriteJson(this.portfolioPath, fs.readJsonSync(portfolioBackup));
    }
    if (backup.manifest.selectionExisted && fs.existsSync(selectionBackup)) {
      atomicWriteJson(this.selectionPath, fs.readJsonSync(selectionBackup));
    } else {
      fs.removeSync(this.selectionPath);
    }
    atomicWriteJson(backup.manifestPath, {
      ...backup.manifest,
      status,
      rolledBackAt: new Date().toISOString(),
    });
  }

  loadSelectedSupplyKey() {
    const stored = safeReadJson(this.selectionPath);
    const resolved = this.resolveSupplyKey(stored?.supplyKey);
    if (!resolved) return null;
    return resolved;
  }

  setSelectedSupplyKey(supplyKey) {
    this.ensureDirs();
    return this._withPortfolioStateLock(() => this._setSelectedSupplyKeyUnlocked(supplyKey));
  }

  _setSelectedSupplyKeyUnlocked(supplyKey) {
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
    this.ensureDirs();
    return this._withPortfolioStateLock(() => {
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
      this._savePortfolioUnlocked({ ...portfolio, accounts });
      if (this.loadSelectedSupplyKey() === resolved) {
        const remaining = accounts.flatMap((account) => account.supplies || []);
        if (remaining.length === 1) this._setSelectedSupplyKeyUnlocked(remaining[0].supplyKey);
        else fs.removeSync(this.selectionPath);
      }
      return true;
    });
  }

  getOrCreateSelectedSupply(portfolio) {
    this.ensureDirs();
    return this._withPortfolioStateLock(() => {
      const current = safeReadJson(this.portfolioPath);
      return this._getOrCreateSelectedSupplyUnlocked(current ? normalizePortalIdentity(current) : portfolio);
    });
  }

  _getOrCreateSelectedSupplyUnlocked(portfolio) {
    if (!portfolio || !Array.isArray(portfolio.accounts) || !portfolio.accounts.length) {
      return null;
    }

    const supplies = (portfolio.accounts || []).flatMap((account) => account.supplies || []);
    const selected = this.loadSelectedSupplyKey();
    const selectedSupply = selected
      ? supplies.find((supply) => supply.supplyKey === selected)
      : null;
    if (selectedSupply && (portfolio.source === 'legacy-single-supply' || isSupplyOperational(selectedSupply, portfolio.source))) {
      return selected;
    }
    if (selected) fs.removeSync(this.selectionPath);
    // La selección es obligatoria cuando hay más de un suministro. Nunca
    // elegimos silenciosamente el primero: eso puede sincronizar la cuenta
    // equivocada y fue la causa del fallo de la versión single-supply.
    if (supplies.length !== 1) return null;
    if (portfolio.source !== 'legacy-single-supply' && !isSupplyOperational(supplies[0], portfolio.source)) return null;
    this._setSelectedSupplyKeyUnlocked(supplies[0].supplyKey);
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
    return isSupplyOperational(supply, portfolio.source);
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
    return this._withPortfolioStateLock(() => {
      if (this.getPortfolio()) return this.getPortfolio();
      const fallback = this.fallbackLegacyProfile();
      if (!fallback) return null;
      const portfolio = this._savePortfolioUnlocked(fallback);
      const supplyKey = this._getOrCreateSelectedSupplyUnlocked(portfolio);
      this._migrateLegacyDataToSupply(supplyKey);
      atomicWriteJson(this.migrationPath, {
        completedAt: new Date().toISOString(),
        supplyKey,
        source: 'legacy-single',
        status: 'completed',
      }, { spaces: 2 });
      return portfolio;
    });
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
    ].concat(legacy.exportFiles.map(file => ({
      from: path.join(legacy.dataDir, file),
      to: path.join(supplyRoot, path.basename(file)),
    })));

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

function portfolioCounts(portfolio) {
  const accounts = Array.isArray(portfolio?.accounts) ? portfolio.accounts : [];
  return {
    accounts: accounts.length,
    supplies: accounts.reduce((count, account) => count + (Array.isArray(account?.supplies) ? account.supplies.length : 0), 0),
  };
}

function portfoliosEquivalent(left, right) {
  const comparable = (value) => {
    const normalized = normalizePortalIdentity(value);
    return { ...normalized, generatedAt: '' };
  };
  return JSON.stringify(comparable(left)) === JSON.stringify(comparable(right));
}

function assertDiscoveredPortfolioOperable(portfolio) {
  const supplies = (portfolio?.accounts || []).flatMap((account) => account.supplies || []);
  if (!supplies.length || supplies.some((supply) => !isSupplyOperational(supply, portfolio?.source))) {
    const error = new Error('El discovery no produjo contextos técnicos completos; se conservó el portfolio anterior.');
    error.code = 'PORTFOLIO_CONTEXT_INCOMPLETE';
    throw error;
  }
}

function assertDiscoveredPortfolioIdentitySafe(portfolio) {
  const supplies = (portfolio?.accounts || []).flatMap((account) => account.supplies || []);
  const { duplicateIdentityCount, identityConflictCount } = portfolioIdentityIssues(supplies);
  if (identityConflictCount > 0) {
    const error = new Error('El discovery produjo identidades técnicas contradictorias; se conservó el portfolio anterior.');
    error.code = 'PORTFOLIO_IDENTITY_CONFLICT';
    throw error;
  }
  if (duplicateIdentityCount > 0) {
    const error = new Error('El discovery produjo más de una representación de la misma identidad; se conservó el portfolio anterior.');
    error.code = 'PORTFOLIO_IDENTITY_DUPLICATE';
    throw error;
  }
}

function assertUniqueSupplyKeys(portfolio) {
  const keys = (portfolio?.accounts || [])
    .flatMap((account) => account.supplies || [])
    .map((supply) => supply.supplyKey);
  if (new Set(keys).size !== keys.length) {
    const error = new Error('El discovery produjo claves de suministro duplicadas; no se guardó el portfolio.');
    error.code = 'PORTFOLIO_KEY_COLLISION';
    throw error;
  }
}

function assertPortfolioShrinkSafe(previous, next, recoveryPlan, suppliesRoot) {
  const oldPortfolio = normalizePortalIdentity(previous);
  const newPortfolio = normalizePortalIdentity(next);
  const oldSupplies = oldPortfolio.accounts.flatMap((account) => account.supplies || []);
  const newSupplies = newPortfolio.accounts.flatMap((account) => account.supplies || []);

  const nextKeys = new Set(newSupplies.map((supply) => supply.supplyKey).filter(Boolean));
  const recoveredKeys = new Set((recoveryPlan?.guards || []).map((guard) => guard.key));
  const oldNamespaces = groupSupplyEntriesByNamespace(
    oldPortfolio.accounts.flatMap((account) =>
      (account.supplies || []).map((supply) => ({ account, supply })))
  );
  const unexplainedNamespace = [...oldNamespaces.keys()].find((key) => {
    const snapshot = inspectNamespaceData(suppliesRoot, key);
    const hasRecognizedState = snapshot.populated || snapshot.invalidArtifactCount > 0;
    return hasRecognizedState && !nextKeys.has(key) && !recoveredKeys.has(key);
  });
  if (unexplainedNamespace) {
    const error = new Error('La reducción dejaría datos de un namespace sin una correspondencia canónica comprobada; se conservó el portfolio anterior.');
    error.code = 'PORTFOLIO_SHRINK_UNVERIFIED';
    throw error;
  }

  if (newSupplies.length >= oldSupplies.length) return;

  const oldKeys = oldSupplies.map((supply) => supply.supplyKey).filter(Boolean);
  const { duplicateIdentityCount, identityConflictCount } = portfolioIdentityIssues(oldSupplies);
  const oldIsUnsafe =
    new Set(oldKeys).size !== oldKeys.length ||
    duplicateIdentityCount > 0 ||
    identityConflictCount > 0;
  const oldIsIncomplete = oldSupplies.some((supply) => !isSupplyOperational(supply, oldPortfolio.source));
  const oldDiscovery = Number(oldPortfolio.discoveryRevision || 0);
  if (oldDiscovery < CURRENT_DISCOVERY_REVISION || oldIsUnsafe || oldIsIncomplete) return;

  const error = new Error('UTE devolvió menos suministros que el portfolio sano vigente; se conservó el estado anterior hasta confirmar una baja explícita.');
  error.code = 'PORTFOLIO_SHRINK_UNVERIFIED';
  throw error;
}

function suppliesReferToSameIdentity(left, right) {
  const leftTechnical = left?.technical || {};
  const rightTechnical = right?.technical || {};
  const technicalKeys = ['saId', 'spId', 'meterId', 'badge'];
  const conflicts = technicalKeys.some((key) =>
    leftTechnical[key] && rightTechnical[key] && leftTechnical[key] !== rightTechnical[key]);
  if (conflicts) return false;

  const samePrimary = Boolean(
    leftTechnical.saId && leftTechnical.spId &&
    leftTechnical.saId === rightTechnical.saId && leftTechnical.spId === rightTechnical.spId
  );
  const sameSecondary = Boolean(
    leftTechnical.meterId && rightTechnical.meterId &&
    leftTechnical.meterId === rightTechnical.meterId &&
    (!leftTechnical.badge || !rightTechnical.badge || leftTechnical.badge === rightTechnical.badge)
  );
  return samePrimary || sameSecondary;
}

function suppliesRepresentSamePersistentService(left, right) {
  const leftTechnical = left?.technical || {};
  const rightTechnical = right?.technical || {};
  const leftHasPrimary = Boolean(leftTechnical.saId && leftTechnical.spId);
  const rightHasPrimary = Boolean(rightTechnical.saId && rightTechnical.spId);
  if (leftHasPrimary && rightHasPrimary) {
    return leftTechnical.saId === rightTechnical.saId && leftTechnical.spId === rightTechnical.spId;
  }
  return suppliesReferToSameIdentity(left, right);
}

function groupSupplyEntriesByNamespace(entries, excludedKeys = new Set()) {
  const grouped = new Map();
  for (const entry of entries || []) {
    const key = entry?.supply?.supplyKey;
    if (!isSafeSupplyKey(key) || excludedKeys.has(key)) continue;
    const records = grouped.get(key) || [];
    records.push(entry);
    grouped.set(key, records);
  }
  return grouped;
}

function accountScopesStronglyMatch(left, right) {
  const leftNumber = String(left?.accountNumber || '').trim();
  const rightNumber = String(right?.accountNumber || '').trim();
  const leftId = String(left?.accountId || '').trim();
  const rightId = String(right?.accountId || '').trim();
  if (leftNumber && rightNumber && leftNumber !== rightNumber) return false;
  if (leftId && rightId && leftId !== rightId) return false;
  if (leftNumber && rightNumber && leftNumber === rightNumber) return true;
  if (leftId && rightId && leftId === rightId) return true;

  // accountId y accountNumber son namespaces distintos: nunca se comparan
  // entre sí. accountKey sólo sirve como último recurso cuando ninguno de los
  // lados ofrece identificadores de cuenta enriquecibles.
  if (leftNumber || rightNumber || leftId || rightId) return false;
  const leftKey = String(left?.accountKey || '').trim();
  const rightKey = String(right?.accountKey || '').trim();
  return Boolean(leftKey && rightKey && leftKey === rightKey);
}

function suppliesMayReferToSameService(left, right) {
  const leftTechnical = left?.technical || {};
  const rightTechnical = right?.technical || {};
  return ['saId', 'spId', 'meterId', 'badge'].some((key) =>
    Boolean(leftTechnical[key] && rightTechnical[key] && leftTechnical[key] === rightTechnical[key]));
}

function suppliesStronglyMatchCanonicalIdentity(left, right, leftAccount, rightAccount, options = {}) {
  if (!hasCompleteSupplyTechnical(right)) return false;
  if (!accountScopesStronglyMatch(leftAccount, rightAccount)) return false;
  const leftTechnical = left?.technical || {};
  const rightTechnical = right?.technical || {};
  const samePrimary = Boolean(
    leftTechnical.saId && leftTechnical.spId &&
    leftTechnical.saId === rightTechnical.saId && leftTechnical.spId === rightTechnical.spId
  );
  const sameMeter = Boolean(
    leftTechnical.meterId && leftTechnical.meterId === rightTechnical.meterId
  );
  const sameBadge = Boolean(
    leftTechnical.badge && leftTechnical.badge === rightTechnical.badge
  );
  const sameServicePoint = Boolean(
    leftTechnical.spId && leftTechnical.spId === rightTechnical.spId
  );
  if (!samePrimary && !sameMeter && !sameBadge && !sameServicePoint) return false;

  const conflicts = ['saId', 'spId', 'meterId', 'badge'].filter((key) =>
    leftTechnical[key] && rightTechnical[key] && leftTechnical[key] !== rightTechnical[key]);
  if (!conflicts.length) return true;

  // Una sola identidad primaria persistida puede conservar su namespace ante
  // una rotación real de medidor. Esta excepción nunca se usa para colapsar
  // dos namespaces poblados: ese caso exige coincidencia sin conflictos.
  return Boolean(
    options.allowPrimaryRotation && samePrimary &&
    conflicts.every((key) => key === 'meterId' || key === 'badge')
  );
}

function chooseSemanticallySafeNamespace(entries, selected) {
  if (!entries.length) return null;
  if (entries.some((entry) => !entry.snapshot.comparable)) return null;
  if (entries.length === 1) return { winner: entries[0], relation: 'single-populated' };

  const winners = entries.filter((candidate) =>
    entries.every((other) => namespaceSnapshotContains(candidate.snapshot, other.snapshot)));
  if (!winners.length) return null;

  // Dos ganadores sólo pueden existir si son equivalentes. Recién en ese
  // empate semántico se considera la selección previa y luego la key estable.
  winners.sort((left, right) => {
    const leftSelected = left.key === selected ? 1 : 0;
    const rightSelected = right.key === selected ? 1 : 0;
    if (leftSelected !== rightSelected) return rightSelected - leftSelected;
    return left.key.localeCompare(right.key);
  });
  const allEquivalent = entries.every((entry) =>
    namespaceSnapshotContains(entries[0].snapshot, entry.snapshot) &&
    namespaceSnapshotContains(entry.snapshot, entries[0].snapshot));
  return {
    winner: winners[0],
    relation: allEquivalent ? 'equivalent' : 'semantic-superset',
  };
}

function buildNamespaceRecoverySummary(entries, choice) {
  return {
    relation: choice.relation,
    populatedNamespaceCount: entries.length,
    winnerEvidenceCount: choice.winner.snapshot.items.size,
    winnerFingerprint: choice.winner.snapshot.fingerprint,
    candidateEvidenceCounts: entries.map((entry) => entry.snapshot.items.size).sort((a, b) => a - b),
    candidateFingerprints: entries.map((entry) => entry.snapshot.fingerprint).sort(),
  };
}

function buildNamespaceRecoveryGuard(key, snapshot) {
  return {
    // La key se conserva exclusivamente en memoria y nunca se serializa en el
    // manifest de backup. Es necesaria para releer el candidato justo antes
    // del commit.
    key,
    stateFingerprint: snapshot.stateFingerprint,
    semanticFingerprint: snapshot.fingerprint,
    comparable: snapshot.comparable,
    evidenceCount: snapshot.items.size,
    invalidArtifactCount: snapshot.invalidArtifactCount,
  };
}

function portfolioIdentityIssues(supplies) {
  let duplicateIdentityCount = 0;
  let identityConflictCount = 0;
  for (let left = 0; left < supplies.length; left += 1) {
    for (let right = left + 1; right < supplies.length; right += 1) {
      if (suppliesReferToSameIdentity(supplies[left], supplies[right])) duplicateIdentityCount += 1;
      else if (suppliesHaveIdentityConflict(supplies[left], supplies[right])) identityConflictCount += 1;
    }
  }
  return { duplicateIdentityCount, identityConflictCount };
}

function suppliesHaveIdentityConflict(left, right) {
  const leftTechnical = left?.technical || {};
  const rightTechnical = right?.technical || {};
  const samePrimary = Boolean(
    leftTechnical.saId && leftTechnical.spId &&
    leftTechnical.saId === rightTechnical.saId && leftTechnical.spId === rightTechnical.spId
  );
  if (samePrimary) {
    return ['meterId', 'badge'].some((key) =>
      leftTechnical[key] && rightTechnical[key] && leftTechnical[key] !== rightTechnical[key]);
  }
  if (leftTechnical.spId && rightTechnical.spId && leftTechnical.spId === rightTechnical.spId) return true;
  if (leftTechnical.meterId && rightTechnical.meterId && leftTechnical.meterId === rightTechnical.meterId) return true;
  if (leftTechnical.badge && rightTechnical.badge && leftTechnical.badge === rightTechnical.badge) return true;
  return false;
}

function namespaceDataScore(suppliesRoot, supplyKey) {
  return inspectNamespaceData(suppliesRoot, supplyKey).score;
}

function inspectNamespaceData(suppliesRoot, supplyKey) {
  const empty = {
    populated: false,
    comparable: true,
    score: 0,
    items: new Map(),
    fingerprint: semanticHash([]),
    stateFingerprint: semanticHash([]),
    invalidArtifactCount: 0,
  };
  if (!SUPPLY_KEY_RE.test(String(supplyKey || ''))) return empty;
  const root = path.join(suppliesRoot, supplyKey);
  if (!fs.existsSync(root)) return empty;

  const items = new Map();
  let invalidArtifactCount = 0;
  let historyCount = 0;
  let currentCount = 0;
  let detailCount = 0;
  let excelCount = 0;

  const addEvidence = (key, value) => {
    const fingerprint = semanticHash(value);
    if (items.has(key)) {
      // Dos filas para el mismo mes siguen siendo dos filas visibles aunque
      // tengan el mismo contenido. Nunca se colapsan silenciosamente.
      invalidArtifactCount += 1;
      return;
    }
    items.set(key, fingerprint);
  };

  try {
    const historicalPath = path.join(root, 'consumo.json');
    if (fs.existsSync(historicalPath)) {
      const historical = safeReadJson(historicalPath);
      if (Array.isArray(historical)) {
        historical.forEach((row) => {
          if (!isUsableHistoricalRow(row)) {
            invalidArtifactCount += 1;
            return;
          }
          addEvidence(`history:${historicalRowKey(row)}`, semanticValue(row));
          historyCount += 1;
        });
      } else {
        invalidArtifactCount += 1;
      }
    }

    const currentPath = path.join(root, 'periodo_actual.json');
    if (fs.existsSync(currentPath)) {
      const current = safeReadJson(currentPath);
      if (isUsableCurrentSnapshot(current)) {
        addEvidence(
          `current:${String(current.periodo_inicio)}:${String(current.periodo_fin)}`,
          semanticValue(current)
        );
        currentCount += 1;
      } else {
        // Un objeto vacío o snapshot incompleto no es evidencia de datos.
        invalidArtifactCount += 1;
      }
    }

    const detailsDir = path.join(root, 'periodos_detalle');
    if (fs.existsSync(detailsDir)) {
      for (const name of fs.readdirSync(detailsDir).sort()) {
        if (!/^\d{4}-\d{2}\.json$/.test(name)) continue;
        const detail = safeReadJson(path.join(detailsDir, name));
        if (!isUsablePeriodDetail(detail)) {
          invalidArtifactCount += 1;
          continue;
        }
        addEvidence(`detail:${name}`, semanticValue(detail));
        detailCount += 1;
      }
    }

    for (const name of findExcelFiles(root).sort()) {
      const filePath = path.join(root, name);
      let contents;
      try { contents = fs.readFileSync(filePath); }
      catch (_) { invalidArtifactCount += 1; continue; }
      if (!isXlsxZip(contents)) {
        invalidArtifactCount += 1;
        continue;
      }
      addEvidence(`excel:${name}`, crypto.createHash('sha256').update(contents).digest('hex'));
      excelCount += 1;
    }
  } catch (_) {
    invalidArtifactCount += 1;
  }

  const orderedEvidence = [...items.entries()].sort(([left], [right]) => left.localeCompare(right));
  return {
    populated: items.size > 0,
    comparable: invalidArtifactCount === 0,
    score: (historyCount * 1000) + (currentCount * 500) + (detailCount * 10) + (excelCount * 5),
    items,
    fingerprint: semanticHash(orderedEvidence),
    stateFingerprint: recognizedNamespaceStateFingerprint(root),
    invalidArtifactCount,
  };
}

function recognizedNamespaceStateFingerprint(root) {
  if (!fs.existsSync(root)) return semanticHash([]);
  const recognized = [];
  const addFile = (relativePath) => {
    const filePath = path.join(root, relativePath);
    if (!fs.existsSync(filePath)) return;
    try {
      const contents = fs.readFileSync(filePath);
      recognized.push([
        relativePath,
        contents.length,
        crypto.createHash('sha256').update(contents).digest('hex'),
      ]);
    } catch (_) {
      recognized.push([relativePath, 'unreadable']);
    }
  };

  addFile('consumo.json');
  addFile('periodo_actual.json');
  const detailsDir = path.join(root, 'periodos_detalle');
  if (fs.existsSync(detailsDir)) {
    try {
      for (const name of fs.readdirSync(detailsDir).filter((entry) => /^\d{4}-\d{2}\.json$/.test(entry)).sort()) {
        addFile(path.join('periodos_detalle', name));
      }
    } catch (_) {
      recognized.push(['periodos_detalle', 'unreadable']);
    }
  }
  try {
    for (const name of findExcelFiles(root).sort()) addFile(name);
  } catch (_) {
    recognized.push(['excel-files', 'unreadable']);
  }
  return semanticHash(recognized);
}

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function isXlsxZip(contents) {
  return Boolean(
    Buffer.isBuffer(contents) && contents.length >= 4 &&
    contents[0] === 0x50 && contents[1] === 0x4b &&
    contents[2] === 0x03 && contents[3] === 0x04
  );
}

function isUsableHistoricalRow(row) {
  if (!isPlainObject(row)) return false;
  if (!historicalRowKey(row)) return false;
  return ['consumo_kwh', 'kwh', 'punta_kwh', 'valle_kwh', 'llano_kwh']
    .some((key) => isStrictFiniteValue(row[key]));
}

function historicalRowKey(row) {
  const hasFecha = isPlainObject(row) && Object.prototype.hasOwnProperty.call(row, 'fecha');
  if (hasFecha) {
    const parsedDate = parseCalendarDate(String(row.fecha || '').trim());
    if (!parsedDate) return null;
    const hasYearAndMonth = Object.prototype.hasOwnProperty.call(row, 'año') &&
      Object.prototype.hasOwnProperty.call(row, 'mes');
    if (hasYearAndMonth) {
      const declaredYear = strictInteger(row.año);
      const declaredMonth = strictInteger(row.mes);
      if (declaredYear !== parsedDate.year || declaredMonth !== parsedDate.month) return null;
    }
    return `date:${parsedDate.iso}`;
  }
  const year = strictInteger(row?.año);
  const month = strictInteger(row?.mes);
  if (year >= 2000 && year <= 2200 && month >= 1 && month <= 12) {
    return `month:${year}-${String(month).padStart(2, '0')}`;
  }
  const rawMonth = String(row?.month || '').trim();
  let match = rawMonth.match(/^(\d{4})-(\d{1,2})$/);
  if (match && Number(match[1]) >= 2000 && Number(match[1]) <= 2200 && Number(match[2]) >= 1 && Number(match[2]) <= 12) {
    return `month:${match[1]}-${String(Number(match[2])).padStart(2, '0')}`;
  }
  match = rawMonth.match(/^(\d{1,2})\/(\d{4})$/);
  if (match && Number(match[1]) >= 1 && Number(match[1]) <= 12 && Number(match[2]) >= 2000 && Number(match[2]) <= 2200) {
    return `month:${match[2]}-${String(Number(match[1])).padStart(2, '0')}`;
  }
  return null;
}

function strictInteger(value) {
  if (value === null || value === undefined || value === '') return NaN;
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : NaN;
}

function isStrictFiniteValue(value) {
  if (value === null || value === undefined || value === '') return false;
  return Number.isFinite(Number(value));
}

function parseCalendarDate(value) {
  let year;
  let month;
  let day;
  let match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (match) [, year, month, day] = match.map(Number);
  else {
    match = String(value || '').match(/^(\d{2})-(\d{2})-(\d{4})$/);
    if (!match) return null;
    [, day, month, year] = match.map(Number);
  }
  const date = new Date(Date.UTC(year, month - 1, day));
  const valid = year >= 2000 && year <= 2200 &&
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day;
  if (!valid) return null;
  return {
    year,
    month,
    day,
    timestamp: date.getTime(),
    iso: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
  };
}

function isUsableCurrentSnapshot(current) {
  if (!isPlainObject(current)) return false;
  const start = parseCalendarDate(current.periodo_inicio);
  const end = parseCalendarDate(current.periodo_fin);
  if (!start || !end || start.timestamp > end.timestamp) return false;
  const hasDias = Object.prototype.hasOwnProperty.call(current, 'dias');
  if (hasDias) {
    return Array.isArray(current.dias) && current.dias.length > 0 &&
      current.dias.every((day) =>
        isPlainObject(day) && String(day.fecha || '').trim() !== '' && isStrictFiniteValue(day.kwh));
  }
  return isStrictFiniteValue(current.consumo_kwh);
}

const VOLATILE_SEMANTIC_FIELDS = new Set([
  'fetched_at',
  'stored_at',
  '_source',
  'age_minutes',
  'generatedAt',
  'updatedAt',
]);

function semanticValue(value) {
  if (Array.isArray(value)) return value.map((entry) => semanticValue(entry));
  if (!isPlainObject(value)) return value;
  const normalized = {};
  for (const key of Object.keys(value).sort()) {
    if (VOLATILE_SEMANTIC_FIELDS.has(key) || value[key] === undefined) continue;
    normalized[key] = semanticValue(value[key]);
  }
  return normalized;
}

function semanticHash(value) {
  return crypto.createHash('sha256')
    .update(JSON.stringify(semanticValue(value)))
    .digest('hex')
    .slice(0, 24);
}

function namespaceSnapshotContains(candidate, other) {
  if (!candidate.comparable || !other.comparable) return false;
  for (const [key, fingerprint] of other.items) {
    if (candidate.items.get(key) !== fingerprint) return false;
  }
  return true;
}

module.exports = {
  RuntimeStorage,
  SUPPLY_KEY_RE,
};
