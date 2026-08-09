'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const test = require('node:test');
const { createApplication } = require('../server');
const { loadEnvFile, merchantRemoteConfig } = require('../src/config');
const { createQuoteDigest } = require('../src/domain');
const { MemoryStore } = require('../src/store');
const { rehydrateLocalAdapters } = require('../src/rehydrate-local');
const { RainSandboxAdapter } = require('../src/services/rain-sandbox');
const {
  REMOTE_MERCHANT,
  RemoteNegotiationAdapter,
} = require('../src/services/negotiation-remote');
const {
  REMOTE_PROVIDER,
  RemoteRecoveryAdapter,
  merkleRoot,
} = require('../src/services/recovery-remote');

const API_TOKEN = 'unit-test-merchant-token';
const CLOCK = new Date('2026-08-09T12:00:00.000Z');

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function fixtureManifest(pieceCount = 2) {
  const bytes = Array.from({ length: pieceCount }, (_, index) => Buffer.from(`piece-${index}-payload`));
  const pieces = bytes.map((piece, index) => ({
    index,
    sha256: sha256(piece),
    byteLength: piece.length,
  }));
  const artifact = Buffer.concat(bytes);
  return {
    bytes,
    manifest: {
      schema: 'lazarus-artifact-manifest-v1',
      name: 'merchant-fixture.txt',
      license: 'CC0-1.0',
      totalBytes: artifact.length,
      pieceCount: pieces.length,
      artifactSha256: sha256(artifact),
      contentRootSha256: sha256(artifact),
      merkleRootSha256: merkleRoot(pieces.map((piece) => piece.sha256)),
      pieces,
    },
  };
}

function signingFixture() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const keyId = `merchant_ed25519_${sha256(publicKey.export({ type: 'spki', format: 'der' }))}`;
  return { privateKey, publicKey, keyId };
}

function canonicalStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalStringify(value[key])}`).join(',')}}`;
}

function signedQuote({
  manifest,
  signing,
  amountMinor = 975,
  currency = 'USD',
  issuedAt = '2026-08-09T11:59:00.000Z',
  expiresAt = '2026-08-09T12:14:00.000Z',
}) {
  const quote = {
    quoteId: 'quote_unit_test',
    sessionId: 'negotiation_unit_test',
    merchantId: REMOTE_MERCHANT.merchantId,
    merchantName: REMOTE_MERCHANT.merchantName,
    providerId: REMOTE_MERCHANT.providerId,
    mcc: REMOTE_MERCHANT.mcc,
    contentRoot: manifest.merkleRootSha256,
    purpose: 'archival_egress',
    amountMinor,
    currency,
    exponent: 2,
    terms: {
      purchaseModel: 'one_time',
      service: 'archival_egress',
      autoRenewal: false,
      dataSharing: false,
      exclusivity: false,
    },
    binding: true,
    source: 'live-merchant-api',
    merchantAuthenticated: true,
    merchantSigned: true,
    issuedAt,
    expiresAt,
  };
  quote.quoteDigest = createQuoteDigest(quote);
  const nonce = 'nonce-unit-test';
  const payload = Buffer.from(canonicalStringify({
    keyId: signing.keyId,
    nonce,
    quoteDigest: quote.quoteDigest,
  }));
  quote.signature = {
    algorithm: 'Ed25519',
    keyId: signing.keyId,
    nonce,
    value: crypto.sign(null, payload, signing.privateKey).toString('base64'),
  };
  return quote;
}

function sessionFor(quote, { initialOfferAmountMinor = 1200 } = {}) {
  const offer = {
    offerId: 'offer_unit_test',
    sessionId: quote.sessionId,
    merchantId: REMOTE_MERCHANT.merchantId,
    merchantName: REMOTE_MERCHANT.merchantName,
    providerId: REMOTE_MERCHANT.providerId,
    mcc: REMOTE_MERCHANT.mcc,
    contentRoot: quote.contentRoot,
    purpose: 'archival_egress',
    amountMinor: initialOfferAmountMinor,
    currency: quote.currency,
    exponent: 2,
    terms: quote.terms,
    binding: false,
    source: 'live-merchant-api',
    merchantAuthenticated: true,
    issuedAt: quote.issuedAt,
  };
  return {
    sessionId: quote.sessionId,
    missionId: 'mission_unit_test',
    contentRoot: quote.contentRoot,
    providerId: quote.providerId,
    status: 'quote_ready',
    maximumRounds: 3,
    maximumAmountMinor: 1200,
    currency: quote.currency,
    exponent: 2,
    currentSellerAmountMinor: quote.amountMinor,
    initialAmountMinor: initialOfferAmountMinor,
    floorAmountMinor: 975,
    offers: [offer],
    rounds: [{
      roundId: 'round_unit_test',
      roundNumber: 1,
      offerId: offer.offerId,
      seller: { action: 'accept', amountMinor: quote.amountMinor, quoteId: quote.quoteId },
    }],
    quote,
    completedAt: quote.issuedAt,
  };
}

function jsonResponse(value, status = 200, headers = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function remoteEnv(overrides = {}) {
  const { manifest } = fixtureManifest();
  const { keyId } = signingFixture();
  return {
    MERCHANT_MODE: 'remote',
    MERCHANT_BASE_URL: 'https://merchant.example',
    MERCHANT_API_TOKEN: API_TOKEN,
    MERCHANT_EXPECTED_KEY_ID: keyId,
    MERCHANT_CURRENCY: 'USD',
    MERCHANT_TRUSTED_MANIFEST_JSON: JSON.stringify(manifest),
    ...overrides,
  };
}

test('merchantRemoteConfig is all-or-nothing and pins one currency and trusted manifest', () => {
  assert.equal(merchantRemoteConfig({}), null);
  const exampleEnv = {};
  assert.equal(loadEnvFile(path.join(__dirname, '..', '.env.example'), exampleEnv), true);
  assert.equal(merchantRemoteConfig(exampleEnv), null);
  assert.throws(
    () => merchantRemoteConfig({ MERCHANT_BASE_URL: 'https://merchant.example' }),
    /MERCHANT_MODE=remote/,
  );
  assert.throws(
    () => merchantRemoteConfig({ MERCHANT_MODE: 'remote', MERCHANT_BASE_URL: 'https://merchant.example' }),
    /incomplete/,
  );
  assert.throws(
    () => merchantRemoteConfig(remoteEnv({ MERCHANT_BASE_URL: 'http://merchant.example' })),
    /HTTPS/,
  );
  assert.throws(
    () => merchantRemoteConfig(remoteEnv({ MERCHANT_CURRENCY: 'USDC' })),
    /USD, EUR, GBP, CAD, or AUD/,
  );
  assert.throws(
    () => merchantRemoteConfig(remoteEnv({ MERCHANT_TRUSTED_MANIFEST_JSON: '{' })),
    /valid JSON/,
  );

  const config = merchantRemoteConfig(remoteEnv({
    MERCHANT_TIMEOUT_MS: '4321',
    MERCHANT_MAXIMUM_TOTAL_BYTES: '2048',
  }));
  assert.equal(config.mode, 'remote');
  assert.equal(config.baseUrl, 'https://merchant.example/');
  assert.equal(config.currency, 'USD');
  assert.equal(config.contentRoot, config.trustedManifest.merkleRootSha256);
  assert.equal(config.timeoutMs, 4321);
  assert.equal(config.maximumTotalBytes, 2048);
});

test('remote negotiation authenticates requests and accepts only a pinned signed quote', async () => {
  const { manifest } = fixtureManifest();
  const signing = signingFixture();
  const quote = signedQuote({ manifest, signing });
  const session = sessionFor(quote);
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    const pathname = new URL(url).pathname;
    calls.push({ pathname, options });
    if (pathname === '/.well-known/lazarus-merchant-key.json') {
      assert.equal(options.headers.Authorization, undefined);
      return jsonResponse({
        keyId: signing.keyId,
        algorithm: 'Ed25519',
        publicKeyJwk: signing.publicKey.export({ format: 'jwk' }),
      });
    }
    assert.equal(options.headers.Authorization, `Bearer ${API_TOKEN}`);
    if (pathname === '/api/offers') return jsonResponse(session, 201);
    if (pathname.endsWith('/counters')) {
      return jsonResponse({ session, round: session.rounds[0], quote });
    }
    if (pathname.endsWith(`/quotes/${quote.quoteId}`)) return jsonResponse(quote);
    if (pathname.endsWith(`/${session.sessionId}`)) return jsonResponse(session);
    return jsonResponse({ error: { code: 'NOT_FOUND', message: 'Not found.' } }, 404);
  };
  const adapter = new RemoteNegotiationAdapter({
    baseUrl: 'https://merchant.example',
    apiToken: API_TOKEN,
    expectedKeyId: signing.keyId,
    contentRoot: manifest.merkleRootSha256,
    currency: 'USD',
    fetchImpl,
    clock: () => new Date(CLOCK),
  });

  const received = await adapter.getOffers({
    missionId: session.missionId,
    contentRoot: manifest.merkleRootSha256,
    providerId: REMOTE_MERCHANT.providerId,
    bounty: { deadline: '2026-08-09T12:30:00.000Z' },
    requirements: { maximumRounds: 3, maximumAmountMinor: 1200, currency: 'USD' },
  });
  assert.equal(received.offers[0].merchantAuthenticated, true);
  await adapter.sendCounterOffer({
    sessionId: session.sessionId,
    offerId: session.offers[0].offerId,
    amountMinor: 975,
    terms: quote.terms,
  });
  const verified = await adapter.getBindingQuote({
    sessionId: session.sessionId,
    quoteId: quote.quoteId,
  });
  assert.equal(verified.quoteDigest, quote.quoteDigest);
  assert.equal(adapter.merchant.merchantId, 'merchant_lazarus_operator');
  assert.equal(adapter.provider.providerId, 'provider_lazarus_operator');
  assert.deepEqual(adapter.supportedCurrencies, ['USD']);
  assert.ok(calls.length >= 4);
  assert.doesNotMatch(JSON.stringify(adapter), new RegExp(API_TOKEN));
});

test('remote negotiation binds sessions to missions and rejects cross-mission replay', async () => {
  const { manifest } = fixtureManifest();
  const signing = signingFixture();
  const quote = signedQuote({ manifest, signing });
  const session = sessionFor(quote);
  const adapter = new RemoteNegotiationAdapter({
    baseUrl: 'https://merchant.example',
    apiToken: API_TOKEN,
    expectedKeyId: signing.keyId,
    contentRoot: manifest.merkleRootSha256,
    currency: 'USD',
    clock: () => new Date(CLOCK),
    fetchImpl: async () => jsonResponse(session, 201),
  });
  const request = {
    contentRoot: manifest.merkleRootSha256,
    providerId: REMOTE_MERCHANT.providerId,
    requirements: { currency: 'USD' },
  };

  await adapter.getOffers({ ...request, missionId: session.missionId });
  await assert.rejects(
    adapter.getOffers({ ...request, missionId: 'mission_replay_target' }),
    (error) => error.code === 'MERCHANT_RESPONSE_INVALID',
  );

  const conflicting = { ...session, missionId: 'mission_replay_target' };
  adapter.fetch = async () => jsonResponse(conflicting, 201);
  await assert.rejects(
    adapter.getOffers({ ...request, missionId: 'mission_replay_target' }),
    (error) => error.code === 'MERCHANT_SESSION_BINDING_MISMATCH',
  );
});

test('remote negotiation rejects future, overlong, and post-deadline quotes', async () => {
  const { manifest } = fixtureManifest();
  const signing = signingFixture();
  const variants = [
    signedQuote({
      manifest,
      signing,
      issuedAt: '2026-08-09T12:01:00.000Z',
      expiresAt: '2026-08-09T12:10:00.000Z',
    }),
    signedQuote({
      manifest,
      signing,
      issuedAt: '2026-08-09T11:59:00.000Z',
      expiresAt: '2026-08-09T13:00:00.001Z',
    }),
    signedQuote({
      manifest,
      signing,
      issuedAt: '2026-08-09T11:59:00.000Z',
      expiresAt: '2026-08-09T12:20:00.000Z',
    }),
  ];

  for (const candidate of variants) {
    const session = sessionFor(candidate);
    const adapter = new RemoteNegotiationAdapter({
      baseUrl: 'https://merchant.example',
      apiToken: API_TOKEN,
      expectedKeyId: signing.keyId,
      contentRoot: manifest.merkleRootSha256,
      currency: 'USD',
      clock: () => new Date(CLOCK),
      fetchImpl: async (url) => {
        const pathname = new URL(url).pathname;
        if (pathname === '/api/offers') return jsonResponse(session, 201);
        if (pathname.endsWith(`/quotes/${candidate.quoteId}`)) return jsonResponse(candidate);
        return jsonResponse({ error: { code: 'NOT_FOUND' } }, 404);
      },
    });
    await adapter.getOffers({
      missionId: session.missionId,
      contentRoot: manifest.merkleRootSha256,
      providerId: REMOTE_MERCHANT.providerId,
      bounty: { deadline: '2026-08-09T12:15:00.000Z' },
      requirements: { currency: 'USD' },
    });
    await assert.rejects(
      adapter.getBindingQuote({ sessionId: session.sessionId, quoteId: candidate.quoteId }),
      (error) => error.code === 'MERCHANT_QUOTE_UNTRUSTED',
    );
  }
});

test('remote negotiation rejects digest tampering, key substitution, wrong roots, and wrong currency before trust', async () => {
  const { manifest } = fixtureManifest();
  const signing = signingFixture();
  const otherSigning = signingFixture();
  const quote = signedQuote({ manifest, signing });
  const keyResponse = () => jsonResponse({
    keyId: signing.keyId,
    algorithm: 'Ed25519',
    publicKeyJwk: signing.publicKey.export({ format: 'jwk' }),
  });
  const adapter = new RemoteNegotiationAdapter({
    baseUrl: 'https://merchant.example',
    apiToken: API_TOKEN,
    expectedKeyId: signing.keyId,
    contentRoot: manifest.merkleRootSha256,
    currency: 'USD',
    clock: () => new Date(CLOCK),
    fetchImpl: async (url) => new URL(url).pathname.includes('.well-known')
      ? keyResponse()
      : jsonResponse({ ...quote, amountMinor: 976 }),
  });
  adapter.bindSession('mission_unit_test', quote.sessionId);
  await assert.rejects(
    adapter.getBindingQuote({ sessionId: quote.sessionId, quoteId: quote.quoteId }),
    (error) => error.code === 'MERCHANT_QUOTE_DIGEST_INVALID',
  );
  await assert.rejects(
    adapter.getOffers({
      missionId: 'mission_wrong_root',
      contentRoot: 'f'.repeat(64),
      providerId: REMOTE_MERCHANT.providerId,
      requirements: { currency: 'USD' },
    }),
    (error) => error.code === 'NEGOTIATION_CONTENT_ROOT_MISMATCH',
  );
  await assert.rejects(
    adapter.getOffers({
      missionId: 'mission_wrong_currency',
      contentRoot: manifest.merkleRootSha256,
      providerId: REMOTE_MERCHANT.providerId,
      requirements: { currency: 'EUR' },
    }),
    (error) => error.code === 'NEGOTIATION_CURRENCY_NOT_SUPPORTED',
  );

  const substituted = new RemoteNegotiationAdapter({
    baseUrl: 'https://merchant.example',
    apiToken: API_TOKEN,
    expectedKeyId: signing.keyId,
    contentRoot: manifest.merkleRootSha256,
    currency: 'USD',
    clock: () => new Date(CLOCK),
    fetchImpl: async (url) => new URL(url).pathname.includes('.well-known')
      ? jsonResponse({
        keyId: otherSigning.keyId,
        algorithm: 'Ed25519',
        publicKeyJwk: otherSigning.publicKey.export({ format: 'jwk' }),
      })
      : jsonResponse(quote),
  });
  substituted.bindSession('mission_unit_test', quote.sessionId);
  await assert.rejects(
    substituted.getBindingQuote({ sessionId: quote.sessionId, quoteId: quote.quoteId }),
    (error) => error.code === 'MERCHANT_KEY_PIN_MISMATCH',
  );
});

test('remote negotiation never reflects upstream error details or credentials', async () => {
  const { manifest } = fixtureManifest();
  const signing = signingFixture();
  const adapter = new RemoteNegotiationAdapter({
    baseUrl: 'https://merchant.example',
    apiToken: API_TOKEN,
    expectedKeyId: signing.keyId,
    contentRoot: manifest.merkleRootSha256,
    currency: 'USD',
    fetchImpl: async () => jsonResponse({
      error: {
        code: API_TOKEN,
        message: `credential=${API_TOKEN}`,
      },
    }, 422),
  });

  await assert.rejects(
    adapter.getOffers({
      missionId: 'mission_sanitized_error',
      contentRoot: manifest.merkleRootSha256,
      providerId: REMOTE_MERCHANT.providerId,
      requirements: { currency: 'USD' },
    }),
    (error) => error.code === 'MERCHANT_REQUEST_REJECTED'
      && !error.message.includes(API_TOKEN),
  );
});

test('remote recovery starts synchronously, verifies the pinned manifest lazily, and reconstructs exact bytes', async () => {
  const { manifest, bytes } = fixtureManifest();
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    const pathname = new URL(url).pathname;
    calls.push(pathname);
    assert.equal(options.headers.Authorization, `Bearer ${API_TOKEN}`);
    if (pathname.endsWith('/manifest')) return jsonResponse(manifest);
    const index = Number(pathname.split('/').at(-1));
    return new Response(bytes[index], {
      status: 200,
      headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(bytes[index].length) },
    });
  };
  const adapter = new RemoteRecoveryAdapter({
    baseUrl: 'https://merchant.example',
    apiToken: API_TOKEN,
    trustedManifest: manifest,
    currency: 'USD',
    fetchImpl,
  });
  const expected = adapter.buildManifest();
  assert.equal(expected.totalPieces, 2);
  assert.equal(expected.contentRoot, manifest.merkleRootSha256);
  assert.throws(() => adapter.buildManifest(24), /piece count/i);
  const initial = adapter.start('mission_remote', expected);
  assert.equal(initial.recovered, 0);
  assert.deepEqual(calls, []);

  assert.equal((await adapter.recoverThrough('mission_remote', 1)).recovered, 1);
  assert.equal((await adapter.recoverThrough('mission_remote', 2)).recovered, 2);
  assert.equal(adapter.verifyAll('mission_remote').verified, 2);
  assert.deepEqual(adapter.reconstruct('mission_remote'), {
    bytes: Buffer.concat(bytes).length,
    contentSha256: manifest.artifactSha256,
    matches: true,
  });
  assert.equal(calls.filter((pathname) => pathname.endsWith('/manifest')).length, 1);
  assert.equal(adapter.provider, REMOTE_PROVIDER);
  assert.deepEqual(adapter.supportedCurrencies, ['USD']);
  assert.doesNotMatch(JSON.stringify(adapter), new RegExp(API_TOKEN));
});

test('remote recovery fails closed on manifest substitution, corrupt pieces, oversize bodies, and unpinned mission state', async () => {
  const { manifest, bytes } = fixtureManifest();
  const makeAdapter = (fetchImpl) => new RemoteRecoveryAdapter({
    baseUrl: 'https://merchant.example',
    apiToken: API_TOKEN,
    trustedManifest: manifest,
    currency: 'USD',
    fetchImpl,
  });

  const substituted = makeAdapter(async (url) => new URL(url).pathname.endsWith('/manifest')
    ? jsonResponse({ ...manifest, license: 'Proprietary' })
    : new Response(bytes[0]));
  substituted.start('mission_substituted', substituted.buildManifest());
  await assert.rejects(
    substituted.recoverThrough('mission_substituted', 1),
    (error) => error.code === 'PROVIDER_MANIFEST_PIN_MISMATCH',
  );

  const corrupt = makeAdapter(async (url) => {
    const pathname = new URL(url).pathname;
    if (pathname.endsWith('/manifest')) return jsonResponse(manifest);
    const index = Number(pathname.split('/').at(-1));
    const changed = Buffer.from(bytes[index]);
    changed[0] ^= 0xff;
    return new Response(changed);
  });
  corrupt.start('mission_corrupt', corrupt.buildManifest());
  await corrupt.recoverThrough('mission_corrupt', 2);
  assert.throws(
    () => corrupt.verifyAll('mission_corrupt'),
    (error) => error.code === 'PIECE_HASH_MISMATCH:0',
  );

  const oversized = makeAdapter(async (url) => new URL(url).pathname.endsWith('/manifest')
    ? jsonResponse(manifest)
    : new Response(Buffer.alloc(bytes[0].length + 1)));
  oversized.start('mission_oversized', oversized.buildManifest());
  await assert.rejects(
    oversized.recoverThrough('mission_oversized', 1),
    (error) => error.code === 'PROVIDER_RESPONSE_TOO_LARGE',
  );

  const wrongExpected = makeAdapter(async () => {
    throw new Error('no network should be called');
  });
  assert.throws(
    () => wrongExpected.start('mission_wrong', {
      ...wrongExpected.buildManifest(),
      contentRoot: 'f'.repeat(64),
    }),
    (error) => error.code === 'EXPECTED_MANIFEST_PIN_MISMATCH',
  );
});

test('application completes an authenticated remote bargain and eight-piece recovery without moving funds', async () => {
  const { manifest, bytes } = fixtureManifest(8);
  const signing = signingFixture();
  const now = new Date();
  const quote = signedQuote({
    manifest,
    signing,
    issuedAt: new Date(now.getTime() - 60_000).toISOString(),
    expiresAt: new Date(now.getTime() + 15 * 60_000).toISOString(),
  });
  const session = sessionFor(quote, { initialOfferAmountMinor: 1100 });
  const paths = [];
  const fetchImpl = async (url, options = {}) => {
    const pathname = new URL(url).pathname;
    paths.push(pathname);
    if (pathname === '/.well-known/lazarus-merchant-key.json') {
      return jsonResponse({
        keyId: signing.keyId,
        algorithm: 'Ed25519',
        publicKeyJwk: signing.publicKey.export({ format: 'jwk' }),
      });
    }
    assert.equal(options.headers.Authorization, `Bearer ${API_TOKEN}`);
    if (pathname === '/api/offers') {
      const offerRequest = JSON.parse(options.body);
      assert.deepEqual(offerRequest.bounty, {
        status: 'proposed-local-ledger',
        rewardMinor: 500,
        stakeMinor: 200,
        currency: 'USD',
        deadline: mission.deadline,
        settlementNetwork: 'eip155:10143',
        settlementAsset: 'USDC',
        onchain: false,
      });
      return jsonResponse(session, 201);
    }
    if (pathname.endsWith('/counters')) return jsonResponse({ session, round: session.rounds[0], quote });
    if (pathname.endsWith(`/quotes/${quote.quoteId}`)) return jsonResponse(quote);
    if (pathname.endsWith('/manifest')) return jsonResponse(manifest);
    const pieceMatch = pathname.match(/\/pieces\/(\d+)$/);
    if (pieceMatch) return new Response(bytes[Number(pieceMatch[1])], { status: 200 });
    return jsonResponse({ error: { code: 'NOT_FOUND', message: 'Not found.' } }, 404);
  };
  const negotiation = new RemoteNegotiationAdapter({
    baseUrl: 'https://merchant.example',
    apiToken: API_TOKEN,
    expectedKeyId: signing.keyId,
    contentRoot: manifest.merkleRootSha256,
    currency: 'USD',
    fetchImpl,
    clock: () => now,
  });
  const recovery = new RemoteRecoveryAdapter({
    baseUrl: 'https://merchant.example',
    apiToken: API_TOKEN,
    trustedManifest: manifest,
    currency: 'USD',
    fetchImpl,
  });
  const store = new MemoryStore(() => ({ missions: [] }));
  const app = createApplication({
    store,
    adapterOverrides: { negotiation, recovery },
  });
  const mission = store.get().missions[0];
  session.missionId = mission.id;

  assert.equal(app.system.mode, 'hybrid-external-demo');
  assert.equal(app.system.negotiation.bountyMessaging, true);
  assert.equal(app.system.actors.merchant.id, REMOTE_MERCHANT.merchantId);
  assert.equal(app.system.actors.provider.id, REMOTE_PROVIDER.providerId);
  assert.deepEqual(app.system.missionCreation.supportedCurrencies, ['USD']);
  assert.equal(mission.manifest.totalPieces, 8);

  await app.orchestrator.run(mission.id, 0);

  assert.equal(mission.status, 'COMPLETED');
  assert.equal(mission.negotiation.acceptedQuote.merchantSigned, true);
  assert.equal(mission.negotiation.acceptedQuote.merchantAuthenticated, true);
  assert.equal(mission.negotiation.initialOfferAmountMinor, 1100);
  assert.equal(mission.negotiation.savingsMinor, 125);
  assert.equal(mission.negotiation.decision.details.savingsMinor, 125);
  assert.equal(mission.pieces.recovered, 8);
  assert.equal(mission.pieces.verified, 8);
  assert.equal(mission.audit.rootMatched, true);
  assert.equal(mission.rainCard.mode, 'local');
  assert.ok(mission.payments.every((payment) => payment.fundsMoved === false));
  assert.ok(mission.transactions.every((transaction) => transaction.chainWrite !== true));
  assert.ok(paths.includes('/api/offers'));
  assert.ok(paths.includes('/.well-known/lazarus-merchant-key.json'));
  assert.ok(paths.some((pathname) => pathname.endsWith('/manifest')));
  assert.equal(paths.filter((pathname) => /\/pieces\/\d+$/.test(pathname)).length, 8);
});

test('serverless hybrid deployment rehydrates remote recovery and Rain authority without duplicating external effects', async () => {
  const { manifest, bytes } = fixtureManifest(8);
  const signing = signingFixture();
  const now = new Date();
  const quote = signedQuote({
    manifest,
    signing,
    issuedAt: new Date(now.getTime() - 60_000).toISOString(),
    expiresAt: new Date(now.getTime() + 15 * 60_000).toISOString(),
  });
  const session = sessionFor(quote, { initialOfferAmountMinor: 1100 });
  const merchantCalls = [];
  const merchantFetch = async (url, options = {}) => {
    const pathname = new URL(url).pathname;
    merchantCalls.push({ pathname, method: options.method || 'GET' });
    if (pathname === '/.well-known/lazarus-merchant-key.json') {
      return jsonResponse({
        keyId: signing.keyId,
        algorithm: 'Ed25519',
        publicKeyJwk: signing.publicKey.export({ format: 'jwk' }),
      });
    }
    assert.equal(options.headers.Authorization, `Bearer ${API_TOKEN}`);
    if (pathname === '/api/offers') return jsonResponse(session, 201);
    if (pathname.endsWith('/counters')) {
      return jsonResponse({ session, round: session.rounds[0], quote });
    }
    if (pathname.endsWith(`/quotes/${quote.quoteId}`)) return jsonResponse(quote);
    if (pathname.endsWith('/manifest')) return jsonResponse(manifest);
    const pieceMatch = pathname.match(/\/pieces\/(\d+)$/);
    if (pieceMatch) return new Response(bytes[Number(pieceMatch[1])], { status: 200 });
    return jsonResponse({ error: { code: 'NOT_FOUND', message: 'Not found.' } }, 404);
  };

  const rainCardId = '44444444-4444-4444-8444-444444444444';
  const declinedTransactionId = '55555555-5555-4555-8555-555555555555';
  const settledTransactionId = '66666666-6666-4666-8666-666666666666';
  const rainCalls = [];
  const rainFetch = async (url, options = {}) => {
    const pathname = new URL(url).pathname;
    const body = options.body ? JSON.parse(options.body) : null;
    rainCalls.push({ pathname, method: options.method || 'GET', body });
    if (pathname.endsWith('/cards/scoped')) {
      return jsonResponse({
        id: rainCardId,
        last4: '0885',
        status: 'active',
        encryptedPan: { data: 'must-not-persist' },
        encryptedCvc: { data: 'must-not-persist' },
      });
    }
    if (pathname.endsWith('/simulate/transactions/authorize')) {
      if (body.merchantName === 'Unrelated Luxury Market') {
        return jsonResponse({
          transactionId: declinedTransactionId,
          status: 'declined',
          declinedReason: 'scoped_card_mcc_not_allowed',
        });
      }
      assert.equal(body.merchantName, REMOTE_MERCHANT.merchantName);
      return jsonResponse({ transactionId: settledTransactionId, status: 'authorized' });
    }
    if (pathname.endsWith(`/simulate/transactions/${settledTransactionId}/settle`)) {
      return jsonResponse({
        transactionId: settledTransactionId,
        status: 'settled',
        completionReason: 'SETTLEMENT',
      });
    }
    throw new Error(`Unexpected Rain request: ${pathname}`);
  };

  const negotiation = new RemoteNegotiationAdapter({
    baseUrl: 'https://merchant.example',
    apiToken: API_TOKEN,
    expectedKeyId: signing.keyId,
    contentRoot: manifest.merkleRootSha256,
    currency: 'USD',
    fetchImpl: merchantFetch,
    clock: () => now,
  });
  const recovery = new RemoteRecoveryAdapter({
    baseUrl: 'https://merchant.example',
    apiToken: API_TOKEN,
    trustedManifest: manifest,
    currency: 'USD',
    fetchImpl: merchantFetch,
  });
  const rain = new RainSandboxAdapter({
    baseUrl: 'https://rain.invalid/v1',
    allowedOrigin: 'https://rain.invalid',
    apiKey: 'unit-test-rain-api-key',
    userId: '11111111-1111-4111-8111-111111111111',
    teamId: '22222222-2222-4222-8222-222222222222',
    contractId: '33333333-3333-4333-8333-333333333333',
    autoFundMinor: 0,
    fetchImpl: rainFetch,
    clock: () => now,
  });
  const store = new MemoryStore(() => ({ missions: [] }));
  const app = createApplication({
    adapterMode: 'rain-sandbox',
    store,
    resetStateOnStart: false,
    allowRemoteHost: true,
    enableEventStream: false,
    runtime: 'vercel',
    adapterOverrides: { negotiation, recovery, rain },
  });
  store.replace(app.stateFactory());
  const missionId = store.get().activeMissionId;
  session.missionId = missionId;

  for (let step = 1; step <= 9; step += 1) {
    await rehydrateLocalAdapters(store.get(), app.adapters, {
      targetMissionId: missionId,
      restoreTargetRecovery: true,
    });
    await app.orchestrator.step(missionId);
    assert.equal(store.get().missions[0].stepIndex, step);
    store.replace(JSON.parse(JSON.stringify(store.get())));
  }

  const mission = store.get().missions[0];
  const rainPayments = mission.payments.filter((payment) => payment.mode === 'rain-sandbox');
  const declined = rainPayments.filter((payment) => payment.authorized === false);
  const settled = rainPayments.filter((payment) => payment.authorized === true);
  const scopedCardCalls = rainCalls.filter((call) => call.pathname.endsWith('/cards/scoped'));
  const authorizationCalls = rainCalls.filter((call) => call.pathname.endsWith('/simulate/transactions/authorize'));
  const settlementCalls = rainCalls.filter((call) => call.pathname.endsWith('/settle'));

  assert.equal(mission.status, 'COMPLETED');
  assert.equal(mission.pieces.recovered, 8);
  assert.equal(mission.pieces.verified, 8);
  assert.equal(mission.audit.rootMatched, true);
  assert.equal(mission.provider.externalEndpoint, true);
  assert.equal(mission.rainCard.cardId, rainCardId);
  assert.equal(mission.rainCard.state, 'expiry_scheduled');
  assert.equal(mission.rainCard.transactionCount, 1);
  assert.equal(scopedCardCalls.length, 1);
  assert.equal(authorizationCalls.length, 2);
  assert.equal(settlementCalls.length, 1);
  assert.equal(declined.length, 1);
  assert.equal(declined[0].transactionId, declinedTransactionId);
  assert.equal(declined[0].code, 'MERCHANT_NOT_ALLOWED');
  assert.equal(declined[0].remoteAttempted, true);
  assert.equal(settled.length, 1);
  assert.equal(settled[0].transactionId, settledTransactionId);
  assert.equal(settled[0].status, 'settled');
  assert.equal(settled[0].quoteId, quote.quoteId);
  assert.equal(mission.negotiation.acceptedQuote.merchantSigned, true);
  assert.equal(mission.negotiation.acceptedQuote.merchantAuthenticated, true);
  const completionEvent = mission.events.find((event) => event.title === 'Mission completed');
  assert.match(completionEvent.description, /Rain's sandbox ledger recorded the scoped-card settlement/i);
  assert.doesNotMatch(completionEvent.description, /card allocation.*local|\$0\.00 charged/i);
  assert.deepEqual(
    [...new Set(merchantCalls
      .map((call) => call.pathname.match(/\/pieces\/(\d+)$/)?.[1])
      .filter(Boolean)
      .map(Number))].sort((left, right) => left - right),
    [0, 1, 2, 3, 4, 5, 6, 7],
  );

  const externalEffects = {
    offerPosts: merchantCalls.filter((call) => call.pathname === '/api/offers').length,
    counterPosts: merchantCalls.filter((call) => call.pathname.endsWith('/counters')).length,
    scopedCards: scopedCardCalls.length,
    authorizations: authorizationCalls.length,
    settlements: settlementCalls.length,
  };
  assert.deepEqual(externalEffects, {
    offerPosts: 1,
    counterPosts: 1,
    scopedCards: 1,
    authorizations: 2,
    settlements: 1,
  });

  await rehydrateLocalAdapters(store.get(), app.adapters, {
    targetMissionId: missionId,
    restoreTargetRecovery: true,
  });
  await rehydrateLocalAdapters(store.get(), app.adapters, {
    targetMissionId: missionId,
    restoreTargetRecovery: true,
  });
  assert.equal(rain.cards.size, 0);
  assert.deepEqual({
    offerPosts: merchantCalls.filter((call) => call.pathname === '/api/offers').length,
    counterPosts: merchantCalls.filter((call) => call.pathname.endsWith('/counters')).length,
    scopedCards: rainCalls.filter((call) => call.pathname.endsWith('/cards/scoped')).length,
    authorizations: rainCalls.filter((call) => call.pathname.endsWith('/simulate/transactions/authorize')).length,
    settlements: rainCalls.filter((call) => call.pathname.endsWith('/settle')).length,
  }, externalEffects);
});
