'use strict';

/**
 * Stable policy outcomes. These values are API/audit identifiers, so callers
 * should display the accompanying text but persist the code.
 *
 * @type {readonly string[]}
 */
const POLICY_REASON_CODES = Object.freeze([
  'POLICY_OK',
  'RIGHTS_EVIDENCE_REQUIRED',
  'CONTENT_HASH_BLOCKED',
  'MISSION_INACTIVE',
  'MISSION_EXPIRED',
  'POLICY_EXPIRED',
  'PROVIDER_NOT_ALLOWED',
  'MERCHANT_NOT_ALLOWED',
  'RECIPIENT_NOT_ALLOWED',
  'MCC_NOT_ALLOWED',
  'PURPOSE_NOT_ALLOWED',
  'CURRENCY_NOT_ALLOWED',
  'BUDGET_CURRENCY_MISMATCH',
  'RAIL_NOT_ALLOWED',
  'TOO_MANY_TRANSACTIONS',
  'PER_TRANSACTION_LIMIT_EXCEEDED',
  'TOTAL_BUDGET_EXCEEDED',
  'APPROVAL_REQUIRED',
  'DUPLICATE_INTENT',
  'KILL_SWITCH_ACTIVE',
  'INVALID_AMOUNT',
  'INVALID_TIMESTAMP',
]);

const REASON_TEXT = Object.freeze({
  POLICY_OK: 'The payment intent satisfies every policy check.',
  RIGHTS_EVIDENCE_REQUIRED: 'Accepted rights evidence is required for this artifact.',
  CONTENT_HASH_BLOCKED: 'The artifact content hash is blocked.',
  MISSION_INACTIVE: 'The mission is not in an active state.',
  MISSION_EXPIRED: 'The mission deadline has passed.',
  POLICY_EXPIRED: 'The spending policy has expired.',
  PROVIDER_NOT_ALLOWED: 'The recovery provider is not allowed by policy.',
  MERCHANT_NOT_ALLOWED: 'The merchant is not allowed by policy.',
  RECIPIENT_NOT_ALLOWED: 'The payment recipient is not allowed by policy.',
  MCC_NOT_ALLOWED: 'The merchant category is not allowed by policy.',
  PURPOSE_NOT_ALLOWED: 'The purchase purpose is not allowed by policy.',
  CURRENCY_NOT_ALLOWED: 'The payment currency does not match the mission policy.',
  BUDGET_CURRENCY_MISMATCH: 'The payment, usage, and mission budget must use the same currency.',
  RAIL_NOT_ALLOWED: 'The selected payment rail is not allowed by policy.',
  TOO_MANY_TRANSACTIONS: 'The policy transaction-count limit has been reached.',
  PER_TRANSACTION_LIMIT_EXCEEDED: 'The payment exceeds the per-transaction limit.',
  TOTAL_BUDGET_EXCEEDED: 'The payment would exceed the mission budget.',
  APPROVAL_REQUIRED: 'Human approval is required above the configured threshold.',
  DUPLICATE_INTENT: 'This payment intent or idempotency key was already used.',
  KILL_SWITCH_ACTIVE: 'External spending is disabled by the kill switch.',
  INVALID_AMOUNT: 'The payment amount must be a non-negative integer in minor units.',
  INVALID_TIMESTAMP: 'A supplied policy timestamp is invalid.',
});

const ACTIVE_STATUSES = new Set([
  'DISCOVERING',
  'FUNDED',
  'RECOVERING',
  'VERIFYING',
  'VERIFIED',
  'RESEEDED',
  // Compatibility with the broader procurement data model in the build brief.
  'PLANNED',
  'AWAITING_APPROVAL',
  'EXECUTING',
  'ACTIVE',
]);

function result(code, details) {
  const allowed = code === 'POLICY_OK';
  return Object.freeze({
    allowed,
    approved: allowed,
    code,
    reasonCode: code,
    reason: REASON_TEXT[code],
    ...(details ? { details: Object.freeze({ ...details }) } : {}),
  });
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function normalizeIdentifier(value) {
  return String(value).trim().toLowerCase();
}

function allowedBy(list, value) {
  if (list === undefined || list === null) return true;
  if (!Array.isArray(list) && !(list instanceof Set)) return false;
  const normalized = new Set(
    [...list].map(normalizeIdentifier),
  );
  return normalized.has('*') || normalized.has(normalizeIdentifier(value));
}

function readMinor(value) {
  if (typeof value === 'bigint') return value >= 0n ? value : null;
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : null;
  }
  if (typeof value === 'string' && /^\d+$/.test(value)) return BigInt(value);
  return null;
}

function firstDefined(object, keys) {
  for (const key of keys) {
    if (object && object[key] !== undefined) return object[key];
  }
  return undefined;
}

function instant(value) {
  if (value === undefined || value === null || value === '') return null;
  const milliseconds = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(milliseconds) ? milliseconds : null;
}

function missionIsActive(mission) {
  if (typeof mission.active === 'boolean') return mission.active;
  if (typeof mission.isActive === 'boolean') return mission.isActive;
  if (typeof mission.status !== 'string') return false;
  return ACTIVE_STATUSES.has(mission.status.trim().toUpperCase());
}

function isDuplicate(request, intent, usage) {
  const candidates = [intent.id, intent.idempotencyKey]
    .filter((value) => value !== undefined && value !== null)
    .map(String);
  if (candidates.length === 0) return false;

  const collections = [
    request.seenIntentIds,
    request.usedIdempotencyKeys,
    usage.seenIntentIds,
    usage.usedIntentIds,
    usage.idempotencyKeys,
    usage.usedIdempotencyKeys,
  ];
  for (const collection of collections) {
    if (!collection) continue;
    const values = collection instanceof Set ? collection : new Set(collection);
    if (candidates.some((candidate) => values.has(candidate))) return true;
  }
  return false;
}

/**
 * Evaluate one proposed spend using deterministic, fail-closed policy rules.
 * Inject `now` for replayable expiry decisions.
 *
 * Primary form:
 * `evaluatePolicy({ mission, policy, intent, usage, now, humanApproved,
 * killSwitchActive, seenIntentIds })`.
 *
 * The compatibility form `evaluatePolicy(policy, intent, context)` is also
 * accepted; context may contain all other primary-form fields.
 *
 * Limits are inclusive: a payment exactly equal to the per-transaction or
 * remaining total limit is allowed. Approval is required only *above* the
 * threshold. Expiry instants are exclusive, so an object is expired when
 * `now >= expiresAt`.
 *
 * @param {object} input
 * @param {object} [intentArgument]
 * @param {object} [contextArgument]
 * @returns {{allowed: boolean, approved: boolean, code: string,
 *   reasonCode: string, reason: string, details?: object}}
 */
function evaluatePolicy(input, intentArgument, contextArgument = {}) {
  const envelope = input && hasOwn(input, 'policy')
    ? input
    : { ...contextArgument, policy: input, intent: intentArgument };
  const mission = envelope.mission || {};
  const policy = envelope.policy || {};
  const intent = envelope.intent || {};
  const usage = envelope.usage || {};

  if (
    envelope.killSwitchActive === true ||
    policy.killSwitchActive === true ||
    mission.killSwitchActive === true
  ) {
    return result('KILL_SWITCH_ACTIVE');
  }

  if (!missionIsActive(mission)) return result('MISSION_INACTIVE');

  const nowInput = envelope.now === undefined ? Date.now() : envelope.now;
  const now = instant(nowInput);
  if (now === null) return result('INVALID_TIMESTAMP', { field: 'now' });

  const missionExpiryInput = firstDefined(mission, ['deadline', 'expiresAt']);
  const missionExpiry = instant(missionExpiryInput);
  if (missionExpiryInput !== undefined && missionExpiryInput !== null && missionExpiryInput !== '' && missionExpiry === null) {
    return result('INVALID_TIMESTAMP', { field: 'mission.expiresAt' });
  }
  if (missionExpiry !== null && now >= missionExpiry) {
    return result('MISSION_EXPIRED');
  }

  const policyExpiryInput = policy.expiresAt;
  const policyExpiry = instant(policyExpiryInput);
  if (policyExpiryInput !== undefined && policyExpiryInput !== null && policyExpiryInput !== '' && policyExpiry === null) {
    return result('INVALID_TIMESTAMP', { field: 'policy.expiresAt' });
  }
  if (policyExpiry !== null && now >= policyExpiry) {
    return result('POLICY_EXPIRED');
  }

  const rightsFieldPresent = [
    'rightsAttestation',
    'rightsEvidenceAccepted',
    'rightsEvidence',
  ].some((key) => hasOwn(mission, key));
  const rightsAccepted = mission.rightsAttestation === true ||
    mission.rightsEvidenceAccepted === true ||
    Boolean(mission.rightsEvidence);
  if ((policy.requireRightsEvidence === true || rightsFieldPresent) && !rightsAccepted) {
    return result('RIGHTS_EVIDENCE_REQUIRED');
  }

  const contentHash = firstDefined(intent, ['contentRootSha256', 'contentHash']) ||
    firstDefined(mission, ['contentRootSha256', 'contentHash']);
  const blockedHashes = policy.blockedContentHashes || envelope.blockedContentHashes;
  if (contentHash && blockedHashes && allowedBy(blockedHashes, contentHash)) {
    // `allowedBy` means membership here because blockedHashes is a deny-list.
    return result('CONTENT_HASH_BLOCKED');
  }

  if (isDuplicate(envelope, intent, usage)) return result('DUPLICATE_INTENT');

  if (!intent.rail || !allowedBy(policy.allowedRails, intent.rail)) {
    return result('RAIL_NOT_ALLOWED', { rail: intent.rail || null });
  }

  if (
    intent.provider !== undefined &&
    !allowedBy(policy.allowedProviders, intent.provider)
  ) {
    return result('PROVIDER_NOT_ALLOWED', { provider: intent.provider });
  }

  const merchantRequired = intent.rail === 'rain_card' && policy.allowedMerchants !== undefined;
  if (
    (intent.merchant !== undefined || merchantRequired) &&
    !allowedBy(policy.allowedMerchants, intent.merchant || '')
  ) {
    return result('MERCHANT_NOT_ALLOWED', { merchant: intent.merchant || null });
  }

  const recipientRequired = (
    intent.rail === 'x402_monad' || intent.rail === 'rain_payment'
  ) && policy.allowedRecipients !== undefined;
  if (
    (intent.recipient !== undefined || recipientRequired) &&
    !allowedBy(policy.allowedRecipients, intent.recipient || '')
  ) {
    return result('RECIPIENT_NOT_ALLOWED', { recipient: intent.recipient || null });
  }

  const mccRequired = intent.rail === 'rain_card' && policy.allowedMccs !== undefined;
  if (
    (intent.mcc !== undefined || mccRequired) &&
    !allowedBy(policy.allowedMccs, intent.mcc || '')
  ) {
    return result('MCC_NOT_ALLOWED', { mcc: intent.mcc || null });
  }

  if (
    intent.purpose !== undefined &&
    !allowedBy(policy.allowedPurposes, intent.purpose)
  ) {
    return result('PURPOSE_NOT_ALLOWED', { purpose: intent.purpose });
  }

  if (
    policy.allowedCurrencies !== undefined &&
    !allowedBy(policy.allowedCurrencies, intent.currency || '')
  ) {
    return result('CURRENCY_NOT_ALLOWED', { currency: intent.currency || null });
  }

  const budgetCurrency = typeof mission.budget?.currency === 'string'
    ? mission.budget.currency.trim().toUpperCase()
    : null;
  const intentCurrency = typeof intent.currency === 'string'
    ? intent.currency.trim().toUpperCase()
    : null;
  const usageCurrency = typeof usage.currency === 'string'
    ? usage.currency.trim().toUpperCase()
    : budgetCurrency;
  if (
    budgetCurrency &&
    (intentCurrency !== budgetCurrency || usageCurrency !== budgetCurrency)
  ) {
    return result('BUDGET_CURRENCY_MISMATCH', {
      budgetCurrency,
      intentCurrency,
      usageCurrency,
    });
  }

  const transactionCount = firstDefined(usage, ['transactionCount', 'settledTransactionCount']) ??
    (Array.isArray(usage.transactions) ? usage.transactions.length : 0);
  if (
    Number.isSafeInteger(policy.maxTransactions) &&
    transactionCount >= policy.maxTransactions
  ) {
    return result('TOO_MANY_TRANSACTIONS', {
      transactionCount,
      maxTransactions: policy.maxTransactions,
    });
  }

  const amount = readMinor(intent.amountMinor);
  if (amount === null) return result('INVALID_AMOUNT');

  const perTransactionLimit = readMinor(firstDefined(policy, [
    'perTransactionLimitMinor',
    'perPaymentLimitMinor',
    'maxPerTransactionMinor',
  ]));
  if (perTransactionLimit !== null && amount > perTransactionLimit) {
    return result('PER_TRANSACTION_LIMIT_EXCEEDED', {
      amountMinor: amount.toString(),
      limitMinor: perTransactionLimit.toString(),
    });
  }

  const spent = readMinor(firstDefined(usage, [
    'spentMinor',
    'totalSpentMinor',
    'committedMinor',
  ]) ?? 0n);
  const totalLimit = readMinor(firstDefined(policy, [
    'totalLimitMinor',
    'maximumBudgetMinor',
    'budgetMinor',
  ]));
  if (spent === null) return result('INVALID_AMOUNT');
  if (totalLimit !== null && spent + amount > totalLimit) {
    return result('TOTAL_BUDGET_EXCEEDED', {
      amountMinor: amount.toString(),
      spentMinor: spent.toString(),
      limitMinor: totalLimit.toString(),
    });
  }

  const approvalThreshold = readMinor(policy.approvalThresholdMinor);
  const humanApproved = envelope.humanApproved === true || intent.humanApproved === true;
  if (approvalThreshold !== null && amount > approvalThreshold && !humanApproved) {
    return result('APPROVAL_REQUIRED', {
      amountMinor: amount.toString(),
      thresholdMinor: approvalThreshold.toString(),
    });
  }

  return result('POLICY_OK', {
    amountMinor: amount.toString(),
    projectedSpendMinor: (spent + amount).toString(),
  });
}

module.exports = {
  POLICY_REASON_CODES,
  evaluatePolicy,
};
