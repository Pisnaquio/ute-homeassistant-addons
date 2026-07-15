'use strict';

class UteMobileApiError extends Error {
  constructor(code, message, details = {}) {
    super(message || code);
    this.name = 'UteMobileApiError';
    this.code = code;
    this.statusCode = details.statusCode;
    this.retryAfterMs = details.retryAfterMs;
    this.cause = details.cause;
  }
}

function apiError(code, message, details) {
  return new UteMobileApiError(code, message, details);
}

module.exports = { UteMobileApiError, apiError };
