const fs = require('fs-extra');
const path = require('path');

class ReportGenerator {
  constructor(reportDir = 'reportes') {
    this.reportDir = reportDir;
    fs.ensureDirSync(reportDir);
  }

  generateHTMLReport(data, analysis, year, month) {
    try {
      const monthNames = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
                         'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];

      const consumoData = data.map(d => ({
        fecha: `${d.mes}/${d.año}`,
        consumo: d.consumo_kwh,
        costo: d.costo_uyu
      }));

      const stats = analysis.statistics || {};
      const alerts = analysis.alerts || [];
      const anomalies = analysis.anomalies || [];
      const summary = analysis.monthlySummary || {};

      // Preparar datos para gráficos
      const labels = consumoData.map(d => d.fecha);
      const consumoValues = consumoData.map(d => d.consumo);
      const costoValues = consumoData.map(d => d.costo);

      const html = `
<!DOCTYPE html>
<html lang="es">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Reporte UTE - ${monthNames[month - 1] || 'Consumo'} ${year}</title>
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }

        body {
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            padding: 20px;
            color: #333;
        }

        .container {
            max-width: 1200px;
            margin: 0 auto;
            background: white;
            border-radius: 10px;
            box-shadow: 0 10px 40px rgba(0,0,0,0.2);
            overflow: hidden;
        }

        header {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            padding: 40px 30px;
            text-align: center;
        }

        header h1 {
            font-size: 2.5em;
            margin-bottom: 10px;
        }

        header p {
            font-size: 1.1em;
            opacity: 0.9;
        }

        .content {
            padding: 40px;
        }

        .grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
            gap: 20px;
            margin-bottom: 40px;
        }

        .card {
            background: #f8f9fa;
            border-left: 5px solid #667eea;
            padding: 20px;
            border-radius: 5px;
            transition: transform 0.2s;
        }

        .card:hover {
            transform: translateY(-5px);
            box-shadow: 0 5px 15px rgba(0,0,0,0.1);
        }

        .card h3 {
            color: #667eea;
            font-size: 0.9em;
            text-transform: uppercase;
            margin-bottom: 10px;
            letter-spacing: 1px;
        }

        .card .value {
            font-size: 2em;
            font-weight: bold;
            color: #333;
        }

        .card .unit {
            color: #999;
            font-size: 0.9em;
            margin-left: 5px;
        }

        .alerts {
            margin-bottom: 40px;
        }

        .alerts h2 {
            color: #333;
            margin-bottom: 20px;
            font-size: 1.5em;
            border-bottom: 2px solid #667eea;
            padding-bottom: 10px;
        }

        .alert {
            padding: 15px;
            margin-bottom: 10px;
            border-radius: 5px;
            border-left: 5px solid;
            display: flex;
            align-items: center;
            gap: 15px;
        }

        .alert.critico {
            background: #ffe0e0;
            border-left-color: #ff3333;
        }

        .alert.importante {
            background: #fff3cd;
            border-left-color: #ff9800;
        }

        .alert.info {
            background: #d1ecf1;
            border-left-color: #17a2b8;
        }

        .alert.normal {
            background: #d4edda;
            border-left-color: #28a745;
        }

        .alert-icon {
            font-size: 2em;
        }

        .alert-content h4 {
            margin-bottom: 5px;
            font-size: 1.1em;
        }

        .alert-content p {
            color: #666;
            font-size: 0.95em;
        }

        .charts-section {
            margin-bottom: 40px;
        }

        .charts-section h2 {
            color: #333;
            margin-bottom: 20px;
            font-size: 1.5em;
            border-bottom: 2px solid #667eea;
            padding-bottom: 10px;
        }

        .chart-container {
            position: relative;
            height: 400px;
            margin-bottom: 40px;
            background: #f8f9fa;
            padding: 20px;
            border-radius: 5px;
        }

        .table-section {
            margin-top: 40px;
        }

        .table-section h2 {
            color: #333;
            margin-bottom: 20px;
            font-size: 1.5em;
            border-bottom: 2px solid #667eea;
            padding-bottom: 10px;
        }

        table {
            width: 100%;
            border-collapse: collapse;
            background: white;
        }

        thead {
            background: #667eea;
            color: white;
        }

        th {
            padding: 12px;
            text-align: left;
            font-weight: 600;
        }

        td {
            padding: 12px;
            border-bottom: 1px solid #eee;
        }

        tbody tr:hover {
            background: #f8f9fa;
        }

        .positive {
            color: #28a745;
        }

        .negative {
            color: #ff3333;
        }

        .neutral {
            color: #999;
        }

        footer {
            background: #f8f9fa;
            padding: 20px;
            text-align: center;
            color: #999;
            font-size: 0.9em;
            border-top: 1px solid #eee;
        }

        @media (max-width: 768px) {
            .content {
                padding: 20px;
            }

            header h1 {
                font-size: 1.8em;
            }

            .grid {
                grid-template-columns: 1fr;
            }

            .chart-container {
                height: 300px;
            }

            table {
                font-size: 0.9em;
            }

            th, td {
                padding: 8px;
            }
        }

        @page {
            margin: 2cm;
        }

        @media print {
            body {
                background: white;
            }

            .container {
                box-shadow: none;
            }
        }
    </style>
</head>
<body>
    <div class="container">
        <header>
            <h1>📊 Reporte de Consumo UTE</h1>
            <p>${monthNames[month - 1] || 'Consumo'} ${year} | ${new Date().toLocaleDateString('es-ES')}</p>
        </header>

        <div class="content">
            <!-- Métricas principales -->
            <div class="grid">
                <div class="card">
                    <h3>Consumo del Mes</h3>
                    <div class="value">${summary.consumoMes || 'N/A'}<span class="unit">kWh</span></div>
                </div>
                <div class="card">
                    <h3>Costo del Mes</h3>
                    <div class="value">\$${summary.costoMes || '0.00'}<span class="unit">UYU</span></div>
                </div>
                <div class="card">
                    <h3>Costo/kWh</h3>
                    <div class="value">\$${summary.costoPromedioPorKWh || '0.000'}<span class="unit">/kWh</span></div>
                </div>
                <div class="card">
                    <h3>Promedio Anual</h3>
                    <div class="value">${stats.consumoPromedio ? stats.consumoPromedio.toFixed(2) : 'N/A'}<span class="unit">kWh</span></div>
                </div>
            </div>

            <!-- Alertas -->
            <div class="alerts">
                <h2>🚨 Alertas y Estado</h2>
                ${alerts.map(alert => {
                    const levelClass = alert.level.toLowerCase();
                    const icon = alert.icon || '⚠️';
                    return `
                <div class="alert ${levelClass}">
                    <div class="alert-icon">${icon}</div>
                    <div class="alert-content">
                        <h4>${alert.level}</h4>
                        <p><strong>${alert.message}</strong></p>
                        <p style="margin-top: 5px; font-style: italic;">→ ${alert.action}</p>
                    </div>
                </div>
                `;
                }).join('')}
            </div>

            <!-- Gráficos -->
            <div class="charts-section">
                <h2>📈 Gráficos de Consumo</h2>

                <div class="chart-container">
                    <canvas id="consumoChart"></canvas>
                </div>

                <div class="chart-container">
                    <canvas id="costoChart"></canvas>
                </div>
            </div>

            <!-- Top 5 Consumo -->
            <div class="table-section">
                <h2>🏆 Top 5 Meses con Más Consumo</h2>
                <table>
                    <thead>
                        <tr>
                            <th>Posición</th>
                            <th>Mes/Año</th>
                            <th>Consumo (kWh)</th>
                            <th>Costo (UYU)</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${analysis.top5 ? analysis.top5.map(item => {
                            const monthNames = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun',
                                              'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];
                            const medals = ['🥇', '🥈', '🥉', '4️⃣', '5️⃣'];
                            return `
                        <tr>
                            <td>${medals[item.posicion - 1]} ${item.posicion}</td>
                            <td>${monthNames[item.mes - 1]} ${item.año}</td>
                            <td>${item.consumo.toFixed(2)}</td>
                            <td>\$${item.costo.toFixed(2)}</td>
                        </tr>
                        `;
                        }).join('') : ''}
                    </tbody>
                </table>
            </div>

            <!-- Tabla de datos -->
            <div class="table-section">
                <h2>📋 Detalle Mensual</h2>
                <table>
                    <thead>
                        <tr>
                            <th>Período</th>
                            <th>Consumo (kWh)</th>
                            <th>Costo (UYU)</th>
                            <th>$/kWh</th>
                            <th>Variación %</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${consumoData.map((item, idx) => {
                            const prev = idx > 0 ? consumoData[idx - 1] : null;
                            const variacion = prev ?
                                (((item.consumo - prev.consumo) / prev.consumo) * 100).toFixed(1) :
                                '-';
                            const varClass = variacion === '-' ? 'neutral' :
                                variacion >= 0 ? 'negative' : 'positive';

                            return `
                        <tr>
                            <td>${item.fecha}</td>
                            <td>${item.consumo.toFixed(2)}</td>
                            <td>\$${item.costo.toFixed(2)}</td>
                            <td>\$${(item.costo / item.consumo).toFixed(3)}</td>
                            <td class="${varClass}">${variacion}${variacion !== '-' ? '%' : ''}</td>
                        </tr>
                        `;
                        }).join('')}
                    </tbody>
                </table>
            </div>

            <!-- Anomalías -->
            ${anomalies.length > 0 ? `
            <div class="table-section">
                <h2>🔍 Anomalías Detectadas</h2>
                <table>
                    <thead>
                        <tr>
                            <th>Fecha</th>
                            <th>Consumo (kWh)</th>
                            <th>Desv. Estd</th>
                            <th>Tipo</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${anomalies.map(anom => `
                        <tr>
                            <td>${anom.fecha.toISOString().split('T')[0]}</td>
                            <td>${anom.consumo.toFixed(2)}</td>
                            <td>${anom.desviaciones}</td>
                            <td class="${anom.tipo === 'ALTO' ? 'negative' : 'positive'}">${anom.tipo}</td>
                        </tr>
                        `).join('')}
                    </tbody>
                </table>
            </div>
            ` : ''}

            <!-- Estadísticas -->
            <div class="table-section">
                <h2>📊 Estadísticas Generales</h2>
                <table>
                    <thead>
                        <tr>
                            <th>Métrica</th>
                            <th>Valor</th>
                        </tr>
                    </thead>
                    <tbody>
                        <tr>
                            <td>Consumo Total</td>
                            <td>${stats.consumoTotal ? stats.consumoTotal.toFixed(2) : 'N/A'} kWh</td>
                        </tr>
                        <tr>
                            <td>Costo Total</td>
                            <td>\$${stats.costoTotal ? stats.costoTotal.toFixed(2) : 'N/A'}</td>
                        </tr>
                        <tr>
                            <td>Consumo Máximo</td>
                            <td>${stats.consumoMax ? stats.consumoMax.toFixed(2) : 'N/A'} kWh</td>
                        </tr>
                        <tr>
                            <td>Consumo Mínimo</td>
                            <td>${stats.consumoMin ? stats.consumoMin.toFixed(2) : 'N/A'} kWh</td>
                        </tr>
                        <tr>
                            <td>Tendencia</td>
                            <td>${analysis.trend || 'DESCONOCIDO'}</td>
                        </tr>
                    </tbody>
                </table>
            </div>
        </div>

        <footer>
            <p>Reporte generado automáticamente por UTE Monitor | ${new Date().toLocaleString('es-ES')}</p>
            <p>Este documento contiene datos privados. Manténlo seguro.</p>
        </footer>
    </div>

    <script>
        // Gráfico de Consumo
        const ctx1 = document.getElementById('consumoChart').getContext('2d');
        new Chart(ctx1, {
            type: 'line',
            data: {
                labels: ${JSON.stringify(labels)},
                datasets: [{
                    label: 'Consumo (kWh)',
                    data: ${JSON.stringify(consumoValues)},
                    borderColor: '#667eea',
                    backgroundColor: 'rgba(102, 126, 234, 0.1)',
                    borderWidth: 3,
                    fill: true,
                    tension: 0.4,
                    pointRadius: 5,
                    pointBackgroundColor: '#667eea',
                    pointBorderColor: '#fff',
                    pointBorderWidth: 2,
                    pointHoverRadius: 7
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: {
                        display: true,
                        labels: {
                            font: { size: 12 },
                            padding: 15
                        }
                    },
                    title: {
                        display: true,
                        text: 'Consumo de Energía - Últimos 12 Meses',
                        font: { size: 14, weight: 'bold' }
                    }
                },
                scales: {
                    y: {
                        beginAtZero: true,
                        title: {
                            display: true,
                            text: 'kWh'
                        }
                    }
                }
            }
        });

        // Gráfico de Costos
        const ctx2 = document.getElementById('costoChart').getContext('2d');
        new Chart(ctx2, {
            type: 'bar',
            data: {
                labels: ${JSON.stringify(labels)},
                datasets: [{
                    label: 'Costo (UYU)',
                    data: ${JSON.stringify(costoValues)},
                    backgroundColor: [
                        'rgba(102, 126, 234, 0.8)',
                        'rgba(102, 126, 234, 0.7)',
                        'rgba(102, 126, 234, 0.6)',
                        'rgba(102, 126, 234, 0.8)',
                        'rgba(102, 126, 234, 0.7)',
                        'rgba(102, 126, 234, 0.6)',
                        'rgba(102, 126, 234, 0.8)',
                        'rgba(102, 126, 234, 0.7)',
                        'rgba(102, 126, 234, 0.6)',
                        'rgba(102, 126, 234, 0.8)',
                        'rgba(102, 126, 234, 0.7)',
                        'rgba(102, 126, 234, 0.6)'
                    ],
                    borderColor: '#667eea',
                    borderWidth: 1,
                    borderRadius: 5
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: {
                        display: true,
                        labels: {
                            font: { size: 12 },
                            padding: 15
                        }
                    },
                    title: {
                        display: true,
                        text: 'Costo de Energía - Últimos 12 Meses',
                        font: { size: 14, weight: 'bold' }
                    }
                },
                scales: {
                    y: {
                        beginAtZero: true,
                        title: {
                            display: true,
                            text: 'UYU'
                        }
                    }
                }
            }
        });
    </script>
</body>
</html>
      `;

      const filename = path.join(
        this.reportDir,
        `reporte_${year}_${String(month).padStart(2, '0')}.html`
      );

      fs.writeFileSync(filename, html);
      console.log(`✅ Reporte guardado en: ${filename}`);
      return filename;

    } catch (error) {
      console.error('❌ Error generando reporte:', error.message);
      throw error;
    }
  }

  generateTextReport(data, analysis) {
    try {
      const stats = analysis.statistics || {};
      const alerts = analysis.alerts || [];

      let report = '\n' + '='.repeat(60) + '\n';
      report += 'REPORTE DE CONSUMO UTE\n';
      report += '='.repeat(60) + '\n\n';

      report += 'ESTADÍSTICAS:\n';
      report += '-'.repeat(40) + '\n';
      report += `Consumo Total: ${stats.consumoTotal?.toFixed(2)} kWh\n`;
      report += `Costo Total: $${stats.costoTotal?.toFixed(2)}\n`;
      report += `Consumo Promedio: ${stats.consumoPromedio?.toFixed(2)} kWh\n`;
      report += `$/kWh Promedio: $${stats['$/kwhPromedio']?.toFixed(3)}\n\n`;

      report += 'ALERTAS:\n';
      report += '-'.repeat(40) + '\n';
      for (const alert of alerts) {
        report += `${alert.icon} ${alert.level}\n`;
        report += `   ${alert.message}\n`;
        report += `   → ${alert.action}\n\n`;
      }

      report += '='.repeat(60) + '\n';
      report += `Generado: ${new Date().toLocaleString('es-ES')}\n`;
      report += '='.repeat(60) + '\n';

      return report;

    } catch (error) {
      console.error('Error generando reporte de texto:', error.message);
      return '';
    }
  }
}

module.exports = ReportGenerator;
