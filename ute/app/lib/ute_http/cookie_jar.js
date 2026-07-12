'use strict';

class CookieJar {
  constructor() {
    this.cookies = new Map();
  }

  storeFromHeaders(setCookieHeaders, originUrl) {
    const headers = Array.isArray(setCookieHeaders)
      ? setCookieHeaders
      : setCookieHeaders
        ? [setCookieHeaders]
        : [];

    for (const header of headers) {
      this.storeOne(header, originUrl);
    }
  }

  storeOne(header, originUrl) {
    const raw = String(header || '').trim();
    if (!raw) return;

    const parts = raw.split(';').map((part) => part.trim()).filter(Boolean);
    const [nameValue, ...attrs] = parts;
    const eqIndex = nameValue.indexOf('=');
    if (eqIndex <= 0) return;

    const name = nameValue.slice(0, eqIndex).trim();
    const value = nameValue.slice(eqIndex + 1).trim();
    const origin = new URL(originUrl);
    const cookie = {
      name,
      value,
      domain: origin.hostname,
      path: '/',
      secure: false,
      expiresAt: null,
    };

    for (const attr of attrs) {
      const [rawKey, ...rest] = attr.split('=');
      const key = String(rawKey || '').trim().toLowerCase();
      const attrValue = rest.join('=').trim();

      if (key === 'domain' && attrValue) cookie.domain = attrValue.replace(/^\./, '');
      if (key === 'path' && attrValue) cookie.path = attrValue;
      if (key === 'secure') cookie.secure = true;
      if (key === 'expires' && attrValue) {
        const expiresAt = Date.parse(attrValue);
        if (Number.isFinite(expiresAt)) cookie.expiresAt = expiresAt;
      }
      if (key === 'max-age' && attrValue) {
        const seconds = Number(attrValue);
        if (Number.isFinite(seconds)) cookie.expiresAt = Date.now() + (seconds * 1000);
      }
    }

    if (cookie.expiresAt && cookie.expiresAt <= Date.now()) {
      this.cookies.delete(this.cookieKey(cookie));
      return;
    }

    this.cookies.set(this.cookieKey(cookie), cookie);
  }

  getCookieHeader(url) {
    const target = new URL(url);
    const secureRequest = target.protocol === 'https:';
    const pairs = [];

    for (const cookie of this.cookies.values()) {
      if (cookie.expiresAt && cookie.expiresAt <= Date.now()) continue;
      if (cookie.secure && !secureRequest) continue;
      if (!domainMatches(target.hostname, cookie.domain)) continue;
      if (!target.pathname.startsWith(cookie.path)) continue;
      pairs.push(`${cookie.name}=${cookie.value}`);
    }

    return pairs.join('; ');
  }

  toJSON() {
    return [...this.cookies.values()].map((cookie) => ({ ...cookie }));
  }

  cookieKey(cookie) {
    return `${cookie.domain}|${cookie.path}|${cookie.name}`;
  }
}

function domainMatches(hostname, domain) {
  if (!hostname || !domain) return false;
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

module.exports = { CookieJar };
