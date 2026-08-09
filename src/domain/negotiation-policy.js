'use strict';

const { canonicalHash } = require('./canonical');

const QUOTE_REASON_CODES = Object.freeze([
  'QUOTE_OK',
  'QUOTE_NOT_BINDING',
  'QUOTE_EXPIRED',
  'QUOTE_INTEGRITY_MISMATCH',
  'QUOTE_SESSION_MISMATCH',
  'QUOTE_MERCHANT_NOT_ALLOWED',
  'QUOTE_MCC_NOT_ALLOWED',
  'QUOTE_RESOURCE_MISMATCH',
  'QUOTE_PURPOSE_NOT_ALLOWED',
  'QUOTE_CURRENCY_NOT_ALLOWED',
  'QUOTE_BUDGET_CURRENCY_MISMATCH',
  'QUOTE_AMOUNT_INVALID',
  'QUOTE_CEILING_EXCEEDED',
  'QUOTE_BUDGET_EXCEEDED',
  'QUOTE_TERMS_NOT_ALLOWED',
  'NEGOTIATION_ROUNDS_EXCEEDED',
  'QUOTE_APPROVAL_REQUIRED',
  'QUOTE_TIMESTAMP_INVALID',
]);

const QUOTE_REASON_TEXT = Object.freeze({
  QUOTE_OK: 'The binding quote satisfies the negotiation policy.',
  QUOTE_NOT_BINDING: 'The merchant response is not a binding quote.',
  QUOTE_EXPIRED: 'The merchant quote has expired.',
  QUOTE_INTEGRITY_MISMATCH: 'The quote digest does not match its terms.',
  QUOTE_SESSION_MISMATCH: 'The quote does not belong to the active negotiation session.',
  QUOTE_MERCHANT_NOT_ALLOWED: 'The quoted merchant is not allowed.',
  QUOTE_MCC_NOT_ALLOWED: 'The quoted merchant category is not allowed.',
  QUOTE_RESOURCE_MISMATCH: 'The quote is for a different recovery artifact.',
  QUOTE_PURPOSE_NOT_ALLOWED: 'The quote is for an unapproved purpose.',
  QUOTE_CURRENCY_NOT_ALLOWED: 'The quote currency is not allowed.',
  QUOTE_BUDGET_CURRENCY_MISMATCH: 'The quote and mission budget use different currencies.',
  QUOTE_AMOUNT_INVALID: 'The quote amount must be a positive safe integer in minor units.',
  QUOTE_CEILING_EXCEEDED: 'The quote exceeds the negotiation ceiling.',
  QUOTE_BUDGET_EXCEEDED: 'The quote would exceed the remaining mission budget.',
  QUOTE_TERMS_NOT_ALLOWED: 'The quote includes terms outside the approved envelope.',
  NEGOTIATION_ROUNDS_EXCEEDED: 'The negotiation exceeded its maximum number of rounds.',
  QUOTE_APPROVAL_REQUIRED: 'Human approval is required for this quote.',
  QUOTE_TIMESTAMP_INVALID: 'The quote contains an invalid timestamp.',
});

const QUOTE_DIGEST_FIELDS = Object.freeze([
  'quoteId',
  'sessionId',
  'merchantId',
  'merchantName',
  'providerId',
  'mcc',
  'contentRoot',
  'purpose',
  'amountMinor',
  'currency',
  'terms',
  'binding',
  'issuedAt',
  'expiresAt',
]);

function quoteCommitment(quote = {}) {
  return QUOTE_DIGEST_FIELDS.reduce((result, field) => {
    result[field] = quote[field];
    return result;
  }, {});
}

function createQuoteDigest(quote) {
  return canonicalHash(quoteCommitment(quote));
}

function result(code, details) {
  const allowed = code === 'QUOTE_OK';
  return Object.freeze({
    allowed,
    approved: allowed,
    code,
    reasonCode: code,
    reason: QUOTE_REASON_TEXT[code],
    ...(details ? { details: Object.freeze({ ...details }) } : {}),
  });
}

function includesNormalized(values, candidate) {
  if (!Array.isArray(values)) return false;
  const normalized = String(candidate ?? '').trim().toLowerCase();
  return values.some((value) => String(value).trim().toLowerCase() === normalized);
}

function timestamp(value) {
  const milliseconds = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(milliseconds) ? milliseconds : null;
}

function termsAllowed(actual, required) {
  if (!actual || typeof actual !== 'object' || Array.isArray(actual)) return false;
  if (!required || typeof required !== 'object' || Array.isArray(required)) return false;
  const allowedKeys = Object.keys(required).sort();
  const actualKeys = Object.keys(actual).sort();
  if (allowedKeys.length !== actualKeys.length) return false;
  if (allowedKeys.some((key, index) => key !== actualKeys[index])) return false;
  return allowedKeys.every((key) => actual[key] === required[key]);
}

/**
 * Fail-closed validation for a binding merchant quote. This is intentionally
 * separate from payment policy: a valid quote must still pass evaluatePolicy
 * before any Rain card or transaction is created.
 */
function evaluateQuote({
  mission = {},
  policy = {},
  quote = {},
  expectedSessionId,
  roundCount = 0,
  now = Date.now(),
  humanApproved = false,
} = {}) {
  if (quote.binding !== true) return result('QUOTE_NOT_BINDING');
  if (!expectedSessionId || quote.sessionId !== expectedSessionId) {
    return result('QUOTE_SESSION_MISMATCH');
  }
  if (typeof quote.quoteDigest !== 'string' || createQuoteDigest(quote) !== quote.quoteDigest) {
    return result('QUOTE_INTEGRITY_MISMATCH');
  }

  const nowMs = timestamp(now);
  const expiryMs = timestamp(quote.expiresAt);
  const issuedMs = timestamp(quote.issuedAt);
  if (nowMs === null || expiryMs === null || issuedMs === null || expiryMs <= issuedMs) {
    return result('QUOTE_TIMESTAMP_INVALID');
  }
  if (nowMs >= expiryMs) return result('QUOTE_EXPIRED');

  if (!includesNormalized(policy.allowedMerchantIds, quote.merchantId)) {
    return result('QUOTE_MERCHANT_NOT_ALLOWED', { merchantId: quote.merchantId ?? null });
  }
  if (!includesNormalized(policy.allowedMccs, quote.mcc)) {
    return result('QUOTE_MCC_NOT_ALLOWED', { mcc: quote.mcc ?? null });
  }
  if (quote.contentRoot !== mission.contentRoot) return result('QUOTE_RESOURCE_MISMATCH');
  if (quote.purpose !== policy.requiredTerms?.service) {
    return result('QUOTE_PURPOSE_NOT_ALLOWED', { purpose: quote.purpose ?? null });
  }
  if (!includesNormalized(policy.allowedCurrencies, quote.currency)) {
    return result('QUOTE_CURRENCY_NOT_ALLOWED', { currency: quote.currency ?? null });
  }
  if (
    mission.budget?.currency !== undefined &&
    (
      typeof mission.budget.currency !== 'string' ||
      String(mission.budget.currency).trim().toUpperCase() !== String(quote.currency).trim().toUpperCase()
    )
  ) {
    return result('QUOTE_BUDGET_CURRENCY_MISMATCH', {
      quoteCurrency: quote.currency ?? null,
      budgetCurrency: mission.budget?.currency ?? null,
    });
  }
  if (!Number.isSafeInteger(quote.amountMinor) || quote.amountMinor <= 0) {
    return result('QUOTE_AMOUNT_INVALID');
  }
  if (!Number.isSafeInteger(policy.maximumAmountMinor) || quote.amountMinor > policy.maximumAmountMinor) {
    return result('QUOTE_CEILING_EXCEEDED', {
      amountMinor: quote.amountMinor,
      ceilingMinor: policy.maximumAmountMinor,
    });
  }

  const spentMinor = mission.budget?.spentMinor;
  const totalMinor = mission.budget?.totalMinor;
  if (
    !Number.isSafeInteger(spentMinor) ||
    !Number.isSafeInteger(totalMinor) ||
    spentMinor + quote.amountMinor > totalMinor
  ) {
    return result('QUOTE_BUDGET_EXCEEDED');
  }
  if (!Number.isSafeInteger(roundCount) || roundCount > policy.maximumRounds) {
    return result('NEGOTIATION_ROUNDS_EXCEEDED');
  }
  if (!termsAllowed(quote.terms, policy.requiredTerms)) return result('QUOTE_TERMS_NOT_ALLOWED');

  if (
    Number.isSafeInteger(policy.autoApprovalThresholdMinor) &&
    quote.amountMinor > policy.autoApprovalThresholdMinor &&
    humanApproved !== true
  ) {
    return result('QUOTE_APPROVAL_REQUIRED', {
      amountMinor: quote.amountMinor,
      thresholdMinor: policy.autoApprovalThresholdMinor,
    });
  }

  return result('QUOTE_OK', {
    amountMinor: quote.amountMinor,
    savingsMinor: Math.max(0, (policy.initialAmountMinor || quote.amountMinor) - quote.amountMinor),
  });
}

module.exports = {
  QUOTE_REASON_CODES,
  createQuoteDigest,
  evaluateQuote,
  quoteCommitment,
};
