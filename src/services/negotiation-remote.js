'use strict';

const crypto = require('node:crypto');
const { createQuoteDigest } = require('../domain');
const { normalizeCurrency } = require('../domain/currency');

const REMOTE_MERCHANT = Object.freeze({
  merchantId: 'merchant_lazarus_operator',
  merchantName: 'Lazarus Recovery Merchant',
  providerId: 'provider_lazarus_operator',
  mcc: '5734',
});

const KEY_ID_PATTERN = /^merchant_ed25519_[a-f0-9]{64}$/;
const CONTENT_ROOT_PATTERN = /^[a-f0-9]{64}$/;
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_RESPONSE_LIMIT_BYTES = 1_048_576;
const MAXIMUM_QUOTE_TTL_MS = 60 * 60 * 1_000;
const MAXIMUM_CLOCK_SKEW_MS = 30 * 1_000;

class RemoteMerchantError extends Error {
  constructor(code, message, { statusCode = 502 } = {}) {
    super(message);
    this.name = 'RemoteMerchantError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

class RemoteNegotiationAdapter {
  constructor({
    baseUrl,
    apiToken,
    expectedKeyId,
    contentRoot,
    currency,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    responseLimitBytes = DEFAULT_RESPONSE_LIMIT_BYTES,
    fetchImpl = globalThis.fetch,
    clock = () => new Date(),
  } = {}) {
    this.baseUrl = validateBaseUrl(baseUrl, 'Merchant');
    defineSecret(this, 'apiToken', requiredString(apiToken, 'apiToken'));
    this.expectedKeyId = validateKeyId(expectedKeyId);
    this.contentRoot = validateContentRoot(contentRoot);
    this.currency = validateCurrency(currency);
    this.timeoutMs = positiveInteger(timeoutMs, 'timeoutMs', 30_000);
    this.responseLimitBytes = positiveInteger(
      responseLimitBytes,
      'responseLimitBytes',
      1_048_576,
    );
    if (typeof fetchImpl !== 'function') throw configurationError('fetchImpl must be a function.');
    if (typeof clock !== 'function') throw configurationError('clock must be a function.');
    this.fetch = fetchImpl;
    this.clock = clock;
    this.mode = 'live-merchant-api';
    this.liveMerchantApi = true;
    this.merchantAuthenticated = true;
    this.merchantSignedQuotes = true;
    this.bountyMessaging = true;
    this.merchant = REMOTE_MERCHANT;
    this.provider = Object.freeze({
      providerId: REMOTE_MERCHANT.providerId,
      providerName: 'Lazarus Recovery Merchant',
    });
    this.supportedCurrencies = Object.freeze([this.currency]);
    this.key = null;
    this.missionSessions = new Map();
    this.sessionBindings = new Map();
  }

  reset() {
    this.missionSessions.clear();
    this.sessionBindings.clear();
  }

  async getOffers(input = {}) {
    assertOfferRequest(input, this);
    const session = await this.request('/api/offers', { method: 'POST', body: input });
    validateSession(session, this, null, input.missionId);
    this.bindSession(input.missionId, session.sessionId, input.bounty?.deadline);
    return session;
  }

  async sendCounterOffer(input = {}) {
    const sessionId = requiredIdentifier(input.sessionId, 'sessionId');
    const binding = this.requireSessionBinding(sessionId);
    requiredIdentifier(input.offerId, 'offerId');
    positiveMinor(input.amountMinor, 'amountMinor');
    const response = await this.request(
      `/api/sessions/${encodeURIComponent(sessionId)}/counters`,
      { method: 'POST', body: input },
    );
    if (!response || typeof response !== 'object' || Array.isArray(response)) {
      throw upstreamInvalid('Merchant counter response is not an object.');
    }
    validateSession(response.session, this, sessionId, binding.missionId);
    validateRound(response.round, sessionId);
    if (response.quote !== null && response.quote !== undefined) {
      validateQuoteShape(response.quote, this, sessionId, null, binding.deadlineMs);
    }
    return response;
  }

  async getBindingQuote({ sessionId, quoteId } = {}) {
    sessionId = requiredIdentifier(sessionId, 'sessionId');
    quoteId = requiredIdentifier(quoteId, 'quoteId');
    const binding = this.requireSessionBinding(sessionId);
    const quote = await this.request(
      `/api/sessions/${encodeURIComponent(sessionId)}/quotes/${encodeURIComponent(quoteId)}`,
    );
    validateQuoteShape(quote, this, sessionId, quoteId, binding.deadlineMs);
    await this.verifyQuote(quote);
    return quote;
  }

  async getSession(sessionId) {
    sessionId = requiredIdentifier(sessionId, 'sessionId');
    const binding = this.requireSessionBinding(sessionId);
    const session = await this.request(`/api/sessions/${encodeURIComponent(sessionId)}`);
    validateSession(session, this, sessionId, binding.missionId);
    return session;
  }

  bindSession(missionId, sessionId, deadline) {
    const existingSession = this.missionSessions.get(missionId);
    const existingBinding = this.sessionBindings.get(sessionId);
    const existingMission = existingBinding?.missionId;
    if (
      (existingSession && existingSession !== sessionId)
      || (existingMission && existingMission !== missionId)
    ) {
      throw new RemoteMerchantError(
        'MERCHANT_SESSION_BINDING_MISMATCH',
        'Merchant session is already bound to another mission.',
        { statusCode: 422 },
      );
    }
    let deadlineMs = optionalDeadline(deadline);
    if (
      existingBinding
      && existingBinding.deadlineMs !== null
      && deadlineMs !== null
      && existingBinding.deadlineMs !== deadlineMs
    ) {
      throw new RemoteMerchantError(
        'MERCHANT_SESSION_BINDING_MISMATCH',
        'Merchant session deadline does not match its active mission.',
        { statusCode: 422 },
      );
    }
    if (existingBinding && existingBinding.deadlineMs !== null && deadlineMs === null) {
      deadlineMs = existingBinding.deadlineMs;
    }
    this.missionSessions.set(missionId, sessionId);
    this.sessionBindings.set(sessionId, Object.freeze({ missionId, deadlineMs }));
  }

  requireSessionBinding(sessionId) {
    const binding = this.sessionBindings.get(sessionId);
    if (!binding) {
      throw new RemoteMerchantError(
        'MERCHANT_SESSION_NOT_BOUND',
        'Merchant session is not bound to an active mission.',
        { statusCode: 409 },
      );
    }
    return binding;
  }

  async health() {
    const [remote, key] = await Promise.all([
      this.request('/api/health', { authenticated: false }),
      this.getKey(),
    ]);
    if (
      remote?.ok !== true
      || remote.mode !== 'live-merchant-api'
      || remote.merchantAuthenticated !== true
      || remote.merchantSignedQuotes !== true
    ) {
      throw new RemoteMerchantError('MERCHANT_HEALTH_INVALID', 'Merchant health response is not ready.');
    }
    return {
      ok: remote.paused !== true,
      mode: this.mode,
      authenticated: true,
      signedQuotes: true,
      keyPinned: true,
      keyId: key.keyId,
      paused: remote.paused === true,
      persistence: typeof remote.persistence === 'string' ? remote.persistence : 'not-reported',
    };
  }

  async verifyQuote(quote) {
    validateQuoteShape(quote, this);
    const digest = createQuoteDigest(quote);
    if (!constantStringEqual(digest, quote.quoteDigest)) {
      throw new RemoteMerchantError('MERCHANT_QUOTE_DIGEST_INVALID', 'Merchant quote digest is invalid.', {
        statusCode: 422,
      });
    }

    const key = await this.getKey();
    const signature = quote.signature;
    if (
      signature?.algorithm !== 'Ed25519'
      || signature.keyId !== key.keyId
      || typeof signature.nonce !== 'string'
      || signature.nonce.length < 1
      || signature.nonce.length > 256
      || !strictBase64(signature.value, 64)
    ) {
      throw untrustedQuote();
    }

    const payload = Buffer.from(canonicalStringify({
      keyId: signature.keyId,
      nonce: signature.nonce,
      quoteDigest: quote.quoteDigest,
    }));
    let valid = false;
    try {
      valid = crypto.verify(
        null,
        payload,
        key.publicKey,
        Buffer.from(signature.value, 'base64'),
      );
    } catch {
      valid = false;
    }
    if (!valid || quote.merchantAuthenticated !== true || quote.merchantSigned !== true) {
      throw untrustedQuote();
    }
    return true;
  }

  async getKey() {
    if (this.key) return this.key;
    const key = await this.request('/.well-known/lazarus-merchant-key.json', {
      authenticated: false,
    });
    if (
      !key
      || typeof key !== 'object'
      || Array.isArray(key)
      || key.algorithm !== 'Ed25519'
      || !key.publicKeyJwk
      || key.publicKeyJwk.kty !== 'OKP'
      || key.publicKeyJwk.crv !== 'Ed25519'
      || typeof key.publicKeyJwk.x !== 'string'
      || Object.hasOwn(key.publicKeyJwk, 'd')
    ) {
      throw new RemoteMerchantError('MERCHANT_KEY_INVALID', 'Merchant public key is invalid.');
    }

    let publicKey;
    let fingerprint;
    try {
      publicKey = crypto.createPublicKey({ key: key.publicKeyJwk, format: 'jwk' });
      fingerprint = `merchant_ed25519_${crypto.createHash('sha256')
        .update(publicKey.export({ type: 'spki', format: 'der' }))
        .digest('hex')}`;
    } catch {
      throw new RemoteMerchantError('MERCHANT_KEY_INVALID', 'Merchant public key is invalid.');
    }
    if (
      key.keyId !== fingerprint
      || !constantStringEqual(fingerprint, this.expectedKeyId)
    ) {
      throw new RemoteMerchantError('MERCHANT_KEY_PIN_MISMATCH', 'Merchant public key does not match the configured pin.', {
        statusCode: 422,
      });
    }
    this.key = Object.freeze({ keyId: fingerprint, publicKey });
    return this.key;
  }

  async request(pathname, { method = 'GET', body, authenticated = true } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      let response;
      try {
        response = await this.fetch(new URL(pathname, this.baseUrl), {
          method,
          redirect: 'error',
          signal: controller.signal,
          headers: {
            Accept: 'application/json',
            ...(authenticated ? { Authorization: `Bearer ${this.apiToken}` } : {}),
            ...(body ? { 'Content-Type': 'application/json' } : {}),
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
        });
      } catch (error) {
        if (controller.signal.aborted || error?.name === 'AbortError') {
          throw new RemoteMerchantError('MERCHANT_REQUEST_TIMEOUT', 'Merchant request timed out.');
        }
        throw new RemoteMerchantError('MERCHANT_UNREACHABLE', 'Merchant endpoint could not be reached.');
      }

      const text = await boundedText(response, this.responseLimitBytes);
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new RemoteMerchantError('MERCHANT_RESPONSE_INVALID', 'Merchant returned invalid JSON.');
      }
      if (!response.ok) {
        throw new RemoteMerchantError(
          response.status >= 500 ? 'MERCHANT_UPSTREAM_FAILED' : 'MERCHANT_REQUEST_REJECTED',
          response.status >= 500
            ? 'Merchant service could not complete the request.'
            : `Merchant rejected the request with status ${response.status}.`,
          {
          statusCode: response.status >= 500 ? 502 : response.status,
          },
        );
      }
      return parsed;
    } finally {
      clearTimeout(timer);
    }
  }

  toJSON() {
    return {
      mode: this.mode,
      liveMerchantApi: true,
      merchantAuthenticated: true,
      merchantSignedQuotes: true,
      bountyMessaging: true,
      merchant: this.merchant,
      provider: this.provider,
      supportedCurrencies: this.supportedCurrencies,
    };
  }
}

function assertOfferRequest(input, adapter) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new RemoteMerchantError('INVALID_NEGOTIATION_REQUEST', 'Offer request must be an object.', {
      statusCode: 422,
    });
  }
  requiredIdentifier(input.missionId, 'missionId');
  if (input.contentRoot !== adapter.contentRoot) {
    throw new RemoteMerchantError('NEGOTIATION_CONTENT_ROOT_MISMATCH', 'Offer request does not match the pinned artifact root.', {
      statusCode: 422,
    });
  }
  if (input.providerId !== REMOTE_MERCHANT.providerId) {
    throw new RemoteMerchantError('NEGOTIATION_PROVIDER_NOT_SUPPORTED', 'Offer request uses an unsupported provider.', {
      statusCode: 422,
    });
  }
  const currency = validateCurrency(input.requirements?.currency);
  if (currency !== adapter.currency) {
    throw new RemoteMerchantError('NEGOTIATION_CURRENCY_NOT_SUPPORTED', 'Merchant does not support the requested mission currency.', {
      statusCode: 422,
    });
  }
}

function validateSession(session, adapter, expectedSessionId = null, expectedMissionId = null) {
  if (!session || typeof session !== 'object' || Array.isArray(session)) throw upstreamInvalid('Merchant session is invalid.');
  const sessionId = requiredIdentifier(session.sessionId, 'sessionId');
  const missionId = requiredIdentifier(session.missionId, 'missionId');
  if (
    (expectedSessionId && sessionId !== expectedSessionId)
    || (expectedMissionId && missionId !== expectedMissionId)
    || session.contentRoot !== adapter.contentRoot
    || session.providerId !== REMOTE_MERCHANT.providerId
    || session.currency !== adapter.currency
    || !Array.isArray(session.offers)
    || session.offers.length < 1
  ) throw upstreamInvalid('Merchant session does not match the configured market.');
  for (const offer of session.offers) validateOffer(offer, adapter, sessionId);
  if (!Array.isArray(session.rounds)) throw upstreamInvalid('Merchant session rounds are invalid.');
  for (const round of session.rounds) validateRound(round, sessionId);
  return session;
}

function validateOffer(offer, adapter, sessionId) {
  if (
    !offer
    || typeof offer !== 'object'
    || Array.isArray(offer)
    || requiredIdentifier(offer.offerId, 'offerId').length === 0
    || offer.sessionId !== sessionId
    || offer.merchantId !== REMOTE_MERCHANT.merchantId
    || offer.merchantName !== REMOTE_MERCHANT.merchantName
    || offer.providerId !== REMOTE_MERCHANT.providerId
    || offer.mcc !== REMOTE_MERCHANT.mcc
    || offer.contentRoot !== adapter.contentRoot
    || offer.currency !== adapter.currency
    || offer.merchantAuthenticated !== true
    || offer.binding !== false
    || !Number.isSafeInteger(offer.amountMinor)
    || offer.amountMinor <= 0
  ) throw upstreamInvalid('Merchant offer is invalid.');
}

function validateRound(round, sessionId) {
  if (
    !round
    || typeof round !== 'object'
    || Array.isArray(round)
    || round.sessionId !== undefined && round.sessionId !== sessionId
    || !round.seller
    || !['accept', 'counter', 'decline'].includes(round.seller.action)
    || !Number.isSafeInteger(round.seller.amountMinor)
    || round.seller.amountMinor <= 0
  ) throw upstreamInvalid('Merchant negotiation round is invalid.');
}

function validateQuoteShape(
  quote,
  adapter,
  expectedSessionId = null,
  expectedQuoteId = null,
  maximumExpiryMs = null,
) {
  if (!quote || typeof quote !== 'object' || Array.isArray(quote)) throw untrustedQuote();
  const issuedAt = timestamp(quote.issuedAt);
  const expiresAt = timestamp(quote.expiresAt);
  const now = timestamp(adapter.clock());
  if (
    (expectedSessionId && quote.sessionId !== expectedSessionId)
    || (expectedQuoteId && quote.quoteId !== expectedQuoteId)
    || quote.merchantId !== REMOTE_MERCHANT.merchantId
    || quote.merchantName !== REMOTE_MERCHANT.merchantName
    || quote.providerId !== REMOTE_MERCHANT.providerId
    || quote.mcc !== REMOTE_MERCHANT.mcc
    || quote.contentRoot !== adapter.contentRoot
    || quote.currency !== adapter.currency
    || quote.binding !== true
    || quote.merchantAuthenticated !== true
    || quote.merchantSigned !== true
    || !Number.isSafeInteger(quote.amountMinor)
    || quote.amountMinor <= 0
    || issuedAt === null
    || expiresAt === null
    || now === null
    || expiresAt <= issuedAt
    || issuedAt > now + MAXIMUM_CLOCK_SKEW_MS
    || expiresAt - issuedAt > MAXIMUM_QUOTE_TTL_MS + MAXIMUM_CLOCK_SKEW_MS
    || (maximumExpiryMs !== null && expiresAt > maximumExpiryMs)
    || now >= expiresAt
  ) throw untrustedQuote();
}

function optionalDeadline(value) {
  if (value === undefined || value === null || value === '') return null;
  const deadline = timestamp(value);
  if (deadline === null) {
    throw new RemoteMerchantError('INVALID_NEGOTIATION_REQUEST', 'Bounty deadline is invalid.', {
      statusCode: 422,
    });
  }
  return deadline;
}

function validateBaseUrl(value, label) {
  let url;
  try {
    url = new URL(requiredString(value, 'baseUrl'));
  } catch {
    throw configurationError(`${label} base URL is invalid.`);
  }
  const local = ['127.0.0.1', 'localhost', '::1'].includes(url.hostname.toLowerCase());
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) {
    throw configurationError(`${label} base URL must use HTTPS except on loopback.`);
  }
  if (url.username || url.password || url.search || url.hash) {
    throw configurationError(`${label} base URL must not contain credentials, query, or fragment.`);
  }
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/`;
  return url;
}

function validateKeyId(value) {
  value = requiredString(value, 'expectedKeyId');
  if (!KEY_ID_PATTERN.test(value)) throw configurationError('expectedKeyId must be a pinned Ed25519 fingerprint.');
  return value;
}

function validateContentRoot(value) {
  value = requiredString(value, 'contentRoot');
  if (!CONTENT_ROOT_PATTERN.test(value)) throw configurationError('contentRoot must be a lowercase SHA-256 Merkle root.');
  return value;
}

function validateCurrency(value) {
  const currency = normalizeCurrency(value, '');
  if (!currency) throw configurationError('currency must be USD, EUR, GBP, CAD, or AUD.');
  return currency;
}

function requiredString(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw configurationError(`${name} is required.`);
  return value.trim();
}

function requiredIdentifier(value, name) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value)) {
    throw new RemoteMerchantError('INVALID_NEGOTIATION_REQUEST', `${name} is invalid.`, { statusCode: 422 });
  }
  return value;
}

function positiveMinor(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RemoteMerchantError('INVALID_NEGOTIATION_AMOUNT', `${name} must be a positive safe integer.`, {
      statusCode: 422,
    });
  }
  return value;
}

function positiveInteger(value, name, maximum) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw configurationError(`${name} must be a positive integer no greater than ${maximum}.`);
  }
  return value;
}

function configurationError(message) {
  return new RemoteMerchantError('MERCHANT_INVALID_CONFIGURATION', message, { statusCode: 500 });
}

function upstreamInvalid(message) {
  return new RemoteMerchantError('MERCHANT_RESPONSE_INVALID', message);
}

function untrustedQuote() {
  return new RemoteMerchantError('MERCHANT_QUOTE_UNTRUSTED', 'Merchant quote is not trusted.', {
    statusCode: 422,
  });
}

function timestamp(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.getTime() : null;
}

function canonicalStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalStringify(value[key])}`).join(',')}}`;
}

function constantStringEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && crypto.timingSafeEqual(leftBytes, rightBytes);
}

function strictBase64(value, expectedBytes) {
  if (typeof value !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return false;
  const bytes = Buffer.from(value, 'base64');
  return bytes.length === expectedBytes && bytes.toString('base64') === value;
}

async function boundedText(response, maximum) {
  const declared = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > maximum) {
    throw new RemoteMerchantError('MERCHANT_RESPONSE_TOO_LARGE', 'Merchant response exceeded the configured limit.');
  }
  const chunks = [];
  let length = 0;
  for await (const chunk of response.body || []) {
    const bytes = Buffer.from(chunk);
    length += bytes.length;
    if (length > maximum) {
      throw new RemoteMerchantError('MERCHANT_RESPONSE_TOO_LARGE', 'Merchant response exceeded the configured limit.');
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function defineSecret(target, name, value) {
  Object.defineProperty(target, name, {
    value,
    enumerable: false,
    configurable: false,
    writable: false,
  });
}

module.exports = {
  REMOTE_MERCHANT,
  RemoteMerchantError,
  RemoteNegotiationAdapter,
  validateBaseUrl,
};
