'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  RainSandboxAdapter,
  RainSandboxError,
  idempotencyKey,
} = require('../src/services/rain-sandbox');

const FIXED_NOW = new Date('2026-08-08T16:00:00.000Z');
const clock = () => new Date(FIXED_NOW);
const USER_ID = '11111111-1111-4111-8111-111111111111';
const TEAM_ID = '22222222-2222-4222-8222-222222222222';
const CONTRACT_ID = '33333333-3333-4333-8333-333333333333';
const CARD_ID = '44444444-4444-4444-8444-444444444444';
const TRANSACTION_ID = '55555555-5555-4555-8555-555555555555';
const API_KEY = 'dummy-api-key-for-unit-tests-only';
const BASE_URL = 'https://rain.invalid/v1';

function jsonResponse(payload, status = 200, headers = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function makeAdapter(fetchImpl, overrides = {}) {
  return new RainSandboxAdapter({
    baseUrl: BASE_URL,
    apiKey: API_KEY,
    userId: USER_ID,
    teamId: TEAM_ID,
    contractId: CONTRACT_ID,
    autoFundMinor: 0,
    fetchImpl,
    clock,
    ...overrides,
  });
}

function policy(overrides = {}) {
  return {
    principalId: 'principal-test',
    missionId: 'mission-test',
    quoteId: 'quote-test',
    allowedMerchantIds: ['merchant_atlas_archive'],
    allowedMccs: ['5734'],
    maximumAmountMinor: 975,
    maxTransactions: 1,
    expiresAt: '2026-08-08T16:05:00.000Z',
    purpose: 'archival_egress',
    ...overrides,
  };
}

function scopedCardPayload(overrides = {}) {
  return {
    id: CARD_ID,
    encryptedPan: { iv: 'sensitive-iv', data: 'sensitive-pan' },
    encryptedCvc: { iv: 'sensitive-iv', data: 'sensitive-cvc' },
    last4: '4242',
    expirationMonth: '12',
    expirationYear: '2028',
    status: 'active',
    ...overrides,
  };
}

test('Rain sandbox maps collateral and scoped-card endpoint, body, and headers', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), options });
    if (String(url).endsWith('/simulate/collateral/fund')) {
      return jsonResponse({ transactionId: TRANSACTION_ID });
    }
    if (String(url).endsWith(`/issuing/users/${USER_ID}/cards/scoped`)) {
      return jsonResponse(scopedCardPayload());
    }
    throw new Error(`Unexpected request: ${url}`);
  };
  const rain = makeAdapter(fetchImpl, { autoFundMinor: 2000 });

  const card = await rain.createScopedCard(policy());

  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, `${BASE_URL}/simulate/collateral/fund`);
  assert.equal(calls[0].options.method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    contractId: CONTRACT_ID,
    currency: 'rusd',
    amount: 2000,
  });
  assert.equal(calls[0].options.headers['Api-Key'], API_KEY);
  assert.equal(calls[0].options.headers['Content-Type'], 'application/json');
  assert.equal(calls[0].options.headers['Idempotency-Key'].length, 64);

  assert.equal(calls[1].url, `${BASE_URL}/issuing/users/${USER_ID}/cards/scoped`);
  assert.equal(calls[1].options.method, 'POST');
  assert.deepEqual(JSON.parse(calls[1].options.body), {
    amountInUSDCents: 975,
    expiresAt: '2026-08-08T16:05:00.000Z',
    allowedMccs: ['5734'],
  });
  assert.equal(calls[1].options.headers['Api-Key'], API_KEY);
  assert.equal(calls[1].options.headers['Content-Type'], 'application/json');
  assert.match(calls[1].options.headers.sessionid, /^[A-Za-z0-9+/]+={0,2}$/);
  assert.equal(calls[1].options.headers['Idempotency-Key'].length, 64);
  assert.equal(card.cardId, CARD_ID);
  assert.equal(card.lastFour, '4242');
});

test('Rain sandbox idempotency keys are deterministic, stable, and at most 64 characters', async () => {
  const directA = idempotencyKey('operation', 'mission', 'quote', 975);
  const directB = idempotencyKey('operation', 'mission', 'quote', 975);
  assert.equal(directA, directB);
  assert.equal(directA.length, 64);

  const keys = [];
  const fetchImpl = async (_url, options) => {
    keys.push(options.headers['Idempotency-Key']);
    return jsonResponse(scopedCardPayload());
  };
  const rain = makeAdapter(fetchImpl);
  await rain.createScopedCard(policy());
  await rain.createScopedCard(policy());

  assert.equal(keys.length, 2);
  assert.equal(keys[0], keys[1]);
  assert.equal(keys[0].length, 64);
});

test('Rain sandbox never returns or caches encrypted PAN or CVC fields', async () => {
  const rain = makeAdapter(async () => jsonResponse(scopedCardPayload()));
  const card = await rain.createScopedCard(policy());

  const serializedReturn = JSON.stringify(card);
  const serializedCache = JSON.stringify(rain.cards.get(CARD_ID));
  for (const serialized of [serializedReturn, serializedCache]) {
    assert.doesNotMatch(serialized, /encryptedPan|encryptedCvc|sensitive-pan|sensitive-cvc/i);
  }
  assert.equal(Object.hasOwn(card, 'encryptedPan'), false);
  assert.equal(Object.hasOwn(card, 'encryptedCvc'), false);
});

test('Rain sandbox normalizes an authorization followed by settlement', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), options });
    if (String(url).endsWith('/cards/scoped')) return jsonResponse(scopedCardPayload());
    if (String(url).endsWith('/simulate/transactions/authorize')) {
      return jsonResponse({ transactionId: TRANSACTION_ID, status: 'authorized' });
    }
    if (String(url).endsWith(`/simulate/transactions/${TRANSACTION_ID}/settle`)) {
      return jsonResponse({
        transactionId: TRANSACTION_ID,
        status: 'settled',
        completionReason: 'SETTLEMENT',
      });
    }
    throw new Error(`Unexpected request: ${url}`);
  };
  const rain = makeAdapter(fetchImpl);
  const card = await rain.createScopedCard(policy());

  const result = await rain.authorizePurchase(card.cardId, {
    intentId: 'intent-approved-quote-test',
    quoteId: 'quote-test',
    merchantId: 'merchant_atlas_archive',
    merchantName: 'Atlas Archive Cloud',
    mcc: '5734',
    amountMinor: 975,
    currency: 'USD',
  });

  assert.equal(result.authorized, true);
  assert.equal(result.status, 'settled');
  assert.equal(result.code, 'AUTHORIZED');
  assert.equal(result.rainStatus, 'authorized');
  assert.equal(result.completionReason, 'SETTLEMENT');
  assert.equal(result.quoteId, 'quote-test');
  assert.equal(result.remoteAttempted, true);
  assert.equal(rain.cards.get(CARD_ID).transactionCount, 1);

  const authorization = calls[1];
  assert.equal(authorization.url, `${BASE_URL}/simulate/transactions/authorize`);
  assert.deepEqual(JSON.parse(authorization.options.body), {
    cardId: CARD_ID,
    amount: 975,
    currency: 'USD',
    merchantName: 'Atlas Archive Cloud',
    merchantCategoryCode: '5734',
  });
  assert.equal(authorization.options.headers['Idempotency-Key'].length, 64);

  const settlement = calls[2];
  assert.equal(settlement.url, `${BASE_URL}/simulate/transactions/${TRANSACTION_ID}/settle`);
  assert.deepEqual(JSON.parse(settlement.options.body), { amount: 975 });
  assert.equal(settlement.options.headers['Idempotency-Key'].length, 64);
});

test('Rain sandbox rejects a wrong merchant locally without a remote authorization call', async () => {
  const calls = [];
  const rain = makeAdapter(async (url, options) => {
    calls.push({ url: String(url), options });
    return jsonResponse(scopedCardPayload());
  });
  const card = await rain.createScopedCard(policy());

  const result = await rain.authorizePurchase(card.cardId, {
    intentId: 'intent-wrong-merchant',
    merchantId: 'merchant_unapproved',
    merchantName: 'Unapproved Merchant',
    mcc: '5734',
    amountMinor: 900,
    currency: 'USD',
  });

  assert.equal(result.authorized, false);
  assert.equal(result.code, 'MERCHANT_NOT_ALLOWED');
  assert.equal(result.remoteAttempted, false);
  assert.equal(calls.length, 1);
});

test('Rain sandbox deliberately exercises a wrong-MCC remote decline', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), options });
    if (String(url).endsWith('/cards/scoped')) return jsonResponse(scopedCardPayload());
    if (String(url).endsWith('/simulate/transactions/authorize')) {
      return jsonResponse({
        transactionId: TRANSACTION_ID,
        status: 'declined',
        declinedReason: 'blocked_mcc',
      });
    }
    throw new Error(`Unexpected request: ${url}`);
  };
  const rain = makeAdapter(fetchImpl);
  const card = await rain.createScopedCard(policy());

  const result = await rain.authorizePurchase(card.cardId, {
    intentId: 'intent-wrong-mcc',
    merchantId: 'merchant_atlas_archive',
    merchantName: 'Atlas Archive Cloud',
    mcc: '7995',
    amountMinor: 900,
    currency: 'USD',
    exerciseRemoteControl: true,
  });

  assert.equal(result.authorized, false);
  assert.equal(result.code, 'MCC_NOT_ALLOWED');
  assert.equal(result.applicationCode, 'MCC_NOT_ALLOWED');
  assert.equal(result.rainDeclinedReason, 'blocked_mcc');
  assert.equal(result.remoteAttempted, true);
  assert.equal(calls.length, 2);
  assert.deepEqual(JSON.parse(calls[1].options.body), {
    cardId: CARD_ID,
    amount: 900,
    currency: 'USD',
    merchantName: 'Atlas Archive Cloud',
    merchantCategoryCode: '7995',
  });
});

test('Rain sandbox retirement truthfully schedules expiry without a remote mutation', async () => {
  const calls = [];
  const rain = makeAdapter(async (url, options) => {
    calls.push({ url: String(url), options });
    return jsonResponse(scopedCardPayload());
  });
  const card = await rain.createScopedCard(policy());

  const retired = await rain.retireCard(card.cardId);

  assert.equal(retired.state, 'expiry_scheduled');
  assert.equal(retired.remoteState, 'active');
  assert.equal(retired.localAuthorityDisabledAt, FIXED_NOW.toISOString());
  assert.equal(calls.length, 1);
});

test('Rain sandbox rejects malformed UUID configuration before any network call', () => {
  let calls = 0;
  assert.throws(
    () => makeAdapter(async () => {
      calls += 1;
      return jsonResponse({});
    }, { contractId: '33333333-3333-4333-8333-33333333333l' }),
    (error) => error instanceof RainSandboxError && error.code === 'RAIN_INVALID_CONFIGURATION',
  );
  assert.equal(calls, 0);
});
