'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DEMO_STEPS,
  MISSION_STATUSES,
  assertTransition,
  canTransition,
  canonicalHash,
  createSyntheticManifest,
  evaluatePolicy,
  potentiallyLiveRainSandboxCard,
  selectRail,
  simulateRecovery,
  verifyPiece,
} = require('../src/domain');

const NOW = '2026-08-07T16:00:00.000Z';

function policyRequest(overrides = {}) {
  const base = {
    now: NOW,
    mission: {
      status: 'FUNDED',
      deadline: '2026-08-08T16:00:00.000Z',
      rightsAttestation: true,
      contentRootSha256: 'a'.repeat(64),
    },
    policy: {
      expiresAt: '2026-08-08T16:00:00.000Z',
      allowedRails: ['rain_card', 'x402_monad'],
      allowedMerchants: ['archive.example'],
      allowedRecipients: ['locator-agent'],
      allowedMccs: ['5734'],
      allowedPurposes: ['archive_recovery'],
      allowedCurrencies: ['USD'],
      maxTransactions: 2,
      perTransactionLimitMinor: 1_000n,
      totalLimitMinor: 2_000n,
      approvalThresholdMinor: 800n,
      blockedContentHashes: [],
    },
    intent: {
      id: 'intent-1',
      idempotencyKey: 'mission-1:archive-1',
      rail: 'rain_card',
      merchant: 'archive.example',
      mcc: '5734',
      purpose: 'archive_recovery',
      amountMinor: 800n,
      currency: 'USD',
    },
    usage: {
      transactionCount: 1,
      spentMinor: 1_200n,
      usedIdempotencyKeys: [],
    },
  };

  return {
    ...base,
    ...overrides,
    mission: { ...base.mission, ...(overrides.mission || {}) },
    policy: { ...base.policy, ...(overrides.policy || {}) },
    intent: { ...base.intent, ...(overrides.intent || {}) },
    usage: { ...base.usage, ...(overrides.usage || {}) },
  };
}

test('policy allows exact amount and aggregate boundaries', () => {
  const decision = evaluatePolicy(policyRequest());
  assert.equal(decision.allowed, true);
  assert.equal(decision.code, 'POLICY_OK');
  assert.equal(decision.details.projectedSpendMinor, '2000');
});

test('policy rejects limits only after their inclusive boundaries', () => {
  assert.equal(
    evaluatePolicy(policyRequest({ intent: { amountMinor: 1_001n } })).code,
    'PER_TRANSACTION_LIMIT_EXCEEDED',
  );
  assert.equal(
    evaluatePolicy(policyRequest({
      intent: { amountMinor: 801n },
      usage: { spentMinor: 1_200n },
      humanApproved: true,
    })).code,
    'TOTAL_BUDGET_EXCEEDED',
  );
});

test('approval is required above, not at, the threshold', () => {
  assert.equal(
    evaluatePolicy(policyRequest({
      intent: { amountMinor: 801n },
      usage: { spentMinor: 0n },
    })).code,
    'APPROVAL_REQUIRED',
  );
  assert.equal(
    evaluatePolicy(policyRequest({
      intent: { amountMinor: 801n },
      usage: { spentMinor: 0n },
      humanApproved: true,
    })).code,
    'POLICY_OK',
  );
});

test('policy expiry is effective at the exact expiry instant', () => {
  const decision = evaluatePolicy(policyRequest({
    policy: { expiresAt: NOW },
  }));
  assert.equal(decision.allowed, false);
  assert.equal(decision.reasonCode, 'POLICY_EXPIRED');
});

test('policy fails closed on invalid timestamps', () => {
  assert.equal(
    evaluatePolicy(policyRequest({ now: 'not-a-date' })).code,
    'INVALID_TIMESTAMP',
  );
  assert.equal(
    evaluatePolicy(policyRequest({ mission: { deadline: 'not-a-date' } })).code,
    'INVALID_TIMESTAMP',
  );
  assert.equal(
    evaluatePolicy(policyRequest({ policy: { expiresAt: 'not-a-date' } })).code,
    'INVALID_TIMESTAMP',
  );
});

test('policy returns stable reason codes for blocked actions', () => {
  assert.equal(
    evaluatePolicy(policyRequest({ intent: { merchant: 'unrelated.example' } })).code,
    'MERCHANT_NOT_ALLOWED',
  );
  assert.equal(
    evaluatePolicy(policyRequest({ usage: { transactionCount: 2 } })).code,
    'TOO_MANY_TRANSACTIONS',
  );
  assert.equal(
    evaluatePolicy(policyRequest({
      usage: { usedIdempotencyKeys: ['mission-1:archive-1'] },
    })).code,
    'DUPLICATE_INTENT',
  );
  assert.equal(
    evaluatePolicy(policyRequest({ killSwitchActive: true })).code,
    'KILL_SWITCH_ACTIVE',
  );
  assert.equal(
    evaluatePolicy(policyRequest({ intent: { currency: 'EUR' } })).code,
    'CURRENCY_NOT_ALLOWED',
  );
});

test('policy rejects arithmetic across mission, intent, and usage currencies', () => {
  const request = policyRequest({
    mission: { budget: { currency: 'USD' } },
    policy: { allowedCurrencies: ['USD', 'EUR'] },
    intent: { currency: 'EUR', amountMinor: 10n },
    usage: { currency: 'USD', spentMinor: 90n },
  });
  assert.equal(evaluatePolicy(request).code, 'BUDGET_CURRENCY_MISMATCH');
  assert.equal(evaluatePolicy({
    ...request,
    intent: { ...request.intent, currency: 'USD' },
    usage: { ...request.usage, currency: 'EUR' },
  }).code, 'BUDGET_CURRENCY_MISMATCH');
});

test('Rain sandbox authority fails closed when its expiry is unknown', () => {
  assert.equal(potentiallyLiveRainSandboxCard({
    mode: 'rain-sandbox',
    state: 'unknown',
    expiresAt: 'not-an-instant',
  }, new Date(NOW)), true);
  assert.equal(potentiallyLiveRainSandboxCard({
    mode: 'rain-sandbox',
    state: 'active',
    expiresAt: '2026-08-06T16:00:00.000Z',
  }, new Date(NOW)), false);
  assert.equal(potentiallyLiveRainSandboxCard({
    mode: 'local',
    state: 'active',
    expiresAt: 'not-an-instant',
  }, new Date(NOW)), false);
});

test('state machine accepts only the next canonical state', () => {
  for (let index = 0; index < MISSION_STATUSES.length - 1; index += 1) {
    assert.equal(canTransition(MISSION_STATUSES[index], MISSION_STATUSES[index + 1]), true);
  }
  assert.equal(canTransition('DEAD', 'FUNDED'), false);
  assert.equal(canTransition('VERIFIED', 'RECOVERING'), false);
  assert.equal(canTransition('COMPLETED', 'COMPLETED'), false);
  assert.equal(canTransition('UNKNOWN', 'DEAD'), false);
  assert.equal(assertTransition('dead', 'discovering'), 'DISCOVERING');
});

test('assertTransition identifies a bad transition', () => {
  assert.throws(
    () => assertTransition('RECOVERING', 'COMPLETED'),
    (error) => error.code === 'INVALID_MISSION_TRANSITION' &&
      /RECOVERING -> COMPLETED/.test(error.message),
  );
});

test('canonical hashes are stable across object insertion order', () => {
  const left = { z: 3, a: { y: 2, x: 1 }, list: [3, 2, 1] };
  const right = { list: [3, 2, 1], a: { x: 1, y: 2 }, z: 3 };
  assert.equal(canonicalHash(left), canonicalHash(right));
  assert.equal(
    canonicalHash(left),
    '8691779b83620988964d133d428c861dc3e83e3ab5a53fadc13ab035630a6e64',
  );
  assert.notEqual(canonicalHash(left), canonicalHash({ ...left, z: 4 }));
});

test('synthetic manifest always contains 24 deterministic verifiable pieces', () => {
  const manifest = createSyntheticManifest();
  const second = createSyntheticManifest();
  assert.equal(manifest.pieceCount, 24);
  assert.equal(manifest.pieces.length, 24);
  assert.equal(manifest.totalBytes, manifest.pieceSize * 24);
  assert.equal(manifest.manifestHashSha256, second.manifestHashSha256);
  assert.equal(manifest.contentRootSha256, second.contentRootSha256);

  for (const piece of manifest.pieces) {
    const data = Buffer.from(piece.fixtureBase64, 'base64');
    assert.equal(verifyPiece(manifest, piece.index, data), true);
    assert.equal(verifyPiece(piece, data), true);
  }
});

test('piece verification detects a single-byte corruption', () => {
  const manifest = createSyntheticManifest({ pieceSize: 256 });
  const original = Buffer.from(manifest.pieces[7].fixtureBase64, 'base64');
  const corrupted = Buffer.from(original);
  corrupted[113] ^= 0xff;
  assert.equal(verifyPiece(manifest, 7, original), true);
  assert.equal(verifyPiece(manifest, 7, corrupted), false);
  assert.equal(verifyPiece(manifest, 24, original), false);
});

test('demo steps and recovery generator preserve the exact lifecycle', () => {
  assert.deepEqual(DEMO_STEPS.map((step) => step.status), MISSION_STATUSES);
  assert.deepEqual(
    [...simulateRecovery({ fromStatus: 'FUNDED', throughStatus: 'VERIFIED' })]
      .map((step) => step.status),
    ['FUNDED', 'RECOVERING', 'VERIFYING', 'VERIFIED'],
  );
  assert.equal(DEMO_STEPS.at(-1).progress, 100);
  assert.equal(DEMO_STEPS.at(-1).recoveredPieces, 24);
});

test('rail selector prefers eligible x402 then falls back deterministically', () => {
  assert.equal(selectRail({
    sellerSupportsX402: true,
    sellerAcceptsCard: true,
    sellerHasRainPayoutRoute: true,
    isDigitalResource: true,
    requiresChargebackProtection: false,
  }), 'x402_monad');

  assert.equal(selectRail({
    sellerSupportsX402: true,
    sellerAcceptsCard: true,
    isDigitalResource: true,
    requiresChargebackProtection: true,
  }), 'rain_card');

  assert.equal(selectRail({
    sellerHasRainPayoutRoute: true,
    isDigitalResource: false,
  }), 'rain_payment');
});

test('rail selector honors policy rail restrictions and fails closed', () => {
  assert.equal(selectRail({
    sellerSupportsX402: true,
    sellerAcceptsCard: true,
    isDigitalResource: true,
    allowedRails: ['rain_card'],
  }), 'rain_card');
  assert.throws(
    () => selectRail({ sellerSupportsX402: true, isDigitalResource: false }),
    (error) => error.code === 'NO_SUPPORTED_PAYMENT_RAIL',
  );
});
