#!/usr/bin/env node

const fs = require('fs-extra');
const path = require('path');
const chalk = require('chalk');
const schedule = require('node-schedule');

const UTEScraper = require('./lib/scraper');
const DataProcessor = require('./lib/processor');
const DataAnalyzer = require('./lib/analyzer');
const ReportGenerator = require('./lib/reporter');
const { loadPeriodDetail, savePeriodDetail } = require('./lib/period_detail_store');
const { ensureRuntimeDirs, runtimePaths } = require('./lib/runtime_env');

const VERSION = '1.0.0';

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

class UTEMonitor {
  constructor() {
    this.scraperEmail = process.env.UTE_EMAIL;
    this.scraperPassword = process.env.UTE_PASSWORD;
    this.debugMode = process.env.DEBUG === 'true';
    this.dataDir = runtimePaths.dataDir;
    this.reportDir = runtimePaths.reportDir;
    this.logDir = runtimePaths.logDir;

    this.processor = new DataProcessor(this.dataDir);
    this.analyzer = new DataAnalyzer();
    this.reporter = new ReportGenerator(this.reportDir);

    ensureRuntimeDirs();
  }

  log(message, type = 'info') {
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] ${message}`;

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
      console.error(chalk.red.bold('\n❌ ERROR: Credenciales no configuradas\n'));
      console.log(chalk.yellow('Para configurar las credenciales:'));
      console.log(chalk.white('1. Si corrés esto dentro del app de Home Assistant, abrí Settings > Apps > UTE > Configuration'));
      console.log(chalk.white('2. Cargá allí `ute_email` y `ute_password`'));
      console.log(chalk.white('3. Si corrés fuera de Home Assistant, también podés usar variables de entorno:'));
      console.log(chalk.cyan('   UTE_EMAIL=tu_email@example.com'));
      console.log(chalk.cyan('   UTE_PASSWORD=tu_contraseña'));
      console.log(chalk.white('\n4. Ejecutá nuevamente el comando.\n'));
      process.exit(1);
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
    try {
      console.log(chalk.bold.cyan('\n🌐 DESCARGANDO DATOS DE CONSUMO UTE\n'));

      this.validateCredentials();

      const scraper = new UTEScraper(this.scraperEmail, this.scraperPassword, this.debugMode);

      const rawData = await scraper.scrapeWithRetry();
      await scraper.close();

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
        console.warn(chalk.yellow(`⚠  No se pudo actualizar período actual: ${e.message}`));
      }

      return mergedData;

    } catch (error) {
      this.log(`Error en descarga: ${error.message}`, 'error');
      console.error(chalk.red(`\n❌ Error: ${error.message}\n`));
      throw error;
    }
  }

  /**
   * Obtiene los datos del período de facturación actual desde el portal UTE
   * y los guarda en data/periodo_actual.json. Es el único lugar donde se usa
   * Playwright fuera del scraper completo.
   */
  async currentPeriod() {
    try {
      console.log(chalk.bold.cyan('\n⚡ ACTUALIZANDO PERÍODO ACTUAL\n'));

      this.validateCredentials();

      const { fetchCurrentPeriod, close } = require('./lib/ute_session');
      const data = await fetchCurrentPeriod();
      await close();

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
      this.log(`Error actualizando período actual: ${error.message}`, 'error');
      console.error(chalk.red(`\n❌ Error: ${error.message}\n`));
      throw error;
    }
  }

  async periodDetail(periodoInicio, periodoFin, options = {}) {
    const jsonOnly = !!options.jsonOnly;
    const forceLive = !!options.forceLive;
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

      const { fetchPeriodDetail, close } = require('./lib/ute_session');
      const historicalRecord = this.getHistoricalRecordFromPeriod(periodoFin);
      const data = await fetchPeriodDetail(periodoInicio, periodoFin, {
        quiet: jsonOnly,
        fallbackTotals: historicalRecord
      });
      await close();
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
        console.error(chalk.red(`\n❌ Error: ${error.message}\n`));
      }
      throw error;
    }
  }

  async backfillPeriodDetails(startYm, endYm) {
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

      const { fetchPeriodDetail, close } = require('./lib/ute_session');
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
          const detail = await fetchPeriodDetail(periodoInicio, periodoFin, {
            quiet: true,
            fallbackTotals: historicalRecord
          });
          const savedPath = savePeriodDetail(this.dataDir, detail, { storedAt: fetchedAt });
          if (!savedPath) {
            throw new Error('el período no pasó la validación para persistirse localmente');
          }
          results.saved += 1;
          console.log(chalk.green(`  ✓ Guardado ${label} (${detail.consumo_kwh} kWh)`));
        } catch (error) {
          results.failed.push({ label, error: error.message, periodoInicio, periodoFin });
          console.log(chalk.yellow(`  ⚠ No se pudo guardar ${label}: ${error.message}`));
        }
      }

      await close();

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
      console.error(chalk.red(`\n❌ Error: ${error.message}\n`));
      throw error;
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
      console.error(chalk.red(`❌ Error: ${error.message}`));
      throw error;
    }
  }

  async report() {
    try {
      console.log(chalk.bold.cyan('\n📄 GENERANDO REPORTE\n'));
      console.log(chalk.yellow('⚠️ `report` es una salida legacy. El dashboard vivo en http://localhost:3010 sigue siendo la vista principal.\n'));

      // Cargar datos
      const data = this.processor.loadExistingData();

      if (data.length === 0) {
        console.log(chalk.yellow('⚠️ No hay datos para generar reporte. Ejecuta: node ute_monitor.js download'));
        return;
      }

      // Analizar
      this.analyzer.setData(data);
      const analysis = this.analyzer.getAnalysisSummary();

      // Generar reporte para el mes actual
      const now = new Date();
      const year = now.getFullYear();
      const month = now.getMonth() + 1;

      console.log(`📅 Generando reporte para ${month}/${year}...\n`);

      const reportFile = this.reporter.generateHTMLReport(data, analysis, year, month);

      console.log(chalk.green(`✅ Reporte generado: ${reportFile}`));
      this.log(`Reporte generado: ${reportFile}`);

      // También generar reportes para últimos 12 meses
      const last12 = data.slice(-12);
      if (last12.length > 0) {
        console.log('\n📊 Generando resumen de últimos 12 meses...');
        const summary = { ...analysis, monthlySummary: this.analyzer.generateMonthlySummary() };
        const summaryFile = this.reporter.generateHTMLReport(last12, summary, year, month);
        console.log(chalk.green(`✅ Resumen guardado: ${summaryFile}`));
      }

      return reportFile;

    } catch (error) {
      this.log(`Error generando reporte: ${error.message}`, 'error');
      console.error(chalk.red(`❌ Error: ${error.message}`));
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
          await this.report();
          console.log(chalk.green('✅ Descarga automática completada exitosamente'));
          this.log('Descarga automática completada exitosamente', 'success');
        } catch (error) {
          console.error(chalk.red(`❌ Error en descarga automática: ${error.message}`));
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
      console.error(chalk.red(`❌ Error configurando descarga automática: ${error.message}`));
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
      console.error(chalk.red(`❌ Error mostrando estado: ${error.message}`));
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
        cmd: 'report',
        desc: 'Generar reporte HTML legacy con gráficos'
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
    console.log(chalk.white('  node ute_monitor.js report      # Generar reporte'));
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

      case 'current':
        await this.currentPeriod();
        break;

      case 'analyze':
        await this.analyze();
        break;

      case 'report':
        await this.report();
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

// Ejecutar
const monitor = new UTEMonitor();
monitor.run().catch(error => {
  console.error(chalk.red(`Error fatal: ${error.message}`));
  process.exit(1);
});
