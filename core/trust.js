// trust.js — Extracted from favor.js
// Trust level determination and access control
//
// NOTE: getTrustLevel and isOperator depend on favor.js globals:
//   - resolvePhone(jid), verifiedNumbers (Set), config (object)
// These are passed in via the init() function to avoid circular deps.

let _resolvePhone = null;
let _verifiedNumbers = null;
let _config = null;

/**
 * Initialize trust module with favor.js globals.
 * Must be called once at startup before using getTrustLevel/isOperator.
 *
 * @param {Object} deps
 * @param {Function} deps.resolvePhone - Function to resolve JID to phone number
 * @param {Set} deps.verifiedNumbers - Set of verified phone numbers
 * @param {Object} deps.config - The bot config object
 */
function init(deps) {
  _resolvePhone = deps.resolvePhone;
  _verifiedNumbers = deps.verifiedNumbers;
  _config = deps.config;
}

/**
 * Update the config reference (called when config is reloaded).
 */
function updateConfig(newConfig) {
  _config = newConfig;
}

function getTrustLevel(jid) {
  const phone = _resolvePhone(jid);
  const opNum = (_config.whatsapp.operatorNumber || '').replace('+', '');

  // Operator (highest priority)
  if (!opNum) return 'operator'; // no operator set = backwards compat
  if (phone && (phone.includes(opNum) || _verifiedNumbers.has(phone))) return 'operator';

  // Explicit permissions in config
  const perms = _config.whatsapp.contactPermissions || {};
  for (const [num, level] of Object.entries(perms)) {
    if (phone && phone.includes(num.replace('+', ''))) return level;
  }

  // Trusted contacts default to staff
  const trusted = _config.whatsapp.trustedContacts || [];
  if (trusted.some(t => phone && phone.includes(t.replace('+', '')))) {
    return (_config.whatsapp.trustDefaults?.trustedContacts) || 'staff';
  }

  // Verified via security phrase
  if (phone && _verifiedNumbers.has(phone)) {
    return (_config.whatsapp.trustDefaults?.verified) || 'customer';
  }

  return 'guest';
}

function isOperator(jid) {
  return getTrustLevel(jid) === 'operator';
}

/**
 * Trust-level helper: returns true if this trust level should only see their own data.
 */
function isContactScoped(trustLevel) {
  return trustLevel === 'customer' || trustLevel === 'guest';
}

module.exports = { init, updateConfig, getTrustLevel, isOperator, isContactScoped };
