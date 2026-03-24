// utils/result.js — Standardized result format for all module returns
//
// Usage:
//   const { ok, fail } = require('./utils/result');
//   return ok('File written successfully');
//   return ok({ id: 123, content: '...' });
//   return fail('File not found');
//   return fail('Connection refused', 'LAPTOP_OFFLINE');

/**
 * Create a success result.
 * @param {any} data - The result data (string, object, array, etc.)
 * @returns {{ ok: true, data: any }}
 */
function ok(data) {
  return { ok: true, data };
}

/**
 * Create a failure result.
 * @param {string} error - Human-readable error message
 * @param {string} [code] - Machine-readable error code (e.g., 'LAPTOP_OFFLINE', 'RATE_LIMITED')
 * @returns {{ ok: false, error: string, code?: string }}
 */
function fail(error, code) {
  const result = { ok: false, error };
  if (code) result.code = code;
  return result;
}

/**
 * Check if a value is a standardized result object.
 * @param {any} val
 * @returns {boolean}
 */
function isResult(val) {
  return val && typeof val === 'object' && typeof val.ok === 'boolean';
}

module.exports = { ok, fail, isResult };
