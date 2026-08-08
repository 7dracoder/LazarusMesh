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

class RainSandboxAdapter {
  constructor({
    baseUrl,
    apiKey,
    userId,
    teamId = null,
    contractId,
    autoFundMinor = 2000,
    timeoutMs = 12_000,
    fetchImpl = globalThis.fetch,
    clock = () => new Date(),
  } = {}) {
    if (typeof baseUrl !== 'string' || !baseUrl.startsWith('https://')) {
      throw new RainSandboxError('RAIN_INVALID_CONFIGURATION', 'Rain sandbox base URL must use HTTPS.', { statusCode: 500 });
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
    this.baseOrigin = new URL(this.baseUrl).origin;
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
      } catch (error) {
        clearTimeout(timeout);
        if (error instanceof RainSandboxError) throw error;
        if (attempt < retries) {
          await new Promise((resolve) => setTimeout(resolve, 100 * (2 ** attempt)));
          continue;
        }
        const aborted = error?.name === 'AbortError';
        throw new RainSandboxError(
          aborted ? 'RAIN_TIMEOUT' : 'RAIN_NETWORK_ERROR',
          aborted ? 'Rain sandbox request timed out.' : 'Rain sandbox request failed.',
          { retryable: true },
        );
      } finally {
        clearTimeout(timeout);
      }

      let payload = null;
      try {
        const text = await response.text();
        payload = text ? JSON.parse(text) : null;
      } catch {
        payload = null;
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
    if (!payload || !UUID_PATTERN.test(payload.id) || typeof payload.last4 !== 'string') {
      throw new RainSandboxError('RAIN_INVALID_RESPONSE', 'Rain returned an invalid scoped-card response.');
    }

    // encryptedPan/encryptedCvc are intentionally never copied, returned, logged,
    // persisted, sent to the browser, or exposed to the orchestrator.
    const card = {
      cardId: payload.id,
      principalId: policy.principalId,
      missionId: policy.missionId,
      state: payload.status === 'active' ? 'active' : String(payload.status || 'active'),
      remoteState: String(payload.status || 'active'),
      lastFour: payload.last4,
      allowedMerchantIds: Object.freeze([...policy.allowedMerchantIds]),
      allowedMccs: Object.freeze([...policy.allowedMccs]),
      maximumAmountMinor: policy.maximumAmountMinor,
      maxTransactions: policy.maxTransactions,
      transactionCount: 0,
      expiresAt: expiry.toISOString(),
      purpose: policy.purpose,
      quoteId: policy.quoteId || null,
      createdAt: this.clock().toISOString(),
      mode: this.mode,
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
        currency: purchase.currency || 'USD',
        checkedAt,
        mode: this.mode,
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
    );
    const { payload } = await this.request('/simulate/transactions/authorize', {
      method: 'POST',
      idempotency: authorizationKey,
      body: {
        cardId,
        amount: purchase.amountMinor,
        currency: purchase.currency || 'USD',
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
      await this.request(`/simulate/transactions/${encodeURIComponent(payload.transactionId)}/reverse`, {
        method: 'POST',
        idempotency: idempotencyKey('rain-reversal-v1', payload.transactionId),
        body: {},
      });
      finalStatus = 'reversed';
    } else if (applicationCode === 'AUTHORIZED' && payload.status === 'authorized' && purchase.settle !== false) {
      const settlement = await this.request(`/simulate/transactions/${encodeURIComponent(payload.transactionId)}/settle`, {
        method: 'POST',
        idempotency: idempotencyKey('rain-settlement-v1', payload.transactionId, purchase.amountMinor),
        // Rain's quickstart shows an empty object, but the current beta
        // validator requires the optional settlement amount to be explicit.
        body: { amount: purchase.amountMinor },
      });
      finalStatus = settlement.payload?.status || 'settled';
      completionReason = settlement.payload?.completionReason || completionReason;
    }

    const authorized = applicationCode === 'AUTHORIZED' && remoteAuthorized;
    if (authorized) card.transactionCount += 1;
    const rainDeclinedReason = payload.declinedReason || null;
    return {
      transactionId: payload.transactionId,
      cardId,
      authorized,
      status: authorized ? finalStatus : 'declined',
      code: authorized ? 'AUTHORIZED' : applicationCode,
      applicationCode,
      rainStatus: payload.status,
      rainDeclinedReason,
      rainControlUnexpected: remoteControlUnexpected,
      completionReason,
      merchantId: purchase.merchantId,
      merchantName: purchase.merchantName,
      mcc: purchase.mcc,
      amountMinor: purchase.amountMinor,
      currency: purchase.currency || 'USD',
      checkedAt,
      quoteId: purchase.quoteId || null,
      mode: this.mode,
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
}

module.exports = {
  RainSandboxAdapter,
  RainSandboxError,
  SANDBOX_KEY_FINGERPRINT,
  SANDBOX_SESSION_PUBLIC_KEY,
  createSessionId,
  idempotencyKey,
};
