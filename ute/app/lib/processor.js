const XLSX = require('xlsx');
const fs = require('fs-extra');
const path = require('path');

const ALLOWED_XLSX_FILE_RE = /^consumo_ute_\d{4}\.xlsx$/i;

class DataProcessor {
  constructor(dataDir = 'data') {
    this.dataDir = dataDir;
    fs.ensureDirSync(dataDir);
  }

  parseConsumptionData(rawData) {
    const parsed = [];

    for (const item of rawData) {
      try {
        // Shortcut: el scraper ya nos entrega el item parseado
        if (item._parsed) {
          const d = item._parsed;
          if (d.mes && d.año && d.consumo_kwh > 0) {
            parsed.push({
              mes:         d.mes,
              año:         d.año,
              fecha:       d.fecha || `${d.año}-${String(d.mes).padStart(2,'0')}-27`,
              consumo_kwh: d.consumo_kwh,
              punta_kwh:   d.punta_kwh || 0,
              valle_kwh:   d.valle_kwh || 0,
              llano_kwh:   d.llano_kwh || 0,
              costo_uyu:   d.costo_uyu || 0
            });
          }
          continue;
        }

        // Extraer mes y año del texto
        const monthYearMatch = item.month?.match(/(\w+)\s+(\d{4})?/i) || item.month?.match(/(\d+)\/(\d{4})/);

        let month, year;

        if (monthYearMatch) {
          if (item.month.includes('/')) {
            // Formato MM/YYYY
            [, month, year] = item.month.match(/(\d+)\/(\d{4})/);
            month = parseInt(month);
          } else {
            // Formato "January 2024" o similar
            const monthNames = ['January', 'February', 'March', 'April', 'May', 'June',
                               'July', 'August', 'September', 'October', 'November', 'December'];
            const monthSpanish = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
                                 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];

            for (let i = 0; i < monthNames.length; i++) {
              if (item.month.toLowerCase().includes(monthNames[i].toLowerCase())) {
                month = i + 1;
                break;
              }
              if (item.month.toLowerCase().includes(monthSpanish[i].toLowerCase())) {
                month = i + 1;
                break;
              }
            }

            year = monthYearMatch[2] || new Date().getFullYear();
          }
        }

        if (!month || !year) {
          console.warn(`⚠️ No se pudo parsear: ${item.month}`);
          continue;
        }

        // Extraer kWh
        const kwhMatch = item.kwh.match(/[\d,.\s]+/);
        const kwh = kwhMatch ? parseFloat(kwhMatch[0].replace(/[,\s]/g, '.')) : 0;

        // Extraer costo
        const costMatch = item.cost.match(/[\d,.\s]+/);
        const cost = costMatch ? parseFloat(costMatch[0].replace(/[,\s]/g, '.')) : 0;

        if (kwh > 0 || cost > 0) {
          parsed.push({
            mes: month,
            año: parseInt(year),
            fecha: new Date(year, month - 1, 1),
            consumo_kwh: kwh,
            costo_uyu: cost,
            raw: item
          });
        }
      } catch (error) {
        console.warn(`⚠️ Error procesando ${item.month}: ${error.message}`);
      }
    }

    // Ordenar por año y mes
    parsed.sort((a, b) => {
      if (a.año !== b.año) return a.año - b.año;
      return a.mes - b.mes;
    });

    return parsed;
  }

  saveToExcel(data, year) {
    try {
      const filename = path.join(this.dataDir, `consumo_ute_${year}.xlsx`);

      // Preparar datos para Excel
      const wsData = [
        ['Mes', 'Año', 'Fecha', 'Consumo (kWh)', 'Costo (UYU)', '$/kWh', 'Variación %', 'Notas']
      ];

      // Filtrar datos por año
      const yearData = data.filter(d => d.año === year).sort((a, b) => a.mes - b.mes);

      for (let i = 0; i < yearData.length; i++) {
        const d = yearData[i];
        const monthNames = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun',
                           'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];

        wsData.push([
          monthNames[d.mes - 1],
          d.año,
          new Date(d.año, d.mes - 1, 1).toISOString().split('T')[0],
          d.consumo_kwh,
          d.costo_uyu,
          i === 0 ? '' : `=E${i + 2}/D${i + 2}`, // Fórmula $/kWh
          i === 0 ? '' : `=(D${i + 2}-D${i + 1})/D${i + 1}`, // Fórmula variación %
          ''
        ]);
      }

      // Crear workbook
      const wb = XLSX.utils.book_new();
      const ws = XLSX.utils.aoa_to_sheet(wsData);

      // Establecer anchos de columna
      ws['!cols'] = [
        { wch: 10 },
        { wch: 8 },
        { wch: 12 },
        { wch: 15 },
        { wch: 12 },
        { wch: 10 },
        { wch: 12 },
        { wch: 20 }
      ];

      // Estilos para encabezado (si Excel lo soporta)
      const headerStyle = {
        font: { bold: true },
        fill: { fgColor: { rgb: 'FFCCCCCC' } },
        alignment: { horizontal: 'center', vertical: 'center' }
      };

      // Aplicar estilos a la fila de encabezado
      for (let i = 0; i < wsData[0].length; i++) {
        const cellRef = XLSX.utils.encode_cell({ r: 0, c: i });
        if (!ws[cellRef]) ws[cellRef] = {};
        ws[cellRef].s = headerStyle;
      }

      XLSX.utils.book_append_sheet(wb, ws, 'Consumo');

      // Crear worksheet de resumen
      const summaryWs = XLSX.utils.aoa_to_sheet([
        ['Resumen de Consumo ' + year],
        [],
        ['Métrica', 'Valor'],
        ['Consumo Total (kWh)', yearData.length > 0 ?
          `=SUM('Consumo'!D2:D${yearData.length + 1})` : 0],
        ['Costo Total (UYU)', yearData.length > 0 ?
          `=SUM('Consumo'!E2:E${yearData.length + 1})` : 0],
        ['Consumo Promedio (kWh)', yearData.length > 0 ?
          `=AVERAGE('Consumo'!D2:D${yearData.length + 1})` : 0],
        ['Costo Promedio (UYU)', yearData.length > 0 ?
          `=AVERAGE('Consumo'!E2:E${yearData.length + 1})` : 0],
        ['Consumo Máximo (kWh)', yearData.length > 0 ?
          `=MAX('Consumo'!D2:D${yearData.length + 1})` : 0],
        ['Consumo Mínimo (kWh)', yearData.length > 0 ?
          `=MIN('Consumo'!D2:D${yearData.length + 1})` : 0],
      ]);

      summaryWs['!cols'] = [{ wch: 25 }, { wch: 15 }];

      XLSX.utils.book_append_sheet(wb, summaryWs, 'Resumen');

      // Guardar archivo
      XLSX.writeFile(wb, filename);
      console.log(`✅ Datos guardados en: ${filename}`);
      return filename;

    } catch (error) {
      console.error('❌ Error guardando Excel:', error.message);
      throw error;
    }
  }

  loadExistingData() {
    // Prefer consumo.json — it's the canonical source and includes tramo data
    const consumoPath = path.join(this.dataDir, 'consumo.json');
    if (fs.existsSync(consumoPath)) {
      try {
        const data = JSON.parse(fs.readFileSync(consumoPath, 'utf8'));
        if (Array.isArray(data) && data.length > 0) {
          return data.sort((a, b) => a.año !== b.año ? a.año - b.año : a.mes - b.mes);
        }
      } catch (e) {
        console.warn('⚠️  Error leyendo consumo.json, usando Excel como fallback:', e.message);
      }
    }

      // Fallback: read from Excel files (no tramo data)
      try {
      const files = fs.readdirSync(this.dataDir).filter((f) => ALLOWED_XLSX_FILE_RE.test(f));
      const allData = [];

      for (const file of files) {
        const filepath = path.join(this.dataDir, file);
        const wb = XLSX.readFile(filepath);
        const ws = wb.Sheets['Consumo'];
        if (!ws) continue;

        const rows = XLSX.utils.sheet_to_json(ws);
        const monthNames = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun',
                           'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];

        for (const row of rows) {
          if (row['Consumo (kWh)'] && row['Año']) {
            let mesNum = 1;
            if (row['Mes']) {
              mesNum = monthNames.indexOf(row['Mes'].trim()) + 1;
              if (mesNum === 0) mesNum = 1;
            }
            allData.push({
              mes:         mesNum,
              año:         parseInt(row['Año']),
              fecha:       row['Fecha'] || `${row['Año']}-${String(mesNum).padStart(2,'0')}-27`,
              consumo_kwh: parseFloat(row['Consumo (kWh)']),
              punta_kwh:   0,
              valle_kwh:   0,
              llano_kwh:   0,
              costo_uyu:   parseFloat(row['Costo (UYU)']) || 0
            });
          }
        }
      }
      return allData;
    } catch (error) {
      console.warn('⚠️  No se pudo cargar datos existentes:', error.message);
      return [];
    }
  }

  mergeData(existingData, newData) {
    const merged = existingData.map(e => ({ ...e }));

    for (const newItem of newData) {
      const idx = merged.findIndex(item => item.año === newItem.año && item.mes === newItem.mes);
      if (idx === -1) {
        merged.push({ ...newItem });
      } else {
        const existing = merged[idx];
        const newHasTramos  = (newItem.punta_kwh || 0) + (newItem.valle_kwh || 0) + (newItem.llano_kwh || 0) > 0;
        const oldHasTramos  = (existing.punta_kwh || 0) + (existing.valle_kwh || 0) + (existing.llano_kwh || 0) > 0;
        const newHasCost    = (newItem.costo_uyu || 0) > 0;
        const oldHasCost    = (existing.costo_uyu || 0) > 0;
        // Update if new data adds tramos we didn't have, or adds cost we didn't have
        if ((newHasTramos && !oldHasTramos) || (newHasCost && !oldHasCost)) {
          merged[idx] = { ...existing, ...newItem };
        }
      }
    }

    merged.sort((a, b) => a.año !== b.año ? a.año - b.año : a.mes - b.mes);
    return merged;
  }
  saveConsumoJson(data) {
    const consumoPath = path.join(this.dataDir, 'consumo.json');
    const clean = data
      .sort((a, b) => a.año !== b.año ? a.año - b.año : a.mes - b.mes)
      .map(d => ({
        mes:         d.mes,
        año:         d.año,
        fecha:       typeof d.fecha === 'string'
                       ? d.fecha
                       : (d.fecha instanceof Date
                           ? d.fecha.toISOString().split('T')[0]
                           : `${d.año}-${String(d.mes).padStart(2,'0')}-27`),
        consumo_kwh: d.consumo_kwh || 0,
        punta_kwh:   d.punta_kwh   || 0,
        valle_kwh:   d.valle_kwh   || 0,
        llano_kwh:   d.llano_kwh   || 0,
        costo_uyu:   d.costo_uyu   || 0,
      }));
    fs.writeJsonSync(consumoPath, clean, { spaces: 2 });
    console.log(`✅ consumo.json actualizado: ${clean.length} registros`);
    return consumoPath;
  }
}

module.exports = DataProcessor;
