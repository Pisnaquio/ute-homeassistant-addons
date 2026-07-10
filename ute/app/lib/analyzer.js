const Table = require('cli-table3');
const chalk = require('chalk');

class DataAnalyzer {
  constructor(data = []) {
    this.data = data.sort((a, b) => {
      if (a.año !== b.año) return a.año - b.año;
      return a.mes - b.mes;
    });
  }

  setData(data) {
    this.data = data.sort((a, b) => {
      if (a.año !== b.año) return a.año - b.año;
      return a.mes - b.mes;
    });
  }

  calculateStatistics() {
    if (this.data.length === 0) {
      return null;
    }

    const consumos = this.data.map(d => d.consumo_kwh);
    const costos = this.data.map(d => d.costo_uyu);

    const stats = {
      consumoTotal: consumos.reduce((a, b) => a + b, 0),
      costoTotal: costos.reduce((a, b) => a + b, 0),
      consumoPromedio: consumos.reduce((a, b) => a + b, 0) / consumos.length,
      costoPromedio: costos.reduce((a, b) => a + b, 0) / costos.length,
      consumoMax: Math.max(...consumos),
      consumoMin: Math.min(...consumos),
      costoMax: Math.max(...costos),
      costoMin: Math.min(...costos),
      periodos: this.data.length
    };

    stats['$/kwhPromedio'] = stats.costoTotal / stats.consumoTotal;

    // Calcular desviación estándar
    const variance = consumos.reduce((sum, val) => {
      return sum + Math.pow(val - stats.consumoPromedio, 2);
    }, 0) / consumos.length;
    stats.desviacionEstandar = Math.sqrt(variance);

    return stats;
  }

  calculateTrend(months = 3) {
    if (this.data.length < months) {
      return 'DATOS_INSUFICIENTES';
    }

    const recent = this.data.slice(-months).map(d => d.consumo_kwh);
    const avg = recent.reduce((a, b) => a + b, 0) / recent.length;

    const trend = (recent[recent.length - 1] - recent[0]) / recent[0] * 100;

    if (trend > 5) return 'AUMENTANDO';
    if (trend < -5) return 'DISMINUYENDO';
    return 'ESTABLE';
  }

  detectAnomalies() {
    const stats = this.calculateStatistics();
    if (!stats) return [];

    const anomalies = [];
    const threshold = 2; // 2 desviaciones estándar

    for (const item of this.data) {
      const deviations = Math.abs(item.consumo_kwh - stats.consumoPromedio) /
                        stats.desviacionEstandar;

      if (deviations > threshold) {
        anomalies.push({
          fecha: item.fecha,
          consumo: item.consumo_kwh,
          desviaciones: deviations.toFixed(2),
          tipo: item.consumo_kwh > stats.consumoPromedio ? 'ALTO' : 'BAJO'
        });
      }
    }

    return anomalies;
  }

  generateAlerts() {
    const alerts = [];
    const stats = this.calculateStatistics();

    if (!stats || this.data.length === 0) {
      return alerts;
    }

    const ultimoDato = this.data[this.data.length - 1];
    const prevDato = this.data.length > 1 ? this.data[this.data.length - 2] : null;

    // Alerta por consumo crítico
    if (ultimoDato.consumo_kwh > stats.consumoPromedio * 1.3) {
      alerts.push({
        level: 'CRITICO',
        icon: '🔴',
        message: `Consumo CRÍTICO: ${ultimoDato.consumo_kwh.toFixed(2)} kWh (${
          ((ultimoDato.consumo_kwh / stats.consumoPromedio - 1) * 100).toFixed(1)}% por arriba del promedio)`,
        action: 'Revisar posibles fugas o equipos con alto consumo'
      });
    }

    // Alerta por aumento mes a mes
    if (prevDato && ultimoDato.consumo_kwh > prevDato.consumo_kwh * 1.15) {
      const increase = ((ultimoDato.consumo_kwh / prevDato.consumo_kwh - 1) * 100).toFixed(1);
      alerts.push({
        level: 'IMPORTANTE',
        icon: '🟠',
        message: `Aumento importante: +${increase}% respecto mes anterior`,
        action: 'Verificar cambios en el consumo o equipos nuevos'
      });
    }

    // Alerta por tendencia creciente
    const trend = this.calculateTrend(3);
    if (trend === 'AUMENTANDO') {
      alerts.push({
        level: 'INFO',
        icon: '🟡',
        message: 'Tendencia creciente en los últimos 3 meses',
        action: 'Monitor el consumo para detectar problemas temprano'
      });
    }

    // Si todo está bien
    if (alerts.length === 0) {
      alerts.push({
        level: 'NORMAL',
        icon: '✅',
        message: 'Consumo dentro de parámetros normales',
        action: 'Sin acciones requeridas'
      });
    }

    return alerts;
  }

  generateMonthlySummary() {
    if (this.data.length === 0) {
      return null;
    }

    const ultimoDato = this.data[this.data.length - 1];
    const prevDato = this.data.length > 1 ? this.data[this.data.length - 2] : null;
    const stats = this.calculateStatistics();

    const monthNames = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
                       'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];

    const variacion = prevDato ?
      ((ultimoDato.consumo_kwh / prevDato.consumo_kwh - 1) * 100).toFixed(1) :
      0;

    const vs_promedio = ((ultimoDato.consumo_kwh / stats.consumoPromedio - 1) * 100).toFixed(1);

    return {
      mes: monthNames[ultimoDato.mes - 1],
      año: ultimoDato.año,
      consumoMes: ultimoDato.consumo_kwh.toFixed(2),
      costoMes: ultimoDato.costo_uyu.toFixed(2),
      variacionMesAnterior: variacion,
      comparacionPromedio: vs_promedio,
      costoPromedioPorKWh: (ultimoDato.costo_uyu / ultimoDato.consumo_kwh).toFixed(3)
    };
  }

  displayStatistics() {
    const stats = this.calculateStatistics();

    if (!stats) {
      console.log(chalk.yellow('⚠️ No hay datos para analizar'));
      return;
    }

    console.log(chalk.bold.cyan('\n📊 ESTADÍSTICAS DE CONSUMO\n'));

    const table = new Table({
      head: [chalk.bold('Métrica'), chalk.bold('Valor')],
      style: { head: [], border: ['grey'] },
      colWidths: [35, 25]
    });

    table.push(
      ['Consumo Total', `${stats.consumoTotal.toFixed(2)} kWh`],
      ['Costo Total', `$${stats.costoTotal.toFixed(2)}`],
      ['Consumo Promedio', `${stats.consumoPromedio.toFixed(2)} kWh`],
      ['Costo Promedio', `$${stats.costoPromedio.toFixed(2)}`],
      ['Consumo Máximo', `${stats.consumoMax.toFixed(2)} kWh`],
      ['Consumo Mínimo', `${stats.consumoMin.toFixed(2)} kWh`],
      ['$/kWh Promedio', `$${stats['$/kwhPromedio'].toFixed(3)}`],
      ['Desv. Estándar', `${stats.desviacionEstandar.toFixed(2)} kWh`],
      ['Períodos Analizados', `${stats.periodos} meses`]
    );

    console.log(table.toString());
  }

  displayAlerts() {
    const alerts = this.generateAlerts();

    console.log(chalk.bold.cyan('\n🚨 ALERTAS Y ESTADO\n'));

    for (const alert of alerts) {
      const levelColor = {
        'CRITICO': 'red',
        'IMPORTANTE': 'yellow',
        'INFO': 'cyan',
        'NORMAL': 'green'
      }[alert.level] || 'white';

      console.log(chalk[levelColor](`${alert.icon} ${alert.level}`));
      console.log(chalk.white(`   ${alert.message}`));
      console.log(chalk.gray(`   → ${alert.action}\n`));
    }
  }

  displayMonthlySummary() {
    const summary = this.generateMonthlySummary();

    if (!summary) {
      console.log(chalk.yellow('⚠️ No hay datos para mostrar resumen'));
      return;
    }

    console.log(chalk.bold.cyan(`\n📅 RESUMEN ${summary.mes.toUpperCase()} ${summary.año}\n`));

    const table = new Table({
      head: [chalk.bold('Concepto'), chalk.bold('Valor')],
      style: { head: [], border: ['grey'] },
      colWidths: [35, 25]
    });

    const varColor = summary.variacionMesAnterior >= 0 ? chalk.red : chalk.green;
    const vsPromColor = summary.comparacionPromedio >= 0 ? chalk.red : chalk.green;

    table.push(
      ['Consumo del Mes', `${summary.consumoMes} kWh`],
      ['Costo del Mes', `$${summary.costoMes}`],
      ['Variación Mes Anterior', varColor(`${summary.variacionMesAnterior > 0 ? '+' : ''}${summary.variacionMesAnterior}%`)],
      ['vs. Promedio Anual', vsPromColor(`${summary.comparacionPromedio > 0 ? '+' : ''}${summary.comparacionPromedio}%`)],
      ['Costo Promedio $/kWh', `$${summary.costoPromedioPorKWh}`]
    );

    console.log(table.toString());
  }

  displayAnomalies() {
    const anomalies = this.detectAnomalies();

    if (anomalies.length === 0) {
      console.log(chalk.green('\n✅ No se detectaron anomalías\n'));
      return;
    }

    console.log(chalk.bold.cyan(`\n🔍 ANOMALÍAS DETECTADAS (${anomalies.length})\n`));

    const table = new Table({
      head: [chalk.bold('Fecha'), chalk.bold('Consumo'), chalk.bold('Desv.Estd'), chalk.bold('Tipo')],
      style: { head: [], border: ['grey'] },
      colWidths: [15, 15, 12, 10]
    });

    for (const anomaly of anomalies) {
      const typeColor = anomaly.tipo === 'ALTO' ? chalk.red : chalk.blue;
      table.push([
        anomaly.fecha.toISOString().split('T')[0],
        `${anomaly.consumo.toFixed(2)} kWh`,
        anomaly.desviaciones,
        typeColor(anomaly.tipo)
      ]);
    }

    console.log(table.toString());
    console.log();
  }

  getTop5Consumo() {
    const sorted = [...this.data].sort((a, b) => b.consumo_kwh - a.consumo_kwh);
    return sorted.slice(0, 5).map((item, idx) => ({
      posicion: idx + 1,
      mes: item.mes,
      año: item.año,
      consumo: item.consumo_kwh,
      costo: item.costo_uyu
    }));
  }

  displayTop5() {
    const top5 = this.getTop5Consumo();

    console.log(chalk.bold.cyan('\n🏆 TOP 5 MESES CON MÁS CONSUMO\n'));

    const table = new Table({
      head: [chalk.bold('Posición'), chalk.bold('Mes/Año'), chalk.bold('Consumo'), chalk.bold('Costo')],
      style: { head: [], border: ['grey'] },
      colWidths: [12, 12, 15, 15]
    });

    const monthNames = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun',
                       'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];

    for (const item of top5) {
      const medals = ['🥇', '🥈', '🥉', '4️⃣', '5️⃣'];
      table.push([
        `${medals[item.posicion - 1]} ${item.posicion}`,
        `${monthNames[item.mes - 1]} ${item.año}`,
        `${item.consumo.toFixed(2)} kWh`,
        `$${item.costo.toFixed(2)}`
      ]);
    }

    console.log(table.toString());
  }

  getAnalysisSummary() {
    return {
      statistics: this.calculateStatistics(),
      trend: this.calculateTrend(),
      alerts: this.generateAlerts(),
      anomalies: this.detectAnomalies(),
      monthlySummary: this.generateMonthlySummary(),
      top5: this.getTop5Consumo()
    };
  }
}

module.exports = DataAnalyzer;
