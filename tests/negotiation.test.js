'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createQuoteDigest,
  evaluateQuote,
} = require('../src/domain');
const {
  ATLAS,
  DEFAULT_TERMS,
  LocalNegotiationAdapter,
} = require('../src/services/negotiation-local');

const FIXED_NOW = new Date('2026-08-08T16:00:00.000Z');
const clock = () => new Date(FIXED_NOW);

function quotePolicy(overrides = {}) {
  return {
    allowedMerchantIds: [ATLAS.merchantId],
    allowedMccs: [ATLAS.mcc],
    allowedCurrencies: ['USD'],
    requiredTerms: { ...DEFAULT_TERMS },
    initialAmountMinor: 1200,
    maximumAmountMinor: 1200,
    maximumRounds: 3,
    autoApprovalThresholdMinor: 1000,
    ...overrides,
  };
}

function mission(overrides = {}) {
  return {
    contentRoot: 'sha256:rainfall-test-root',
    budget: { spentMinor: 1, totalMinor: 2000 },
    ...overrides,
  };
}

function bindingQuote(overrides = {}) {
  const quote = {
    quoteId: 'quote_test',
    sessionId: 'negotiation_test',
    merchantId: ATLAS.merchantId,
    merchantName: ATLAS.merchantName,
    providerId: ATLAS.providerId,
    mcc: ATLAS.mcc,
    contentRoot: 'sha256:rainfall-test-root',
    purpose: DEFAULT_TERMS.service,
    amountMinor: 975,
    currency: 'USD',
    terms: { ...DEFAULT_TERMS },
    binding: true,
    issuedAt: '2026-08-08T16:00:00.000Z',
    expiresAt: '2026-08-08T16:15:00.000Z',
    ...overrides,
  };
  quote.quoteDigest = createQuoteDigest(quote);
  return quote;
}

test('local negotiation deterministically turns a $12 ask into an accepted $9.75 quote', () => {
  const negotiation = new LocalNegotiationAdapter({ clock });
  assert.equal(negotiation.liveMerchantApi, false);
  assert.equal(negotiation.merchantAuthenticated, false);
  assert.equal(negotiation.merchantSignedQuotes, false);
  assert.equal(negotiation.merchant.merchantId, ATLAS.merchantId);
  const offers = negotiation.getOffers({
    missionId: 'mission-test',
    contentRoot: 'sha256:rainfall-test-root',
    providerId: ATLAS.providerId,
    requirements: {
      maximumRounds: 3,
      maximumAmountMinor: 1200,
    },
    idempotencyKey: 'discover-mission-test',
  });

  assert.equal(offers.offers.length, 1);
  assert.equal(offers.offers[0].amountMinor, 1200);
  assert.equal(offers.offers[0].binding, false);
  assert.equal(offers.offers[0].source, 'simulated');
  assert.equal(offers.offers[0].merchantAuthenticated, false);
  assert.equal(offers.source, 'simulated');
  assert.equal(offers.externalEndpoint, false);

  const accepted = negotiation.sendCounterOffer({
    sessionId: offers.sessionId,
    offerId: offers.offers[0].offerId,
    amountMinor: 975,
    // JSONB stores objects semantically and may return their keys in a new order.
    terms: {
      service: DEFAULT_TERMS.service,
      autoRenewal: DEFAULT_TERMS.autoRenewal,
      dataSharing: DEFAULT_TERMS.dataSharing,
      exclusivity: DEFAULT_TERMS.exclusivity,
      purchaseModel: DEFAULT_TERMS.purchaseModel,
    },
    idempotencyKey: 'counter-mission-test-1',
  });

  assert.equal(accepted.round.roundNumber, 1);
  assert.equal(accepted.round.buyer.amountMinor, 975);
  assert.equal(accepted.round.seller.action, 'accept');
  assert.equal(accepted.session.status, 'quote_ready');
  assert.equal(accepted.quote.amountMinor, 975);
  assert.equal(accepted.quote.binding, true);
  assert.equal(accepted.quote.source, 'simulated');
  assert.equal(accepted.quote.merchantAuthenticated, false);
  assert.equal(accepted.quote.merchantSigned, false);
  assert.equal(accepted.session.rounds[0].buyer.source, 'local-policy');
  assert.equal(accepted.session.rounds[0].seller.source, 'simulated-merchant-model');
  assert.equal(accepted.quote.expiresAt, '2026-08-08T16:15:00.000Z');
  assert.equal(accepted.quote.quoteDigest, createQuoteDigest(accepted.quote));

  const retrieved = negotiation.getBindingQuote({
    sessionId: offers.sessionId,
    quoteId: accepted.quote.quoteId,
  });
  assert.deepEqual(retrieved, accepted.quote);

  const decision = evaluateQuote({
    mission: mission(),
    policy: quotePolicy(),
    quote: retrieved,
    expectedSessionId: offers.sessionId,
    roundCount: accepted.session.rounds.length,
    now: FIXED_NOW,
  });
  assert.equal(decision.allowed, true);
  assert.equal(decision.code, 'QUOTE_OK');
  assert.equal(decision.details.amountMinor, 975);
  assert.equal(decision.details.savingsMinor, 225);
});

test('quote digest is canonical and quote evaluation fails closed on tampering', () => {
  const original = bindingQuote();
  const reordered = {
    expiresAt: original.expiresAt,
    terms: { ...original.terms },
    amountMinor: original.amountMinor,
    quoteId: original.quoteId,
    sessionId: original.sessionId,
    merchantId: original.merchantId,
    merchantName: original.merchantName,
    providerId: original.providerId,
    mcc: original.mcc,
    contentRoot: original.contentRoot,
    purpose: original.purpose,
    currency: original.currency,
    binding: original.binding,
    issuedAt: original.issuedAt,
  };
  assert.equal(createQuoteDigest(reordered), original.quoteDigest);

  const tampered = structuredClone(original);
  tampered.amountMinor = 1000;
  const decision = evaluateQuote({
    mission: mission(),
    policy: quotePolicy(),
    quote: tampered,
    expectedSessionId: original.sessionId,
    roundCount: 1,
    now: FIXED_NOW,
  });
  assert.equal(decision.allowed, false);
  assert.equal(decision.code, 'QUOTE_INTEGRITY_MISMATCH');
});

test('quote evaluation rejects invalid session, expiry, merchant, ceiling, budget, and terms', async (t) => {
  const cases = [
    {
      name: 'session mismatch',
      quote: bindingQuote(),
      expectedSessionId: 'different-session',
      code: 'QUOTE_SESSION_MISMATCH',
    },
    {
      name: 'expired quote',
      quote: bindingQuote(),
      now: new Date('2026-08-08T16:15:00.000Z'),
      code: 'QUOTE_EXPIRED',
    },
    {
      name: 'unapproved merchant',
      quote: bindingQuote({ merchantId: 'merchant_unapproved' }),
      code: 'QUOTE_MERCHANT_NOT_ALLOWED',
    },
    {
      name: 'ceiling exceeded',
      quote: bindingQuote({ amountMinor: 1201 }),
      code: 'QUOTE_CEILING_EXCEEDED',
    },
    {
      name: 'budget exceeded',
      quote: bindingQuote(),
      mission: mission({ budget: { spentMinor: 1100, totalMinor: 2000 } }),
      code: 'QUOTE_BUDGET_EXCEEDED',
    },
    {
      name: 'unsupported terms',
      quote: bindingQuote({ terms: { ...DEFAULT_TERMS, autoRenewal: true } }),
      code: 'QUOTE_TERMS_NOT_ALLOWED',
    },
  ];

  for (const testCase of cases) {
    await t.test(testCase.name, () => {
      const decision = evaluateQuote({
        mission: testCase.mission || mission(),
        policy: quotePolicy(),
        quote: testCase.quote,
        expectedSessionId: testCase.expectedSessionId || testCase.quote.sessionId,
        roundCount: 1,
        now: testCase.now || FIXED_NOW,
      });
      assert.equal(decision.allowed, false);
      assert.equal(decision.code, testCase.code);
    });
  }
});
