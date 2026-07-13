'use strict';

const { createHash } = require('crypto');

const STATES = Object.freeze({
  LOGIN_FORM: 'LOGIN_FORM',
  USER_TYPE_SELECTION: 'USER_TYPE_SELECTION',
  ACCOUNT: 'ACCOUNT',
  AUTHENTICATED_INTERMEDIATE: 'AUTHENTICATED_INTERMEDIATE',
  HTTP_REDIRECT_PENDING: 'HTTP_REDIRECT_PENDING',
  JS_REDIRECT_OR_AUTOSUBMIT: 'JS_REDIRECT_OR_AUTOSUBMIT',
  PORTAL_ERROR: 'PORTAL_ERROR',
  PORTAL_MAINTENANCE: 'PORTAL_MAINTENANCE',
  SESSION_EXPIRED: 'SESSION_EXPIRED',
  CHALLENGE_OR_UNSUPPORTED: 'CHALLENGE_OR_UNSUPPORTED',
  UNKNOWN: 'UNKNOWN',
});

const SAFE_PORTAL_ORIGIN = 'https://autoservicio.ute.com.uy';
const SAFE_CONTROLLER_PREFIX = '/SelfService/SSvcController/';

function classifyPostLoginPage(response = {}, options = {}) {
  const html = String(response.text || '');
  const pathname = safePathname(response.url || options.url || '');
  const forms = inspectForms(html, response.url || options.url || SAFE_PORTAL_ORIGIN);
  const redirects = Array.isArray(response.redirects) ? response.redirects : [];
  const redirectPathnames = redirects
    .map((entry) => safePathname(entry.to || entry.url || entry.location || ''))
    .filter(Boolean);
  const fieldNames = [...new Set(forms.flatMap((form) => form.fieldNames))].slice(0, 40);
  const loginMarkerPresent = hasLoginMarker(html, forms);
  const accountMarkerPresent = hasAccountMarker(html, pathname);
  const selectionMarkerPresent = hasSelectionMarker(html, pathname, forms);
  const maintenanceMarkerPresent = /mantenimiento|fuera de servicio|temporalmente no disponible/i.test(html);
  const errorMarkerPresent = /ha ocurrido un error|error al procesar|error inesperado|servicio no disponible/i.test(html);
  const sessionExpiredMarkerPresent = /sesi[oó]n (?:ha )?expir|session (?:has )?expired|volv[eé] a iniciar sesi[oó]n/i.test(html);
  const challengeMarkerPresent = /captcha|recaptcha|cloudflare|verify you are human|access denied/i.test(html);
  const jsRedirectPresent = Boolean(extractJsRedirect(html));
  const autoSubmitPresent = hasAutoSubmit(html);
  const responseStatus = Number(response.status || 0) || null;
  const titleClass = classifyTitle(html);

  let state = STATES.UNKNOWN;
  let confidence = 'low';
  if (maintenanceMarkerPresent) {
    state = STATES.PORTAL_MAINTENANCE;
    confidence = 'high';
  } else if (challengeMarkerPresent) {
    state = STATES.CHALLENGE_OR_UNSUPPORTED;
    confidence = 'high';
  } else if (responseStatus && responseStatus >= 300 && responseStatus < 400) {
    state = STATES.HTTP_REDIRECT_PENDING;
    confidence = 'high';
  } else if (sessionExpiredMarkerPresent) {
    state = STATES.SESSION_EXPIRED;
    confidence = 'high';
  } else if (errorMarkerPresent) {
    state = STATES.PORTAL_ERROR;
    confidence = 'medium';
  } else if (accountMarkerPresent) {
    state = STATES.ACCOUNT;
    confidence = 'high';
  } else if (selectionMarkerPresent) {
    state = STATES.USER_TYPE_SELECTION;
    confidence = pathname.includes('navigateSelectUserType') ? 'high' : 'medium';
  } else if (jsRedirectPresent || autoSubmitPresent) {
    state = STATES.JS_REDIRECT_OR_AUTOSUBMIT;
    confidence = 'medium';
  } else if (loginMarkerPresent) {
    state = options.afterAuthentication ? STATES.LOGIN_FORM : STATES.LOGIN_FORM;
    confidence = 'high';
  } else if (isAuthenticatedIntermediate(pathname, html)) {
    state = STATES.AUTHENTICATED_INTERMEDIATE;
    confidence = 'medium';
  }

  return {
    state,
    confidence,
    statusCode: responseStatus,
    contentType: normalizeContentType(response.headers),
    pathname: sanitizeStructuralIdentifier(pathname),
    redirectPathnames: redirectPathnames.map(sanitizeStructuralIdentifier),
    formCount: forms.length,
    formMethods: [...new Set(forms.map((form) => form.method))],
    formActionPathnames: [...new Set(forms.map((form) => form.actionPathname).filter(Boolean))]
      .map(sanitizeStructuralIdentifier),
    fieldNames: fieldNames.map(sanitizeStructuralIdentifier),
    hiddenFieldCount: forms.reduce((count, form) => count + form.hiddenFieldCount, 0),
    selectCount: forms.reduce((count, form) => count + form.selectCount, 0),
    optionCount: forms.reduce((count, form) => count + form.optionCount, 0),
    linkCount: (html.match(/<a\b/gi) || []).length,
    scriptCount: (html.match(/<script\b/gi) || []).length,
    loginMarkerPresent,
    accountMarkerPresent,
    selectionMarkerPresent,
    errorMarkerPresent,
    maintenanceMarkerPresent,
    jsRedirectPresent,
    autoSubmitPresent,
    htmlLengthBucket: lengthBucket(html.length),
    titleClass,
    bodyFingerprint: html ? createHash('sha256').update(normalizeForFingerprint(html)).digest('hex').slice(0, 16) : null,
  };
}

function sanitizeStructuralIdentifier(value) {
  if (value === null || value === undefined) return value;
  return String(value).replace(/\d{5,}/g, '[id]');
}

function inspectForms(html, baseUrl) {
  const forms = [];
  const matches = String(html || '').matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/gi);
  for (const match of matches) {
    const attrs = parseAttributes(match[1]);
    const body = match[2];
    const action = safePortalUrl(attrs.action || '', baseUrl);
    const controls = parseControls(body);
    forms.push({
      method: String(attrs.method || 'GET').toUpperCase() === 'POST' ? 'POST' : 'GET',
      action,
      actionPathname: safePathname(action),
      fieldNames: controls.map((control) => control.name).filter(Boolean),
      hiddenFieldCount: controls.filter((control) => control.type === 'hidden').length,
      selectCount: controls.filter((control) => control.kind === 'select').length,
      optionCount: controls.reduce((count, control) => count + (control.options?.length || 0), 0),
      controls,
    });
  }
  return forms;
}

function buildSafeFormSubmission(form) {
  if (!form?.action || !isSafePortalUrl(form.action)) return { ok: false, reason: 'unsafe_action' };
  const values = {};
  for (const control of form.controls || []) {
    if (!control.name || control.disabled) continue;
    if (control.kind === 'select') {
      const enabled = control.options.filter((option) => !option.disabled);
      const selected = enabled.filter((option) => option.selected);
      if (selected.length === 1) values[control.name] = selected[0].value;
      else if (enabled.length === 1) values[control.name] = enabled[0].value;
      else return { ok: false, reason: 'selection_required' };
      continue;
    }
    if ((control.type === 'checkbox' || control.type === 'radio') && !control.checked) continue;
    if (control.type === 'submit' || control.type === 'button' || control.type === 'reset') continue;
    values[control.name] = control.value || '';
  }
  return { ok: true, method: form.method, action: form.action, values };
}

function extractJsRedirect(html) {
  const source = String(html || '');
  const match = source.match(/(?:window\.)?location(?:\.href)?\s*=\s*["']([^"']+)["']/i)
    || source.match(/location\.replace\(\s*["']([^"']+)["']\s*\)/i)
    || source.match(/<meta[^>]+http-equiv=["']?refresh["']?[^>]+content=["'][^"']*url=([^"'>\s]+)/i);
  return match ? match[1] : null;
}

function hasAutoSubmit(html) {
  return /\.submit\(\)|onload\s*=\s*["'][^"']*submit\(/i.test(String(html || ''));
}

function parseControls(html) {
  const controls = [];
  for (const match of String(html || '').matchAll(/<input\b([^>]*)>/gi)) {
    const attrs = parseAttributes(match[1]);
    controls.push({
      kind: 'input',
      name: attrs.name || '',
      type: String(attrs.type || 'text').toLowerCase(),
      value: attrs.value || '',
      checked: Object.prototype.hasOwnProperty.call(attrs, 'checked'),
      disabled: Object.prototype.hasOwnProperty.call(attrs, 'disabled'),
    });
  }
  for (const match of String(html || '').matchAll(/<select\b([^>]*)>([\s\S]*?)<\/select>/gi)) {
    const attrs = parseAttributes(match[1]);
    const options = [...match[2].matchAll(/<option\b([^>]*)>([\s\S]*?)<\/option>/gi)].map((option) => {
      const optionAttrs = parseAttributes(option[1]);
      return {
        value: optionAttrs.value || stripTags(option[2]).trim(),
        selected: Object.prototype.hasOwnProperty.call(optionAttrs, 'selected'),
        disabled: Object.prototype.hasOwnProperty.call(optionAttrs, 'disabled'),
      };
    });
    controls.push({ kind: 'select', name: attrs.name || '', disabled: Object.prototype.hasOwnProperty.call(attrs, 'disabled'), options });
  }
  return controls;
}

function parseAttributes(raw) {
  const attrs = {};
  for (const match of String(raw || '').matchAll(/([^\s=/>]+)(?:\s*=\s*(?:["']([^"']*)["']|([^\s"'=<>`]+)))?/g)) {
    attrs[match[1].toLowerCase()] = match[2] ?? match[3] ?? '';
  }
  return attrs;
}

function safePortalUrl(raw, baseUrl) {
  try {
    const url = new URL(raw || '', baseUrl || SAFE_PORTAL_ORIGIN);
    return isSafePortalUrl(url.href) ? url.href : null;
  } catch (_) {
    return null;
  }
}

function isSafePortalUrl(raw) {
  try {
    const url = new URL(raw);
    return url.origin === SAFE_PORTAL_ORIGIN && url.pathname.startsWith(SAFE_CONTROLLER_PREFIX);
  } catch (_) {
    return false;
  }
}

function safePathname(raw) {
  try { return new URL(raw, SAFE_PORTAL_ORIGIN).pathname; } catch (_) { return null; }
}

function normalizeContentType(headers) {
  if (!headers) return null;
  const value = typeof headers.get === 'function' ? headers.get('content-type') : headers['content-type'];
  return String(value || '').split(';')[0].trim().toLowerCase() || null;
}

function hasLoginMarker(html, forms) {
  return /name=["'](?:userId|password)["']/i.test(html) || forms.some((form) => form.fieldNames.includes('userId') || form.fieldNames.includes('password'));
}

function hasAccountMarker(html, pathname) {
  return /(?:n(?:u|ú)mero\s+de\s+cuenta|acuerdos?\s+de\s+servicio|mis\s+servicios|>\s*salir\s*<)/i.test(html)
    || /\/account$/i.test(pathname || '');
}

function hasSelectionMarker(html, pathname, forms) {
  return /navigateSelectUserType|seleccion(?:á|a|e)\s+(?:tipo|perfil|usuario)/i.test(`${pathname || ''}\n${html}`)
    || forms.some((form) => /navigateSelectUserType/i.test(form.actionPathname || ''));
}

function isAuthenticatedIntermediate(pathname, html) {
  return /\/SelfService\/SSvcController\/(?:authenticate|home|index|welcome)/i.test(pathname || '')
    || /cerrar sesi[oó]n|bienvenido/i.test(html);
}

function classifyTitle(html) {
  const title = String(html || '').match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '';
  if (/mantenimiento/i.test(title)) return 'maintenance';
  if (/error/i.test(title)) return 'error';
  if (/login|ingresar|acceso/i.test(title)) return 'login';
  if (title) return 'other';
  return 'missing';
}

function normalizeForFingerprint(html) {
  return String(html || '')
    .replace(/value=["'][^"']*["']/gi, 'value=""')
    .replace(/\b\d{6,}\b/g, '#')
    .replace(/\s+/g, ' ')
    .trim();
}

function lengthBucket(length) {
  if (!length) return 'empty';
  if (length < 2000) return 'small';
  if (length < 20000) return 'medium';
  return 'large';
}

function stripTags(text) {
  return String(text || '').replace(/<[^>]+>/g, ' ');
}

module.exports = {
  STATES,
  SAFE_PORTAL_ORIGIN,
  buildSafeFormSubmission,
  classifyPostLoginPage,
  extractJsRedirect,
  inspectForms,
  isSafePortalUrl,
  safePortalUrl,
};
