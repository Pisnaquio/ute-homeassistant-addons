#!/usr/bin/env node

const fs = require('fs-extra');
const path = require('path');
const chalk = require('chalk');
const schedule = require('node-schedule');

const DataProcessor = require('./lib/processor');
const DataAnalyzer = require('./lib/analyzer');
const { loadPeriodDetail, savePeriodDetail } = require('./lib/period_detail_store');
const { createUteDataSource } = require('./lib/ute_data_source');
const { ensureRuntimeDirs, runtimePaths, isAddonRuntime } = require('./lib/runtime_env');
const { redact, logEvent } = require('./lib/safe_log');
const { RuntimeStorage } = require('./lib/runtime_storage');

const VERSION = '1.0.0';
const VALID_PORTAL_SOURCE_MODES = new Set(['auto', 'http', 'playwright']);

function safeErrorMessage(error) {
  return redact(error?.message || error || 'error desconocido');
}

function logPortalDiagnostic(operation, error) {
  if (!error?.diagnostic) return;
  logEvent('warn', 'portal.discovery.diagnostic', {
    operation,
    code: error.code || 'DISCOVERY_FAILED',
    ...error.diagnostic,
  });
}

function parseYearMonth(text) {
  const match = String(text || '').match(/^(\d{4})-(\d{2})$/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (month < 1 || month > 12) return null;
  return { year, month };
}

function formatYearMonth(year, month) {
  return `${year}-${String(month).padStart(2, '0')}`;
}

function monthLabel(year, month) {
  const names = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
    'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
  return `${names[month - 1]} ${year}`;
}

function buildBillingPeriodBounds(year, month) {
  const prevMonth = month === 1 ? 12 : month - 1;
  const prevYear = month === 1 ? year - 1 : year;
  return {
    start: `27-${String(prevMonth).padStart(2, '0')}-${prevYear}`,
    end: `27-${String(month).padStart(2, '0')}-${year}`
  };
}

function* iterateYearMonths(startYear, startMonth, endYear, endMonth) {
  let year = startYear;
  let month = startMonth;
  while (year < endYear || (year === endYear && month <= endMonth)) {
    yield { year, month };
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }
}

function parsePortalDate(text) {
  const [d, m, y] = String(text || '').split('-').map(Number);
  return { day: d, month: m, year: y };
}

function normalizePortalSourceMode(value) {
  const mode = String(value || 'auto').toLowerCase();
  return VALID_PORTAL_SOURCE_MODES.has(mode) ? mode : 'auto';
}

class UTEMonitor {
  constructor() {
    this.scraperEmail = process.env.UTE_EMAIL;
    this.scraperPassword = process.env.UTE_PASSWORD;
    this.debugMode = process.env.DEBUG === 'true';
    this.portalSourceMode = normalizePortalSourceMode(process.env.UTE_SOURCE || process.env.UTE_PORTAL_TRANSPORT || 'auto');
    this.storage = new RuntimeStorage(runtimePaths);
    this.storage.ensureSingleSupplyMigration();
    const portfolio = this.storage.getPortfolio();
    const requestedSupplyKey = this.storage.resolveSupplyKey(process.env.UTE_SUPPLY_KEY)
      || this.storage.loadSelectedSupplyKey();
    this.supplyKey = portfolio?.source === 'legacy-single-supply'
      ? null
      : requestedSupplyKey;
    if (this.supplyKey && !this.storage.getActiveContext(this.supplyKey)) {
      this.supplyKey = null;
    }
    if (!this.supplyKey && process.env.UTE_SYNC_ALL !== 'true' && portfolio && portfolio.accounts.flatMap((account) => account.supplies || []).length > 1) {
      const error = new Error('SUPPLY_SELECTION_REQUIRED: seleccioná un suministro antes de sincronizar');
      error.code = 'SUPPLY_SELECTION_REQUIRED';
      throw error;
    }
    this.dataDir = this.supplyKey ? this.storage.getSupplyDataPath(this.supplyKey) : runtimePaths.dataDir;
    this.reportDir = runtimePaths.reportDir;
    this.logDir = runtimePaths.logDir;

    this.processor = new DataProcessor(this.dataDir);
    this.analyzer = new DataAnalyzer();

    ensureRuntimeDirs();
  }

  activateSupply(supplyKey) {
    const resolved = this.storage.resolveSupplyKey(supplyKey);
    const active = resolved ? this.storage.getActiveContext(resolved) : null;
    if (!active) {
      const error = new Error('SUPPLY_NOT_FOUND: el suministro seleccionado ya no existe en el portfolio');
      error.code = 'SUPPLY_NOT_FOUND';
      throw error;
    }
    this.supplyKey = resolved;
    this.dataDir = this.storage.getSupplyDataPath(resolved);
    this.processor = new DataProcessor(this.dataDir);
    return active;
  }

  log(message, type = 'info') {
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] ${redact(message)}`;

    if (type === 'error') {
      console.error(chalk.red(logMessage));
    } else if (type === 'success') {
      console.log(chalk.green(logMessage));
    } else if (type === 'warn') {
      console.warn(chalk.yellow(logMessage));
    } else {
      console.log(chalk.blue(logMessage));
    }

    // Guardar en archivo de log
    const logFile = path.join(this.logDir, `ute_monitor_${new Date().toISOString().split('T')[0]}.log`);
    try {
      fs.appendFileSync(logFile, logMessage + '\n');
    } catch (e) {
      // Silenciador si no se puede escribir log
    }
  }

  validateCredentials() {
    if (!this.scraperEmail || !this.scraperPassword) {
      const detail = isAddonRuntime
        ? 'Configurá Usuario UTE / número de cuenta y contraseña en Settings > Apps > UTE > Configuration.'
        : 'Configurá UTE_EMAIL (usuario o número de cuenta, no email) y UTE_PASSWORD en el entorno local.';
      const error = new Error(`MISSING_CREDENTIALS: ${detail}`);
      error.code = 'MISSING_CREDENTIALS';
      throw error;
    }
  }

  createDataSource() {
    const active = this.supplyKey ? this.storage.getActiveContext(this.supplyKey) : null;
    return createUteDataSource({
      userId: this.scraperEmail,
      password: this.scraperPassword,
      debug: this.debugMode,
      mode: this.portalSourceMode,
      supplyContext: active,
    });
  }

  async ensureSupplyPortfolio(source) {
    if (this.supplyKey) return this.activateSupply(this.supplyKey);
    const existing = this.storage.getPortfolio();
    if (existing && existing.source !== 'legacy-single-supply') {
      const supplies = existing.accounts.flatMap((account) => account.supplies || []);
      if (supplies.length === 1) {
        const selected = this.storage.getOrCreateSelectedSupply(existing);
        const active = this.activateSupply(selected);
        source.setSupplyContext?.(active);
        return active;
      }
      const error = new Error('SUPPLY_SELECTION_REQUIRED: el portal tiene múltiples suministros');
      error.code = 'SUPPLY_SELECTION_REQUIRED';
      throw error;
    }
    const discovered = await source.discoverPortfolio();
    const portfolio = this.storage.savePortfolio(discovered);
    const supplies = portfolio.accounts.flatMap((account) => account.supplies || []);
    const selected = this.storage.getOrCreateSelectedSupply(portfolio);
    if (supplies.length !== 1) {
      const error = new Error('SUPPLY_SELECTION_REQUIRED: seleccioná un suministro antes de sincronizar');
      error.code = 'SUPPLY_SELECTION_REQUIRED';
      error.portfolio = portfolio;
      throw error;
    }
    const active = this.activateSupply(selected);
    source.setSupplyContext?.(active);
    return active;
  }

  logSourceResult(result) {
    if (!result) return;
    const message =
      `[UTE source] operation=${result.operation} selected=${result.source}` +
      ` duration_ms=${result.durationMs}`;
    if (result.fallbackFrom) {
      console.log(chalk.yellow(`${message} fallback=${result.fallbackFrom}->${result.source} reason="${redact(result.fallbackReason)}"`));
    } else {
      console.log(chalk.gray(message));
    }
  }

  getHistoricalRecord(year, month) {
    const existing = this.processor.loadExistingData();
    return existing.find(item => item.año === year && item.mes === month) || null;
  }

  getHistoricalRecordFromPeriod(periodoFin) {
    const { month, year } = parsePortalDate(periodoFin);
    return this.getHistoricalRecord(year, month);
  }

  async download() {
    let source = null;
    try {
      console.log(chalk.bold.cyan('\n🌐 DESCARGANDO DATOS DE CONSUMO UTE\n'));

      this.validateCredentials();
      source = this.createDataSource();
      await this.ensureSupplyPortfolio(source);
      const monthlyResult = await source.fetchMonthlyData();
      this.logSourceResult(monthlyResult);
      const rawData = monthlyResult.data;

      if (rawData.length === 0) {
        throw new Error('No se obtuvieron datos del portal');
      }

      // Procesar datos
      console.log('\n📊 Procesando datos...');
      const parsedData = this.processor.parseConsumptionData(rawData);

      if (parsedData.length === 0) {
        throw new Error('No se pudieron procesar los datos descargados');
      }

      // Cargar datos existentes y fusionar
      const existingData = this.processor.loadExistingData();
      const mergedData = this.processor.mergeData(existingData, parsedData);

      // Guardar consumo.json (fuente canónica del dashboard)
      this.processor.saveConsumoJson(mergedData);

      // Guardar por año en Excel (backup / descarga)
      const years = new Set(mergedData.map(d => d.año));
      for (const year of years) {
        this.processor.saveToExcel(mergedData, year);
      }

      console.log(chalk.green(`\n✅ Descarga completada: ${mergedData.length} registros`));
      this.log(`Descarga exitosa: ${mergedData.length} registros procesados`);

      // También actualizar período actual (puede fallar sin romper la descarga)
      try {
        console.log('\n⚡ Actualizando período actual...');
        await this.currentPeriod();
      } catch (e) {
        console.warn(chalk.yellow(`⚠  No se pudo actualizar período actual: ${safeErrorMessage(e)}`));
      }

      return mergedData;

    } catch (error) {
      logPortalDiagnostic('monthly', error);
      this.log(`Error en descarga: ${error.message}`, 'error');
      console.error(chalk.red(`\n❌ Error: ${safeErrorMessage(error)}\n`));
      throw error;
    } finally {
      if (source) await source.close().catch(() => {});
    }
  }

  async syncAll() {
    this.validateCredentials();
    const supplies = (this.storage.getPortfolio()?.accounts || []).flatMap((account) => account.supplies || []);
    if (!supplies.length) throw new Error('No hay portfolio descubierto para sincronizar');
    const { spawnSync } = require('child_process');
    const failures = [];
    for (const supply of supplies) {
      this.log(`Sincronizando suministro ${supply.supplyKey}`);
      const result = spawnSync(process.execPath, [__filename, 'download'], {
        cwd: __dirname,
        env: { ...process.env, UTE_SUPPLY_KEY: supply.supplyKey, UTE_SYNC_ALL: 'false' },
        stdio: 'inherit',
      });
      if (result.status !== 0) {
        failures.push(supply.supplyKey);
        this.log(`⚠️ Falló sincronización parcial del suministro ${supply.supplyKey}`, 'warn');
      }
    }
    if (failures.length) {
      const error = new Error(`SYNC_PARTIAL_FAILURE: ${failures.join(', ')}`);
      error.code = 'SYNC_PARTIAL_FAILURE';
      error.failedSupplyKeys = failures;
      throw error;
    }
  }

  /**
   * Obtiene los datos del período de facturación actual desde el portal UTE
   * y los guarda en data/periodo_actual.json. Es el único lugar donde se usa
   * Playwright fuera del scraper completo.
   */
  async currentPeriod() {
    let source = null;
    try {
      console.log(chalk.bold.cyan('\n⚡ ACTUALIZANDO PERÍODO ACTUAL\n'));

      this.validateCredentials();
      source = this.createDataSource();
      await this.ensureSupplyPortfolio(source);
      const currentResult = await source.fetchCurrentPeriod();
      this.logSourceResult(currentResult);
      const data = currentResult.data;

      const outPath = path.join(this.dataDir, 'periodo_actual.json');
      const fetchedAt = new Date().toISOString();
      fs.writeJsonSync(outPath, { ...data, fetched_at: fetchedAt }, { spaces: 2 });

      if (data.periodo_cerrado_anterior) {
        savePeriodDetail(this.dataDir, data.periodo_cerrado_anterior, { storedAt: fetchedAt });
      }

      console.log(chalk.green(
        `\n✅ Período actual guardado: ${data.consumo_kwh} kWh` +
        ` (${data.periodo_inicio} → ${data.periodo_fin})`
      ));
      this.log(`Período actual guardado: ${data.consumo_kwh} kWh`);

      return data;

    } catch (error) {
      logPortalDiagnostic('current', error);
      this.log(`Error actualizando período actual: ${error.message}`, 'error');
      console.error(chalk.red(`\n❌ Error: ${safeErrorMessage(error)}\n`));
      throw error;
    } finally {
      if (source) await source.close().catch(() => {});
    }
  }

  async periodDetail(periodoInicio, periodoFin, options = {}) {
    const jsonOnly = !!options.jsonOnly;
    const forceLive = !!options.forceLive;
    let source = null;
    try {
      if (!jsonOnly) {
        console.log(chalk.bold.cyan('\n📅 CARGANDO DETALLE DIARIO DEL PERÍODO\n'));
      }

      if (!forceLive) {
        const cached = loadPeriodDetail(this.dataDir, periodoInicio, periodoFin);
        if (cached) {
          if (jsonOnly) {
            process.stdout.write(JSON.stringify(cached));
          } else {
            console.log(chalk.green(
              `\n✅ Detalle diario leído desde cache local: ${cached.consumo_kwh} kWh` +
              ` (${cached.periodo_inicio} → ${cached.periodo_fin})`
            ));
            this.log(`Detalle diario leído desde cache local: ${periodoInicio} → ${periodoFin}`);
          }
          return cached;
        }
      }

      this.validateCredentials();
      const historicalRecord = this.getHistoricalRecordFromPeriod(periodoFin);
      source = this.createDataSource();
      const detailResult = await source.fetchPeriodDetail(periodoInicio, periodoFin, {
        quiet: jsonOnly,
        fallbackTotals: historicalRecord
      });
      if (!jsonOnly) this.logSourceResult(detailResult);
      const data = detailResult.data;
      const storedAt = new Date().toISOString();
      savePeriodDetail(this.dataDir, data, { storedAt });
      const output = { ...data, fetched_at: storedAt, _source: 'live-fetch' };

      if (jsonOnly) {
        process.stdout.write(JSON.stringify(output));
      } else {
        console.log(chalk.green(
          `\n✅ Detalle diario cargado: ${data.consumo_kwh} kWh` +
          ` (${data.periodo_inicio} → ${data.periodo_fin})`
        ));
        this.log(`Detalle diario cargado: ${periodoInicio} → ${periodoFin}`);
      }

      return output;

    } catch (error) {
      if (!jsonOnly) {
        this.log(`Error cargando detalle diario: ${error.message}`, 'error');
        console.error(chalk.red(`\n❌ Error: ${safeErrorMessage(error)}\n`));
      }
      throw error;
    } finally {
      if (source) await source.close().catch(() => {});
    }
  }

  async backfillPeriodDetails(startYm, endYm) {
    let source = null;
    try {
      console.log(chalk.bold.cyan('\n🗂 BACKFILL DE DETALLE DIARIO POR PERÍODO\n'));
      const start = parseYearMonth(startYm);
      const end = parseYearMonth(endYm);
      if (!start || !end) {
        throw new Error('Uso: node ute_monitor.js backfill-period-details YYYY-MM YYYY-MM');
      }
      if (start.year > end.year || (start.year === end.year && start.month > end.month)) {
        throw new Error('El rango es inválido: la fecha inicial no puede ser mayor a la final.');
      }

      this.validateCredentials();
      source = this.createDataSource();
      const fetchedAt = new Date().toISOString();
      const results = { saved: 0, skipped: 0, failed: [] };

      for (const item of iterateYearMonths(start.year, start.month, end.year, end.month)) {
        const { start: periodoInicio, end: periodoFin } = buildBillingPeriodBounds(item.year, item.month);
        const existing = loadPeriodDetail(this.dataDir, periodoInicio, periodoFin);
        const label = monthLabel(item.year, item.month);

        if (existing) {
          results.skipped += 1;
          console.log(chalk.gray(`• ${label}: ya estaba guardado localmente`));
          continue;
        }

        try {
          console.log(chalk.cyan(`• ${label}: consultando UTE (${periodoInicio} → ${periodoFin})...`));
          const historicalRecord = this.getHistoricalRecord(item.year, item.month);
          const detailResult = await source.fetchPeriodDetail(periodoInicio, periodoFin, {
            quiet: true,
            fallbackTotals: historicalRecord
          });
          this.logSourceResult(detailResult);
          const detail = detailResult.data;
          const savedPath = savePeriodDetail(this.dataDir, detail, { storedAt: fetchedAt });
          if (!savedPath) {
            throw new Error('el período no pasó la validación para persistirse localmente');
          }
          results.saved += 1;
          console.log(chalk.green(`  ✓ Guardado ${label} (${detail.consumo_kwh} kWh)`));
        } catch (error) {
          results.failed.push({ label, error: safeErrorMessage(error), periodoInicio, periodoFin });
          console.log(chalk.yellow(`  ⚠ No se pudo guardar ${label}: ${safeErrorMessage(error)}`));
        }
      }

      console.log(chalk.green(`\n✅ Backfill terminado: ${results.saved} guardados, ${results.skipped} ya existían, ${results.failed.length} fallaron.`));
      if (results.failed.length) {
        console.log(chalk.yellow('Meses fallidos:'));
        results.failed.forEach(item => {
          console.log(chalk.yellow(`  - ${item.label} (${item.periodoInicio} → ${item.periodoFin}): ${item.error}`));
        });
      }
      this.log(`Backfill detalle diario: ${results.saved} guardados, ${results.skipped} existentes, ${results.failed.length} fallidos`);
      return results;
    } catch (error) {
      this.log(`Error en backfill de detalle diario: ${error.message}`, 'error');
      console.error(chalk.red(`\n❌ Error: ${safeErrorMessage(error)}\n`));
      throw error;
    } finally {
      if (source) await source.close().catch(() => {});
    }
  }

  async analyze(data = null) {
    try {
      console.log(chalk.bold.cyan('\n📈 ANALIZANDO DATOS DE CONSUMO\n'));

      // Cargar datos si no se proporcionan
      if (!data) {
        data = this.processor.loadExistingData();
      }

      if (data.length === 0) {
        console.log(chalk.yellow('⚠️ No hay datos para analizar. Ejecuta: node ute_monitor.js download'));
        return null;
      }

      // Analizar
      this.analyzer.setData(data);
      this.analyzer.displayStatistics();
      this.analyzer.displayMonthlySummary();
      this.analyzer.displayTop5();
      this.analyzer.displayAnomalies();
      this.analyzer.displayAlerts();

      const summary = this.analyzer.getAnalysisSummary();
      this.log('Análisis completado exitosamente');

      return summary;

    } catch (error) {
      this.log(`Error en análisis: ${error.message}`, 'error');
      console.error(chalk.red(`❌ Error: ${safeErrorMessage(error)}`));
      throw error;
    }
  }

  async schedule() {
    try {
      console.log(chalk.bold.cyan('\n⏰ CONFIGURANDO DESCARGA AUTOMÁTICA\n'));

      const scheduleDay = parseInt(process.env.SCHEDULE_DAY || '5');

      if (scheduleDay < 1 || scheduleDay > 28) {
        throw new Error('SCHEDULE_DAY debe estar entre 1 y 28');
      }

      // Configurar tarea para el día especificado de cada mes
      const cronExpression = `0 6 ${scheduleDay} * *`; // 6 AM

      console.log(chalk.cyan(`Descarga programada para el día ${scheduleDay} de cada mes a las 6:00 AM`));
      console.log(chalk.cyan(`Expresión cron: ${cronExpression}`));

      const job = schedule.scheduleJob(cronExpression, async () => {
        console.log(chalk.bold.yellow(`\n[${new Date().toISOString()}] Ejecutando descarga automática...\n`));
        try {
          const data = await this.download();
          await this.analyze(data);
          console.log(chalk.green('✅ Descarga automática completada exitosamente'));
          this.log('Descarga automática completada exitosamente', 'success');
        } catch (error) {
          console.error(chalk.red(`❌ Error en descarga automática: ${safeErrorMessage(error)}`));
          this.log(`Error en descarga automática: ${error.message}`, 'error');
        }
      });

      console.log(chalk.green('\n✅ Descarga automática configurada'));
      console.log(chalk.white('El proceso continuará ejecutándose en segundo plano...'));
      console.log(chalk.white('Presiona Ctrl+C para detener.\n'));

      this.log('Descarga automática configurada');

      // Mantener el proceso en ejecución
      process.stdin.resume();

    } catch (error) {
      console.error(chalk.red(`❌ Error configurando descarga automática: ${safeErrorMessage(error)}`));
      throw error;
    }
  }

  status() {
    try {
      console.log(chalk.bold.cyan('\n📊 ESTADO DEL MONITOR\n'));

      const data = this.processor.loadExistingData();

      if (data.length === 0) {
        console.log(chalk.yellow('⚠️ No hay datos descargados aún\n'));
        return;
      }

      const lastData = data[data.length - 1];
      const monthNames = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
                         'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];

      console.log(chalk.white(`Últimos datos: ${monthNames[lastData.mes - 1]} ${lastData.año}`));
      console.log(chalk.white(`Consumo: ${lastData.consumo_kwh.toFixed(2)} kWh`));
      console.log(chalk.white(`Costo: $${(lastData.costo_uyu || 0).toLocaleString('es-UY')} UYU`));
      console.log(chalk.white(`Total de registros: ${data.length} meses`));

      // Listar archivos disponibles
      const files = fs.readdirSync(this.dataDir).filter(f => f.endsWith('.xlsx'));
      if (files.length > 0) {
        console.log(chalk.cyan(`\nArchivos Excel disponibles:`));
        for (const file of files) {
          const stats = fs.statSync(path.join(this.dataDir, file));
          console.log(chalk.white(`  📄 ${file} (${(stats.size / 1024).toFixed(2)} KB)`));
        }
      }

      const reportFiles = fs.readdirSync(this.reportDir).filter(f => f.endsWith('.html'));
      if (reportFiles.length > 0) {
        console.log(chalk.cyan(`\nReportes disponibles:`));
        for (const file of reportFiles) {
          const stats = fs.statSync(path.join(this.reportDir, file));
          console.log(chalk.white(`  📄 ${file} (${(stats.size / 1024).toFixed(2)} KB)`));
        }
      }

      console.log();

    } catch (error) {
      console.error(chalk.red(`❌ Error mostrando estado: ${safeErrorMessage(error)}`));
    }
  }

  showHelp() {
    console.log(chalk.bold.cyan(`\n📚 UTE MONITOR v${VERSION}\n`));
    console.log(chalk.white('Monitoreo automatizado de consumo de energía UTE\n'));

    console.log(chalk.bold('COMANDOS:\n'));

    const commands = [
      {
        cmd: 'download',
        desc: 'Descargar datos de consumo del portal UTE'
      },
      {
        cmd: 'analyze',
        desc: 'Analizar datos y mostrar estadísticas'
      },
      {
        cmd: 'schedule',
        desc: 'Activar descarga automática mensual'
      },
      {
        cmd: 'status',
        desc: 'Ver estado y últimos datos'
      },
      {
        cmd: 'period-detail',
        desc: 'Traer curva diaria de un período (DD-MM-YYYY DD-MM-YYYY)'
      },
      {
        cmd: 'backfill-period-details',
        desc: 'Guardar detalle diario mensual en cache local (YYYY-MM YYYY-MM)'
      },
      {
        cmd: 'help',
        desc: 'Mostrar este mensaje'
      }
    ];

    for (const cmd of commands) {
      console.log(chalk.cyan(`  ${cmd.cmd.padEnd(15)}`), chalk.white(cmd.desc));
    }

    console.log(chalk.bold('\nEJEMPLOS:\n'));
    console.log(chalk.white('  node ute_monitor.js download    # Descargar ahora'));
    console.log(chalk.white('  node ute_monitor.js analyze     # Analizar datos'));
    console.log(chalk.white('  node ute_monitor.js period-detail 27-04-2026 26-05-2026   # Curva diaria de un período'));
    console.log(chalk.white('  node ute_monitor.js backfill-period-details 2023-05 2026-05   # Cachear varios meses'));
    console.log(chalk.white('  node ute_monitor.js schedule    # Descargar automáticamente\n'));

    console.log(chalk.bold('CONFIGURACIÓN:\n'));
    console.log(chalk.white('1. Copia .env.example a .env'));
    console.log(chalk.white('2. Edita .env con tus credenciales de UTE'));
    console.log(chalk.white('3. Ejecuta: npm install'));
    console.log(chalk.white('4. Ejecuta: npm start o node ute_monitor.js download\n'));
  }

  async run() {
    const command = process.argv[2] || 'help';

    switch (command) {
      case 'download':
        await this.download();
        break;

      case 'sync-all':
        await this.syncAll();
        break;

      case 'current':
        await this.currentPeriod();
        break;

      case 'analyze':
        await this.analyze();
        break;

      case 'schedule':
        await this.schedule();
        break;

      case 'status':
        this.status();
        break;

      case 'period-detail': {
        const periodoInicio = process.argv[3];
        const periodoFin = process.argv[4];
        const jsonOnly = process.argv.includes('--json');
        const forceLive = process.argv.includes('--live');
        if (!periodoInicio || !periodoFin) {
          throw new Error('Uso: node ute_monitor.js period-detail DD-MM-YYYY DD-MM-YYYY [--json] [--live]');
        }
        await this.periodDetail(periodoInicio, periodoFin, { jsonOnly, forceLive });
        break;
      }

      case 'backfill-period-details': {
        const startYm = process.argv[3];
        const endYm = process.argv[4];
        if (!startYm || !endYm) {
          throw new Error('Uso: node ute_monitor.js backfill-period-details YYYY-MM YYYY-MM');
        }
        await this.backfillPeriodDetails(startYm, endYm);
        break;
      }

      case 'help':
      case '--help':
      case '-h':
        this.showHelp();
        break;

      default:
        console.error(chalk.red(`\n❌ Comando desconocido: ${command}\n`));
        console.log(chalk.yellow('Usa: node ute_monitor.js help\n'));
        throw new Error(`Comando desconocido: ${command}`);
    }
  }
}

if (require.main === module) {
  const monitor = new UTEMonitor();
  monitor.run().catch(error => {
    console.error(chalk.red(`Error fatal: ${safeErrorMessage(error)}`));
    process.exit(1);
  });
}

module.exports = { UTEMonitor };
