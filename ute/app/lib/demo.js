/**
 * Demo data generator para pruebas sin credenciales reales
 */

function generateDemoData() {
  // Tasa de cambio aproximada: 1 USD = 43 UYU (actualizar según necesario)
  const tasaCambio = 43;

  const data = [
    // 2024
    { mes: 1, año: 2024, fecha: new Date(2024, 0, 1), consumo_kwh: 95.5, costo_uyu: 47.75 * tasaCambio },
    { mes: 2, año: 2024, fecha: new Date(2024, 1, 1), consumo_kwh: 102.3, costo_uyu: 51.15 * tasaCambio },
    { mes: 3, año: 2024, fecha: new Date(2024, 2, 1), consumo_kwh: 85.2, costo_uyu: 42.60 * tasaCambio },
    { mes: 4, año: 2024, fecha: new Date(2024, 3, 1), consumo_kwh: 78.9, costo_uyu: 39.45 * tasaCambio },
    { mes: 5, año: 2024, fecha: new Date(2024, 4, 1), consumo_kwh: 92.1, costo_uyu: 46.05 * tasaCambio },
    { mes: 6, año: 2024, fecha: new Date(2024, 5, 1), consumo_kwh: 115.7, costo_uyu: 57.85 * tasaCambio },
    { mes: 7, año: 2024, fecha: new Date(2024, 6, 1), consumo_kwh: 125.4, costo_uyu: 62.70 * tasaCambio },
    { mes: 8, año: 2024, fecha: new Date(2024, 7, 1), consumo_kwh: 135.8, costo_uyu: 67.90 * tasaCambio },
    { mes: 9, año: 2024, fecha: new Date(2024, 8, 1), consumo_kwh: 98.2, costo_uyu: 49.10 * tasaCambio },
    { mes: 10, año: 2024, fecha: new Date(2024, 9, 1), consumo_kwh: 88.5, costo_uyu: 44.25 * tasaCambio },
    { mes: 11, año: 2024, fecha: new Date(2024, 10, 1), consumo_kwh: 105.3, costo_uyu: 52.65 * tasaCambio },
    { mes: 12, año: 2024, fecha: new Date(2024, 11, 1), consumo_kwh: 142.1, costo_uyu: 71.05 * tasaCambio },

    // 2025
    { mes: 1, año: 2025, fecha: new Date(2025, 0, 1), consumo_kwh: 138.5, costo_uyu: 69.25 * tasaCambio },
  ];

  return data;
}

module.exports = {
  generateDemoData
};
