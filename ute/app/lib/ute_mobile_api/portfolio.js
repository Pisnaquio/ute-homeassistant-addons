'use strict';

const { normalizePortalIdentity } = require('../portfolio_contract');

function capability(state) { return state || 'unknown'; }

function mobileApiPortfolio(discovered) {
  return normalizePortalIdentity({
    source: 'mobile-api',
    discoveryRevision: 3,
    accounts: discovered.map(({ account, services }) => ({
      accountId: account.accountId,
      accountAlias: account.alias || account.address || 'Cuenta UTE',
      // Ningún identificador de SelfService se fabrica desde la API móvil.
      supplies: services.map((service) => ({
        supplyId: `${account.accountId}|${service.serviceAgreementId}|${service.servicePointId}`,
        alias: service.shortAddress || service.address || service.tariffDescription || 'Suministro UTE',
        location: service.address || service.shortAddress || 'Ubicación no disponible',
        tariffs: [{ code: service.tariff, name: service.tariffDescription || service.tariff || 'Desconocida' }],
        meters: service.meterId ? [{ id: service.meterId, label: 'Medidor', type: 'electricity', status: 'unknown' }] : [],
        capabilities: { hasAMI: Boolean(service.amiPresent), supportsMaxDemand: false, supportsDailyDetail: false, canEstimateTRT: service.tariff === 'TRT' },
        providers: { mobileApi: {
          accountId: account.accountId,
          serviceAgreementId: service.serviceAgreementId,
          servicePointId: service.servicePointId,
          meterId: service.meterId || '',
          tariff: service.tariff || '',
          isAuthorized: account.isAuthorized !== false,
          thirdParty: Boolean(account.thirdParty),
          serviceAgreementStatus: service.serviceAgreementStatus,
          capabilities: { discovery: capability('supported'), monthly: capability('unsupported'), current: capability('supported'), daily: capability('unsupported'), invoices: capability('supported'), status: capability('supported') },
        } },
      })),
    })),
  });
}

module.exports = { mobileApiPortfolio };
