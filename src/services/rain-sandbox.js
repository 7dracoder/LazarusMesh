'use strict';

const crypto = require('node:crypto');
const { sha256 } = require('../lib/ids');

const SANDBOX_SESSION_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQCAP192809jZyaw62g/eTzJ3P9H
+RmT88sXUYjQ0K8Bx+rJ83f22+9isKx+lo5UuV8tvOlKwvdDS/pVbzpG7D7NO45c
0zkLOXwDHZkou8fuj8xhDO5Tq3GzcrabNLRLVz3dkx0znfzGOhnY4lkOMIdKxlQb
LuVM/dGDC9UpulF+UwIDAQAB
-----END PUBLIC KEY-----`;

const SANDBOX_KEY_FINGERPRINT = '7aff30e44d882435b7d3c8fd4fdcaa2d9b5a796e3c04160fa0678697ce6a188e';
const RAIN_SANDBOX_ORIGIN = 'https://api-dev.raincards.xyz';
const MAX_RESPONSE_BYTES = 64 * 1024;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

class RainSandboxError extends Error {
  constructor(code, message, { statusCode = 502, providerStatus = null, retryable = false } = {}) {
    super(message);
    this.name = 'RainSandboxError';
    this.code = code;
    this.statusCode = statusCode;
    this.providerStatus = providerStatus;
    this.retryable = retryable;
  }
}

function assertUuid(value, label) {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new RainSandboxError('RAIN_INVALID_CONFIGURATION', `${label} must be a valid UUID.`, { statusCode: 500 });
  }
}

function assertPositiveMinor(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RainSandboxError('RAIN_INVALID_REQUEST', `${label} must be a positive safe integer.`, { statusCode: 422 });
  }
}

function assertStringArray(value, label) {
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== 'string' || !item.trim())) {
    throw new RainSandboxError('RAIN_INVALID_REQUEST', `${label} must be a non-empty string array.`, { statusCode: 422 });
  }
}

function pinnedPublicKey() {
  const key = crypto.createPublicKey(SANDBOX_SESSION_PUBLIC_KEY);
  const der = key.export({ type: 'spki', format: 'der' });
  const fingerprint = crypto.createHash('sha256').update(der).digest('hex');
  if (fingerprint !== SANDBOX_KEY_FINGERPRINT) {
    throw new RainSandboxError('RAIN_SESSION_KEY_MISMATCH', 'Pinned Rain sandbox public key fingerprint mismatch.', { statusCode: 500 });
  }
  return key;
}

function createSessionId() {
  const secret = crypto.randomBytes(16);
  const encodedSecret = Buffer.from(secret.toString('base64'), 'utf8');
  try {
    const encrypted = crypto.publicEncrypt({
      key: pinnedPublicKey(),
      padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: 'sha1',
    }, encodedSecret);
    return encrypted.toString('base64');
  } finally {
    secret.fill(0);
    encodedSecret.fill(0);
  }
}

function idempotencyKey(operation, ...parts) {
  return sha256([operation, ...parts].join('|'));
}

function cardDecision(card, purchase, now) {
  if (!card) return 'CARD_NOT_FOUND';
  if (card.state !== 'active') return 'CARD_INACTIVE';
  if (!Number.isSafeInteger(purchase.amountMinor) || purchase.amountMinor <= 0) return 'INVALID_AMOUNT';
  if (String(purchase.currency || card.currency || 'USD').toUpperCase() !== card.currency) return 'CURRENCY_MISMATCH';
  if (new Date(card.expiresAt).getTime() <= now.getTime()) return 'CARD_EXPIRED';
  if (card.transactionCount >= card.maxTransactions) return 'TRANSACTION_COUNT_EXCEEDED';
  if (purchase.amountMinor > card.maximumAmountMinor) return 'AMOUNT_LIMIT_EXCEEDED';
  if (!card.allowedMerchantIds.includes(purchase.merchantId)) return 'MERCHANT_NOT_ALLOWED';
  if (!card.allowedMccs.includes(purchase.mcc)) return 'MCC_NOT_ALLOWED';
  return 'AUTHORIZED';
}

function safeProviderCode(payload, fallback) {
  if (!payload || typeof payload !== 'object') return fallback;
  const candidate = payload.declinedReason || payload.code || payload.error;
  return typeof candidate === 'string' && /^[A-Za-z0-9_.:-]{1,100}$/.test(candidate)
    ? candidate
    : fallback;
}

function timeoutError() {
  return new RainSandboxError('RAIN_TIMEOUT', 'Rain sandbox request timed out.', { retryable: true });
}

function responseReadError() {
  return new RainSandboxError(
    'RAIN_RESPONSE_READ_FAILED',
    'Rain sandbox response body could not be read.',
    { retryable: true },
  );
}

function readChunk(reader, signal) {
  if (signal.aborted) return Promise.reject(timeoutError());
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      callback(value);
    };
    const onAbort = () => {
      try {
        Promise.resolve(reader.cancel()).catch(() => {});
      } catch {
        // The timeout result remains authoritative even if cancellation fails.
      }
      finish(reject, timeoutError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve()
      .then(() => reader.read())
      .then(
        (result) => finish(resolve, result),
        (error) => finish(
          reject,
          signal.aborted || error?.name === 'AbortError' ? timeoutError() : responseReadError(),
        ),
      );
  });
}

async function readResponsePayload(response, signal) {
  const contentLength = response.headers?.get?.('content-length');
  if (typeof contentLength === 'string' && /^\d+$/.test(contentLength.trim())) {
    if (BigInt(contentLength.trim()) > BigInt(MAX_RESPONSE_BYTES)) {
      try {
        Promise.resolve(response.body?.cancel?.()).catch(() => {});
      } catch {
        // Size rejection remains authoritative even if cancellation fails.
      }
      throw new RainSandboxError(
        'RAIN_RESPONSE_TOO_LARGE',
        'Rain sandbox response exceeded the allowed size.',
      );
    }
  }

  if (response.body === null) return null;
  if (!response.body || typeof response.body.getReader !== 'function') {
    throw new RainSandboxError(
      'RAIN_RESPONSE_STREAM_UNAVAILABLE',
      'Rain sandbox response did not provide a readable body stream.',
    );
  }

  const reader = response.body.getReader();
  const chunks = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await readChunk(reader, signal);
      if (done) break;
      if (!(value instanceof Uint8Array)) throw responseReadError();
      totalBytes += value.byteLength;
      if (totalBytes > MAX_RESPONSE_BYTES) {
        try {
          Promise.resolve(reader.cancel()).catch(() => {});
        } catch {
          // Size rejection remains authoritative even if cancellation fails.
        }
        throw new RainSandboxError(
          'RAIN_RESPONSE_TOO_LARGE',
          'Rain sandbox response exceeded the allowed size.',
        );
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // A cancelled or errored stream may already have released its lock.
    }
  }

  if (totalBytes === 0) return null;
  const text = Buffer.concat(chunks, totalBytes).toString('utf8');
  try {
    return JSON.parse(text);
  } catch {
    // An error response may legitimately be plain text. Preserve its HTTP
    // status so retry and client-error handling remain deterministic.
    if (!response.ok) return null;
    throw new RainSandboxError(
      'RAIN_INVALID_JSON_RESPONSE',
      'Rain sandbox returned an invalid JSON response.',
    );
  }
}

class RainSandboxAdapter {
  constructor({
    baseUrl,
    apiKey,
    userId,
    teamId = null,
    contractId,
    autoFundMinor = 0,
    timeoutMs = 12_000,
    fetchImpl = globalThis.fetch,
    clock = () => new Date(),
    allowedOrigin = RAIN_SANDBOX_ORIGIN,
  } = {}) {
    if (typeof baseUrl !== 'string' || !baseUrl.startsWith('https://')) {
      throw new RainSandboxError('RAIN_INVALID_CONFIGURATION', 'Rain sandbox base URL must use HTTPS.', { statusCode: 500 });
    }
    const parsedBaseUrl = new URL(baseUrl);
    if (parsedBaseUrl.origin !== allowedOrigin) {
      throw new RainSandboxError('RAIN_INVALID_CONFIGURATION', 'Rain sandbox API origin is not allowlisted.', { statusCode: 500 });
    }
    if (typeof apiKey !== 'string' || apiKey.trim().length < 16) {
      throw new RainSandboxError('RAIN_INVALID_CONFIGURATION', 'Rain sandbox API key is required.', { statusCode: 500 });
    }
    assertUuid(userId, 'RAIN_USER_ID');
    if (teamId !== null) assertUuid(teamId, 'RAIN_TEAM_ID');
    assertUuid(contractId, 'RAIN_CONTRACT_ID');
    if (!Number.isSafeInteger(autoFundMinor) || autoFundMinor < 0) {
      throw new RainSandboxError('RAIN_INVALID_CONFIGURATION', 'RAIN_AUTO_FUND_MINOR must be a non-negative integer.', { statusCode: 500 });
    }
    if (typeof fetchImpl !== 'function') {
      throw new RainSandboxError('RAIN_INVALID_CONFIGURATION', 'A fetch implementation is required.', { statusCode: 500 });
    }

    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.baseOrigin = parsedBaseUrl.origin;
    this.apiKey = apiKey;
    this.userId = userId;
    this.teamId = teamId;
    this.contractId = contractId;
    this.autoFundMinor = autoFundMinor;
    this.timeoutMs = Math.min(Math.max(timeoutMs, 1000), 30_000);
    this.fetch = fetchImpl;
    this.clock = clock;
    this.cards = new Map();
    this.collateralReady = null;
    this.mode = 'rain-sandbox';
  }

  reset() {
    this.cards.clear();
    this.collateralReady = null;
  }

  async request(path, { method = 'GET', body, idempotency, extraHeaders = {}, retries = 2 } = {}) {
    if (typeof path !== 'string' || !path.startsWith('/')) {
      throw new RainSandboxError('RAIN_INVALID_REQUEST', 'Rain request path must be relative.', { statusCode: 500 });
    }
    let initialUrl = new URL(`${this.baseUrl}${path}`);
    if (initialUrl.origin !== this.baseOrigin) {
      throw new RainSandboxError('RAIN_REDIRECT_BLOCKED', 'Rain request origin is not allowed.', { statusCode: 500 });
    }

    for (let attempt = 0; attempt <= retries; attempt += 1) {
      let url = initialUrl;
      let response;
      let payload;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        for (let redirects = 0; redirects <= 3; redirects += 1) {
          response = await this.fetch(url, {
            method,
            redirect: 'manual',
            signal: controller.signal,
            headers: {
              Accept: 'application/json',
              'Api-Key': this.apiKey,
              ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
              ...(idempotency ? { 'Idempotency-Key': idempotency } : {}),
              ...extraHeaders,
            },
            ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
          });
          if (![301, 302, 303, 307, 308].includes(response.status)) break;
          const location = response.headers?.get?.('location');
          if (!location) throw new RainSandboxError('RAIN_BAD_REDIRECT', 'Rain returned a redirect without a destination.');
          const redirected = new URL(location, url);
          if (redirected.origin !== this.baseOrigin) {
            throw new RainSandboxError('RAIN_REDIRECT_BLOCKED', 'Cross-origin Rain redirect blocked.');
          }
          url = redirected;
          if (redirects === 3) throw new RainSandboxError('RAIN_TOO_MANY_REDIRECTS', 'Too many Rain redirects.');
        }
        payload = await readResponsePayload(response, controller.signal);
      } catch (error) {
        if (error instanceof RainSandboxError) {
          if (error.retryable && attempt < retries) {
            clearTimeout(timeout);
            await new Promise((resolve) => setTimeout(resolve, 100 * (2 ** attempt)));
            continue;
          }
          throw error;
        }
        if (attempt < retries) {
          clearTimeout(timeout);
          await new Promise((resolve) => setTimeout(resolve, 100 * (2 ** attempt)));
          continue;
        }
        const aborted = controller.signal.aborted || error?.name === 'AbortError';
        throw new RainSandboxError(
          aborted ? 'RAIN_TIMEOUT' : 'RAIN_NETWORK_ERROR',
          aborted ? 'Rain sandbox request timed out.' : 'Rain sandbox request failed.',
          { retryable: true },
        );
      } finally {
        clearTimeout(timeout);
      }

      if (response.ok) return { payload, status: response.status, headers: response.headers };
      const retryable = response.status === 429 || response.status >= 500;
      if (retryable && attempt < retries) {
        await new Promise((resolve) => setTimeout(resolve, 100 * (2 ** attempt)));
        continue;
      }
      throw new RainSandboxError(
        safeProviderCode(payload, `RAIN_HTTP_${response.status}`),
        `Rain sandbox rejected the request (HTTP ${response.status}).`,
        { providerStatus: response.status, retryable, statusCode: response.status >= 500 ? 502 : 422 },
      );
    }
    throw new RainSandboxError('RAIN_NETWORK_ERROR', 'Rain sandbox request failed.', { retryable: true });
  }

  async health() {
    const query = new URLSearchParams({ userId: this.userId, limit: '1' });
    if (this.teamId) query.set('teamId', this.teamId);
    await this.request(`/issuing/transactions?${query.toString()}`, { retries: 0 });
    return { ok: true, mode: this.mode, authenticated: true };
  }

  async fundCollateral(amountMinor = this.autoFundMinor) {
    if (!Number.isSafeInteger(amountMinor) || amountMinor < 0) {
      throw new RainSandboxError('RAIN_INVALID_REQUEST', 'Collateral amount must be a non-negative integer.', { statusCode: 422 });
    }
    const operationKey = idempotencyKey('rain-collateral-v1', this.contractId, amountMinor);
    const { payload, status } = await this.request('/simulate/collateral/fund', {
      method: 'POST',
      idempotency: operationKey,
      body: { contractId: this.contractId, currency: 'rusd', amount: amountMinor },
    });
    return {
      status: status === 200 || status === 201 || status === 202 ? 'accepted' : 'unknown',
      amountMinor,
      currency: 'rUSD',
      transactionId: payload?.transactionId || null,
      mode: this.mode,
      sandbox: true,
      synthetic: false,
      fundsMoved: false,
      externalEndpoint: true,
    };
  }

  async ensureCollateral() {
    if (this.autoFundMinor === 0) return null;
    if (!this.collateralReady) {
      this.collateralReady = this.fundCollateral(this.autoFundMinor).catch((error) => {
        this.collateralReady = null;
        throw error;
      });
    }
    return this.collateralReady;
  }

  async createScopedCard(policy) {
    if (!policy?.missionId || !policy?.principalId) {
      throw new RainSandboxError('RAIN_INVALID_REQUEST', 'Mission and principal are required.', { statusCode: 422 });
    }
    const currency = String(policy.currency || 'USD').trim().toUpperCase();
    if (currency !== 'USD') {
      throw new RainSandboxError('RAIL_CURRENCY_UNSUPPORTED', 'Rain sandbox scoped cards authorize USD only.', { statusCode: 422 });
    }
    assertPositiveMinor(policy.maximumAmountMinor, 'maximumAmountMinor');
    if (!Number.isSafeInteger(policy.maxTransactions) || policy.maxTransactions <= 0) {
      throw new RainSandboxError('RAIN_INVALID_REQUEST', 'maxTransactions must be positive.', { statusCode: 422 });
    }
    assertStringArray(policy.allowedMerchantIds, 'allowedMerchantIds');
    assertStringArray(policy.allowedMccs, 'allowedMccs');
    if (policy.allowedMccs.some((mcc) => !/^\d{4}$/.test(mcc))) {
      throw new RainSandboxError('RAIN_INVALID_REQUEST', 'Every MCC must contain four digits.', { statusCode: 422 });
    }
    const expiry = new Date(policy.expiresAt);
    if (!Number.isFinite(expiry.getTime()) || expiry.getTime() <= this.clock().getTime()) {
      throw new RainSandboxError('RAIN_INVALID_REQUEST', 'Card expiry must be in the future.', { statusCode: 422 });
    }

    await this.ensureCollateral();
    const sessionId = createSessionId();
    const body = {
      amountInUSDCents: policy.maximumAmountMinor,
      expiresAt: expiry.toISOString(),
      allowedMccs: [...policy.allowedMccs],
    };
    const operationKey = idempotencyKey(
      'rain-scoped-card-v1',
      policy.missionId,
      policy.quoteId || '',
      policy.maximumAmountMinor,
      expiry.toISOString(),
      policy.allowedMccs.join(','),
    );
    const { payload } = await this.request(`/issuing/users/${encodeURIComponent(this.userId)}/cards/scoped`, {
      method: 'POST',
      idempotency: operationKey,
      extraHeaders: { sessionid: sessionId },
      body,
    });
    if (
      !payload ||
      !UUID_PATTERN.test(payload.id) ||
      !/^\d{4}$/.test(payload.last4) ||
      payload.status !== 'active'
    ) {
      throw new RainSandboxError('RAIN_INVALID_RESPONSE', 'Rain returned an invalid scoped-card response.');
    }

    // encryptedPan/encryptedCvc are intentionally never copied, returned, logged,
    // persisted, sent to the browser, or exposed to the orchestrator.
    const card = {
      cardId: payload.id,
      principalId: policy.principalId,
      missionId: policy.missionId,
      state: 'active',
      remoteState: 'active',
      lastFour: payload.last4,
      allowedMerchantIds: Object.freeze([...policy.allowedMerchantIds]),
      allowedMccs: Object.freeze([...policy.allowedMccs]),
      maximumAmountMinor: policy.maximumAmountMinor,
      currency,
      maxTransactions: policy.maxTransactions,
      transactionCount: 0,
      expiresAt: expiry.toISOString(),
      purpose: policy.purpose,
      quoteId: policy.quoteId || null,
      createdAt: this.clock().toISOString(),
      mode: this.mode,
      sandbox: true,
      synthetic: false,
      fundsMoved: false,
      externalEndpoint: true,
      enforcement: {
        amount: 'rain-buffered-plus-application-exact',
        mcc: 'rain-sandbox',
        expiry: 'rain-sandbox',
        merchant: 'application-policy',
        transactionCount: 'application-policy',
        task: 'application-policy',
        retirement: 'application-expiry-scheduled',
      },
    };
    this.cards.set(card.cardId, card);
    return structuredClone(card);
  }

  async authorizePurchase(cardId, purchase = {}) {
    const card = this.cards.get(cardId);
    const checkedAt = this.clock().toISOString();
    const applicationCode = cardDecision(card, purchase, this.clock());
    const exerciseRemoteControl = purchase.exerciseRemoteControl === true &&
      ['MERCHANT_NOT_ALLOWED', 'MCC_NOT_ALLOWED'].includes(applicationCode);

    if (applicationCode !== 'AUTHORIZED' && !exerciseRemoteControl) {
      return {
        transactionId: idempotencyKey('rain-local-denial-v1', cardId, purchase.intentId || '', checkedAt),
        cardId,
        authorized: false,
        status: 'declined',
        code: applicationCode,
        applicationCode,
        merchantId: purchase.merchantId,
        merchantName: purchase.merchantName,
        mcc: purchase.mcc,
        amountMinor: purchase.amountMinor,
        currency: card?.currency || String(purchase.currency || 'USD').toUpperCase(),
        checkedAt,
        mode: this.mode,
        sandbox: true,
        synthetic: false,
        fundsMoved: false,
        externalEndpoint: false,
        remoteAttempted: false,
      };
    }

    const authorizationKey = idempotencyKey(
      'rain-authorization-v1',
      cardId,
      purchase.intentId || '',
      purchase.merchantId || '',
      purchase.mcc || '',
      purchase.amountMinor,
      card.currency,
      purchase.merchantName || '',
    );
    const { payload } = await this.request('/simulate/transactions/authorize', {
      method: 'POST',
      idempotency: authorizationKey,
      body: {
        cardId,
        amount: purchase.amountMinor,
        currency: 'USD',
        merchantName: purchase.merchantName,
        merchantCategoryCode: purchase.mcc,
      },
    });
    if (!payload || !UUID_PATTERN.test(payload.transactionId) || typeof payload.status !== 'string') {
      throw new RainSandboxError('RAIN_INVALID_RESPONSE', 'Rain returned an invalid authorization response.');
    }

    const remoteAuthorized = payload.status === 'authorized' || payload.status === 'settled';
    let finalStatus = payload.status;
    let completionReason = payload.completionReason || null;
    let remoteControlUnexpected = false;

    if (exerciseRemoteControl && remoteAuthorized) {
      remoteControlUnexpected = true;
      const reversal = await this.request(`/simulate/transactions/${encodeURIComponent(payload.transactionId)}/reverse`, {
        method: 'POST',
        idempotency: idempotencyKey('rain-reversal-v1', payload.transactionId),
        body: {},
      });
      if (
        !reversal.payload ||
        reversal.payload.transactionId !== payload.transactionId ||
        reversal.payload.status !== 'reversed'
      ) {
        throw new RainSandboxError('RAIN_INVALID_RESPONSE', 'Rain returned invalid reversal evidence.');
      }
      finalStatus = 'reversed';
    } else if (applicationCode === 'AUTHORIZED' && payload.status === 'authorized' && purchase.settle !== false) {
      const settlement = await this.request(`/simulate/transactions/${encodeURIComponent(payload.transactionId)}/settle`, {
        method: 'POST',
        idempotency: idempotencyKey('rain-settlement-v1', payload.transactionId, purchase.amountMinor),
        // Rain's quickstart shows an empty object, but the current beta
        // validator requires the optional settlement amount to be explicit.
        body: { amount: purchase.amountMinor },
      });
      if (
        !settlement.payload ||
        settlement.payload.transactionId !== payload.transactionId ||
        settlement.payload.status !== 'settled'
      ) {
        throw new RainSandboxError('RAIN_INVALID_RESPONSE', 'Rain returned invalid settlement evidence.');
      }
      finalStatus = settlement.payload.status;
      completionReason = settlement.payload.completionReason || completionReason;
    }

    const authorized = applicationCode === 'AUTHORIZED' && remoteAuthorized;
    if (authorized) card.transactionCount += 1;
    const rainDeclinedReason = payload.declinedReason || null;
    const resultCode = authorized
      ? 'AUTHORIZED'
      : applicationCode === 'AUTHORIZED'
        ? 'RAIN_DECLINED'
        : applicationCode;
    return {
      transactionId: payload.transactionId,
      cardId,
      authorized,
      status: authorized ? finalStatus : 'declined',
      code: resultCode,
      applicationCode,
      rainStatus: payload.status,
      rainDeclinedReason,
      rainControlUnexpected: remoteControlUnexpected,
      completionReason,
      merchantId: purchase.merchantId,
      merchantName: purchase.merchantName,
      mcc: purchase.mcc,
      amountMinor: purchase.amountMinor,
      currency: card.currency,
      checkedAt,
      quoteId: purchase.quoteId || null,
      mode: this.mode,
      sandbox: true,
      synthetic: false,
      fundsMoved: false,
      externalEndpoint: true,
      remoteAttempted: true,
    };
  }

  async retireCard(cardId) {
    const card = this.cards.get(cardId);
    if (!card) throw new RainSandboxError('CARD_NOT_FOUND', 'Scoped card does not exist.', { statusCode: 404 });
    card.state = 'expiry_scheduled';
    card.localAuthorityDisabledAt = this.clock().toISOString();
    return structuredClone(card);
  }

  async getCard(cardId) {
    const local = this.cards.get(cardId);
    if (!local) return null;
    const { payload } = await this.request(`/issuing/cards/${encodeURIComponent(cardId)}`, { retries: 0 });
    if (payload?.status) local.remoteState = payload.status;
    return structuredClone(local);
  }

  restoreCard(card) {
    if (!card || !UUID_PATTERN.test(card.cardId)) {
      throw new RainSandboxError('RAIN_INVALID_RESTORED_CARD', 'Stored Rain card data is invalid.', { statusCode: 500 });
    }
    if (card.mode !== this.mode || String(card.currency || '').toUpperCase() !== 'USD') {
      throw new RainSandboxError('RAIN_INVALID_RESTORED_CARD', 'Stored Rain card currency must be USD.', { statusCode: 500 });
    }
    assertPositiveMinor(card.maximumAmountMinor, 'maximumAmountMinor');
    if (!Number.isSafeInteger(card.maxTransactions) || card.maxTransactions <= 0) {
      throw new RainSandboxError('RAIN_INVALID_RESTORED_CARD', 'Stored Rain transaction limit is invalid.', { statusCode: 500 });
    }
    assertStringArray(card.allowedMerchantIds, 'allowedMerchantIds');
    assertStringArray(card.allowedMccs, 'allowedMccs');
    if (card.allowedMccs.some((mcc) => !/^\d{4}$/.test(mcc))) {
      throw new RainSandboxError('RAIN_INVALID_RESTORED_CARD', 'Stored Rain MCC scope is invalid.', { statusCode: 500 });
    }
    if (!['active', 'expiry_scheduled'].includes(card.state)) {
      throw new RainSandboxError('RAIN_INVALID_RESTORED_CARD', 'Stored Rain card state is invalid.', { statusCode: 500 });
    }
    const expiry = new Date(card.expiresAt);
    // An already-expired card is still restored. It carries no authority —
    // cardDecision() independently returns CARD_EXPIRED for any authorization —
    // but a serverless request must still be able to rehydrate a part-finished
    // mission and retire the card at completion. Only an unparseable expiry,
    // which we cannot prove has passed, fails closed.
    if (!Number.isFinite(expiry.getTime())) {
      throw new RainSandboxError('RAIN_INVALID_RESTORED_CARD', 'Stored Rain card expiry is invalid.', { statusCode: 500 });
    }
    if (
      !Number.isSafeInteger(card.transactionCount) ||
      card.transactionCount < 0 ||
      card.transactionCount > card.maxTransactions
    ) {
      throw new RainSandboxError('RAIN_INVALID_RESTORED_CARD', 'Stored Rain transaction count is invalid.', { statusCode: 500 });
    }
    const restored = {
      ...structuredClone(card),
      currency: 'USD',
      allowedMerchantIds: Object.freeze([...card.allowedMerchantIds]),
      allowedMccs: Object.freeze([...card.allowedMccs]),
      expiresAt: expiry.toISOString(),
    };
    this.cards.set(restored.cardId, restored);
    return structuredClone(restored);
  }
}

module.exports = {
  RainSandboxAdapter,
  RainSandboxError,
  SANDBOX_KEY_FINGERPRINT,
  SANDBOX_SESSION_PUBLIC_KEY,
  createSessionId,
  idempotencyKey,
};
