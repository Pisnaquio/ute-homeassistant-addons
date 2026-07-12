'use strict';

const { PDFParse } = require('pdf-parse');

async function parseBillPdfBuffer(buffer, fallback = {}) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) {
    throw new Error('PDF de factura vacio');
  }

  const parser = new PDFParse({ data: buffer });
  try {
    const result = await parser.getText();
    return parseBillDetailText(result.text, fallback);
  } finally {
    await parser.destroy();
  }
}

function parseBillDetailText(text, fallback = {}) {
  const flat = normalizeText(text);
  const numberPattern = '([\\d.,]+(?:\\s+[\\d.,]+)*)';
  const periodoMatch = flat.match(/Per[ií]odo\s+de\s+Consumo\s+(\d{2}\/\d{2}\/\d{4})\s+a\s+(\d{2}\/\d{2}\/\d{4})/i);
  if (!periodoMatch) {
    throw new Error('No pude leer el periodo de consumo en la factura PDF');
  }

  const consumoMatch = flat.match(new RegExp(`Consumo Activo\\s*\\(kWh\\)\\s*${numberPattern}`, 'i'));
  if (!consumoMatch) {
    throw new Error('No pude leer el consumo total en la factura PDF');
  }

  const valleMatch = flat.match(new RegExp(`\\bValle\\s+${numberPattern}\\s*kWh`, 'i'));
  const llanoMatch = flat.match(new RegExp(`\\bLlano\\s+${numberPattern}\\s*kWh`, 'i'));
  if (!valleMatch || !llanoMatch) {
    throw new Error('No pude leer los tramos valle/llano en la factura PDF');
  }

  const puntaHab = extractOptionalNumber(flat, new RegExp(`Punta\\s+d[ií]as\\s+h[aá]b(?:iles|\\s*\\.)?\\s+${numberPattern}\\s*kWh`, 'i'));
  const puntaNoHab = extractOptionalNumber(flat, new RegExp(`Punta\\s+NO\\s+h[aá]b(?:iles|\\s*\\.)?\\s+${numberPattern}\\s*kWh`, 'i'));
  const consumo = roundNumber(parseSpanishNumber(consumoMatch[1]));
  const valle = roundNumber(parseSpanishNumber(valleMatch[1]));
  const llano = roundNumber(parseSpanishNumber(llanoMatch[1]));
  let punta = roundNumber(puntaHab + puntaNoHab);

  if (punta <= 0) {
    punta = roundNumber(consumo - valle - llano);
  }
  if (punta < 0) {
    throw new Error('La factura PDF devolvio tramos inconsistentes');
  }

  const fechaFinIso = portalSlashDateToIso(periodoMatch[2]);
  const fechaFin = new Date(fechaFinIso);
  const costo = Number(fallback.costo_uyu || 0);

  return {
    mes: fechaFin.getMonth() + 1,
    año: fechaFin.getFullYear(),
    fecha: fechaFinIso,
    consumo_kwh: consumo,
    punta_kwh: punta,
    valle_kwh: valle,
    llano_kwh: llano,
    costo_uyu: costo,
  };
}

function normalizeText(text) {
  return String(text || '')
    .replace(/[\u00a0\u202f\u2007]/g, ' ')
    .replace(/[\u200b\u00ad]/g, '')
    .replace(/[ ]+\n/g, '\n')
    .replace(/\n+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseSpanishNumber(text) {
  return Number(
    String(text || '0')
      .replace(/\s+/g, '')
      .replace(/\./g, '')
      .replace(',', '.')
      .trim()
  ) || 0;
}

function extractOptionalNumber(text, pattern) {
  const match = String(text || '').match(pattern);
  return match ? parseSpanishNumber(match[1]) : 0;
}

function portalSlashDateToIso(text) {
  const parts = String(text || '').split('/').map(Number);
  return `${parts[2]}-${String(parts[1]).padStart(2, '0')}-${String(parts[0]).padStart(2, '0')}`;
}

function roundNumber(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

module.exports = {
  parseBillDetailText,
  parseBillPdfBuffer,
};
