'use strict';

const crypto = require('crypto');

const SCHEMA_VERSION = '2.0.0';
const CURRENT_DISCOVERY_REVISION = 2;

function normalizeString(value) {
  return String(value || '').trim();
}

function computeStableKey(parts) {
  const raw = (Array.isArray(parts) ? parts : [parts])
    .map((part) => normalizeString(part))
    .filter(Boolean)
    .join('|')
    .toLowerCase();

  const digest = crypto.createHash('sha1').update(raw || 'legacy').digest('hex');
  return `k_${digest.slice(0, 16)}`;
}

function preserveOrComputeKey(value, parts) {
  const current = normalizeString(value);
  return /^k_[0-9a-f]{16}$/.test(current) ? current : computeStableKey(parts);
}

function normalizeCapabilities(value) {
  return {
    hasAMI: !!value?.hasAMI,
    supportsMaxDemand: !!value?.supportsMaxDemand,
    supportsDailyDetail: !!value?.supportsDailyDetail,
    canEstimateTRT: !!value?.canEstimateTRT,
  };
}

function normalizeTariff(value = {}) {
  return {
    code: normalizeString(value.code),
    name: normalizeString(value.name) || 'TRT',
    version: normalizeString(value.version),
    effectiveFrom: normalizeString(value.effectiveFrom),
    effectiveTo: normalizeString(value.effectiveTo),
    currency: normalizeString(value.currency || 'UYU'),
    hasUnknownFields: !!value?.hasUnknownFields,
  };
}

function normalizeSupply(raw) {
  const accountAlias = normalizeString(raw.accountAlias);
  const accountId = normalizeString(raw.accountId);
  const accountNumber = normalizeString(raw.accountNumber);
  const supplyAlias = normalizeString(raw.alias || raw.supplyAlias || raw.name);
  const technicalSource = raw.technical && typeof raw.technical === 'object'
    ? raw.technical
    : raw;
  const technical = {
    saId: normalizeString(technicalSource.saId),
    spId: normalizeString(technicalSource.spId),
    meterId: normalizeString(technicalSource.meterId),
    badge: normalizeString(technicalSource.badge),
    psId: normalizeString(technicalSource.psId),
  };

  const meters = Array.isArray(raw.meters)
    ? raw.meters.map((meter) => ({
      meterKey: preserveOrComputeKey(meter.meterKey, [accountId, accountNumber, technical.saId, normalizeString(meter.id || meter.meterId), normalizeString(meter.type)]),
      id: normalizeString(meter.id || meter.meterId),
      label: normalizeString(meter.label || 'Medidor'),
      type: normalizeString(meter.type || 'electricity'),
      status: normalizeString(meter.status || 'unknown'),
    }))
    : [];

  const providers = raw.providers && typeof raw.providers === 'object' ? raw.providers : {};
  const mobile = providers.mobileApi || {};
  return {
    supplyKey: preserveOrComputeKey(
      raw.supplyKey,
      [accountId, accountNumber, normalizeString(raw.supplyId), technical.saId, technical.spId, mobile.serviceAgreementId, mobile.servicePointId]
        .filter(Boolean).length > 2
        ? [accountId, accountNumber, normalizeString(raw.supplyId), technical.saId, technical.spId, mobile.serviceAgreementId, mobile.servicePointId]
        : [accountId, accountNumber, supplyAlias, normalizeString(raw.location)]
    ),
    alias: supplyAlias,
    location: normalizeString(raw.location),
    capabilities: normalizeCapabilities(raw.capabilities || {}),
    tariffs: Array.isArray(raw.tariffs) ? raw.tariffs.map(normalizeTariff) : [],
    meters,
    technical,
    providers,
    selectedByDefault: !!raw.selectedByDefault,
  };
}

function normalizeAccount(raw) {
  const accountAlias = normalizeString(raw.accountAlias || raw.accountLabel || raw.alias || raw.label);
  const accountNumber = normalizeString(raw.accountNumber);
  const accountId = normalizeString(raw.accountId);

  return {
    accountKey: preserveOrComputeKey(
      raw.accountKey,
      accountId || accountNumber ? [accountId, accountNumber] : [accountAlias]
    ),
    alias: accountAlias || `Cuenta ${accountNumber || 'personal'}`,
    accountNumber,
    accountId,
    supplies: Array.isArray(raw.supplies)
      ? raw.supplies.map((supply) => normalizeSupply({ ...supply, accountAlias, accountNumber, accountId }))
      : [],
  };
}

function normalizePortalIdentity(raw) {
  return {
    schemaVersion: SCHEMA_VERSION,
    discoveryRevision: Number.isInteger(Number(raw?.discoveryRevision))
      ? Number(raw.discoveryRevision)
      : 0,
    generatedAt: normalizeString(raw?.generatedAt) || new Date().toISOString(),
    source: normalizeString(raw?.source || 'unknown'),
    userHints: {
      userIdMask: normalizeString(raw?.userHints?.userIdMask) || maskValue(raw?.userId),
      hasPasswordStored: raw?.userHints?.hasPasswordStored === true || Boolean(raw && raw.hasPasswordStored),
    },
    accounts: Array.isArray(raw?.accounts) ? raw.accounts.map(normalizeAccount) : [],
  };
}

function flattenSupplies(portfolio) {
  return (portfolio?.accounts || []).flatMap((account) =>
    (account.supplies || []).map((supply) => ({ account, supply }))
  );
}

function createSupplyContext(portfolio, supplyKey) {
  const match = flattenSupplies(portfolio).find(({ supply }) => supply.supplyKey === supplyKey);
  if (!match) {
    const error = new Error(`Suministro no encontrado: ${supplyKey}`);
    error.code = 'SUPPLY_NOT_FOUND';
    throw error;
  }
  const { account, supply } = match;
  return Object.freeze({
    supplyKey: supply.supplyKey,
    accountKey: account.accountKey,
    accountNumber: account.accountNumber,
    accountAlias: account.alias,
    supplyAlias: supply.alias,
    location: supply.location,
    technical: Object.freeze({ ...(supply.technical || {}) }),
    providers: Object.freeze({ ...(supply.providers || {}) }),
    capabilities: Object.freeze({ ...(supply.capabilities || {}) }),
  });
}

function discoverPortfolioFromLegacy(legacyContext = {}) {
  const supplyAlias = normalizeString(legacyContext.supplyAlias || legacyContext.alias || 'Suministro principal');

  return normalizePortalIdentity({
    source: 'legacy-single-supply',
    hasPasswordStored: true,
    accounts: [
      {
        accountAlias: normalizeString(legacyContext.accountAlias || 'Cuenta personal UTE'),
        accountNumber: normalizeString(legacyContext.accountNumber),
        accountId: normalizeString(legacyContext.accountId || legacyContext.accountNumber || 'legacy-account'),
        supplies: [
          {
            alias: supplyAlias,
            location: normalizeString(legacyContext.location || 'Dirección no disponible'),
            tariffs: [normalizeTariff(legacyContext.tariff || {})],
            capabilities: legacyContext.capabilities || {
              hasAMI: true,
              supportsMaxDemand: true,
              supportsDailyDetail: true,
              canEstimateTRT: true,
            },
            meters: [
              {
                id: normalizeString(legacyContext.meterId),
                meterKey: normalizeString(legacyContext.meterKey),
                label: 'Medidor principal',
                type: 'electricity',
                status: 'ok',
              },
            ],
            saId: normalizeString(legacyContext.saId),
            spId: normalizeString(legacyContext.spId),
            meterId: normalizeString(legacyContext.meterId),
            badge: normalizeString(legacyContext.badge),
            selectedByDefault: true,
          },
        ],
      },
    ],
  });
}

function maskValue(value) {
  const text = String(value || '');
  if (!text) return null;
  return `u_${computeStableKey([text]).slice(0, 12)}`;
}

function sanitizeDiagnostic(portfolio) {
  const raw = normalizePortalIdentity(portfolio);
  const accountsCount = raw.accounts.length;
  const supplies = raw.accounts.flatMap((account) => account.supplies);

  return {
    schemaVersion: raw.schemaVersion,
    source: raw.source,
    generatedAt: raw.generatedAt,
    counts: {
      accounts: accountsCount,
      supplies: supplies.length,
    },
    supplyKeys: supplies.map((supply) => supply.supplyKey),
    capabilities: supplies.map((supply) => ({
      supplyKey: supply.supplyKey,
      hasAMI: supply.capabilities.hasAMI,
      canEstimateTRT: supply.capabilities.canEstimateTRT,
      hasUnknownFields: !!(supply.capabilities && supply.capabilities.hasUnknownFields),
    })),
    stages: supplies.length
      ? supplies.map((supply) => ({ supplyKey: supply.supplyKey, hasMeters: Boolean(supply.meters.length) }))
      : [],
  };
}

function validatePortalIdentity(portfolio) {
  if (!portfolio || typeof portfolio !== 'object') {
    return { ok: false, errors: ['portfolio.invalid'] };
  }

  const accounts = Array.isArray(portfolio.accounts) ? portfolio.accounts : [];
  const errors = [];

  if (!portfolio.schemaVersion || typeof portfolio.schemaVersion !== 'string') {
    errors.push('schemaVersion.missing');
  }

  if (!accounts.length) {
    errors.push('accounts.empty');
  }

  for (const account of accounts) {
    if (!account.accountKey) {
      errors.push('account.accountKey.missing');
    }
    if (!Array.isArray(account.supplies) || !account.supplies.length) {
      errors.push(`account.supplies.missing:${account.accountKey || 'unknown'}`);
      continue;
    }
    for (const supply of account.supplies) {
      if (!supply.supplyKey) {
        errors.push(`supply.supplyKey.missing:${account.accountKey || 'unknown'}`);
      }
      if (!supply.location) {
        errors.push(`supply.location.missing:${supply.supplyKey || account.accountKey || 'unknown'}`);
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

module.exports = {
  SCHEMA_VERSION,
  CURRENT_DISCOVERY_REVISION,
  computeStableKey,
  normalizePortalIdentity,
  normalizeAccount,
  normalizeSupply,
  normalizeCapabilities,
  discoverPortfolioFromLegacy,
  sanitizeDiagnostic,
  validatePortalIdentity,
  createSupplyContext,
  flattenSupplies,
};
