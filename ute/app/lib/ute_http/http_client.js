'use strict';

const { CookieJar } = require('./cookie_jar');

class HttpClient {
  constructor(options = {}) {
    this.cookieJar = options.cookieJar || new CookieJar();
    this.userAgent = options.userAgent || 'UTE-HTTP-Client-Spike/0.1';
    this.followRedirects = options.followRedirects !== false;
  }

  async get(url, options = {}) {
    return this.request(url, { ...options, method: 'GET' });
  }

  async postForm(url, form, options = {}) {
    const body = new URLSearchParams();
    Object.entries(form || {}).forEach(([key, value]) => {
      if (value !== undefined && value !== null) body.set(key, String(value));
    });

    return this.request(url, {
      ...options,
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        ...(options.headers || {}),
      },
      body,
    });
  }

  async request(url, options = {}) {
    let currentUrl = url;
    let method = options.method || 'GET';
    let body = options.body;
    let redirectCount = 0;
    const redirects = [];
    let headers = new Headers(options.headers || {});

    while (true) {
      headers = prepareHeaders(headers, currentUrl, this.cookieJar, this.userAgent);

      const response = await fetch(currentUrl, {
        method,
        headers,
        body,
        redirect: 'manual',
      });

      this.cookieJar.storeFromHeaders(getSetCookieHeaders(response.headers), currentUrl);

      if (this.followRedirects && isRedirectStatus(response.status)) {
        const location = response.headers.get('location');
        if (!location) {
          return finalizeResponse(response, { redirects });
        }

        redirectCount += 1;
        if (redirectCount > 10) {
          throw new Error('Demasiados redirects al pedir un endpoint autenticado');
        }

        const nextUrl = new URL(location, currentUrl).href;
        redirects.push({
          status: response.status,
          from: safeUrlForDiagnostic(currentUrl),
          to: safeUrlForDiagnostic(nextUrl),
        });
        const shouldSwitchToGet =
          response.status === 303 ||
          ((response.status === 301 || response.status === 302) && method !== 'GET' && method !== 'HEAD');

        if (shouldSwitchToGet) {
          method = 'GET';
          body = undefined;
          headers.delete('content-type');
        }

        headers.set('referer', currentUrl);
        currentUrl = nextUrl;
        continue;
      }

      return finalizeResponse(response, { redirects });
    }
  }
}

function prepareHeaders(baseHeaders, url, cookieJar, userAgent) {
  const headers = new Headers(baseHeaders);
  headers.set('user-agent', userAgent);
  if (!headers.has('accept')) headers.set('accept', '*/*');

  const cookieHeader = cookieJar.getCookieHeader(url);
  if (cookieHeader) headers.set('cookie', cookieHeader);
  else headers.delete('cookie');

  return headers;
}

async function finalizeResponse(response, extra = {}) {
  const buffer = Buffer.from(await response.arrayBuffer());
  const text = buffer.toString('utf8');
  return {
    ok: response.ok,
    status: response.status,
    url: response.url,
    headers: response.headers,
    redirects: extra.redirects || [],
    buffer,
    text,
  };
}

function safeUrlForDiagnostic(value) {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch (_) {
    return '';
  }
}

function isRedirectStatus(status) {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function getSetCookieHeaders(headers) {
  if (typeof headers.getSetCookie === 'function') {
    return headers.getSetCookie();
  }

  const single = headers.get('set-cookie');
  return single ? splitSetCookieHeader(single) : [];
}

function splitSetCookieHeader(headerValue) {
  const result = [];
  let current = '';
  let inExpires = false;

  for (let i = 0; i < headerValue.length; i += 1) {
    const char = headerValue[i];
    const next = headerValue.slice(i, i + 8).toLowerCase();

    if (next === 'expires=') inExpires = true;
    if (inExpires && char === ';') inExpires = false;

    if (char === ',' && !inExpires) {
      result.push(current.trim());
      current = '';
      continue;
    }

    current += char;
  }

  if (current.trim()) result.push(current.trim());
  return result;
}

module.exports = { HttpClient };
