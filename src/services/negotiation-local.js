'use strict';

const { createQuoteDigest } = require('../domain');
const { localId } = require('../lib/ids');

const DEFAULT_TERMS = Object.freeze({
  purchaseModel: 'one_time',
  service: 'archival_egress',
  autoRenewal: false,
  dataSharing: false,
  exclusivity: false,
});

const ATLAS = Object.freeze({
  merchantId: 'merchant_atlas_archive',
  merchantName: 'Atlas Archive Cloud',
  providerId: 'provider_atlas_archive',
  mcc: '5734',
  initialAmountMinor: 1200,
  floorAmountMinor: 975,
});

class NegotiationError extends Error {
  constructor(code, message, statusCode = 422) {
    super(message);
    this.name = 'NegotiationError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

function positiveMinor(value, field) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new NegotiationError('INVALID_NEGOTIATION_AMOUNT', `${field} must be a positive safe integer.`);
  }
  return value;
}

function requiredString(value, field) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new NegotiationError('INVALID_NEGOTIATION_REQUEST', `${field} is required.`);
  }
  return value.trim();
}

function clone(value) {
  return structuredClone(value);
}

class LocalNegotiationAdapter {
  constructor({ clock = () => new Date() } = {}) {
    this.clock = clock;
    this.sessions = new Map();
    this.sessionByMission = new Map();
    this.idempotentResponses = new Map();
    this.mode = 'local-negotiation';
  }

  reset() {
    this.sessions.clear();
    this.sessionByMission.clear();
    this.idempotentResponses.clear();
  }

  getOffers({ missionId, contentRoot, providerId, requirements = {}, idempotencyKey } = {}) {
    missionId = requiredString(missionId, 'missionId');
    contentRoot = requiredString(contentRoot, 'contentRoot');
    providerId = requiredString(providerId, 'providerId');
    if (providerId !== ATLAS.providerId) {
      throw new NegotiationError('NEGOTIATION_PROVIDER_NOT_SUPPORTED', 'The provider is not available in the local negotiation market.');
    }

    const existingId = this.sessionByMission.get(missionId);
    if (existingId) return this.getSession(existingId);

    const maximumRounds = requirements.maximumRounds === undefined ? 3 : requirements.maximumRounds;
    if (!Number.isSafeInteger(maximumRounds) || maximumRounds < 1 || maximumRounds > 10) {
      throw new NegotiationError('INVALID_NEGOTIATION_POLICY', 'maximumRounds must be between 1 and 10.');
    }
    const maximumAmountMinor = requirements.maximumAmountMinor === undefined
      ? ATLAS.initialAmountMinor
      : positiveMinor(requirements.maximumAmountMinor, 'maximumAmountMinor');
    if (maximumAmountMinor < ATLAS.floorAmountMinor) {
      throw new NegotiationError('NEGOTIATION_CEILING_TOO_LOW', 'The local merchant cannot meet the configured ceiling.');
    }

    const createdAt = this.clock().toISOString();
    const sessionId = localId('negotiation', missionId, contentRoot, createdAt);
    const offerId = localId('offer', sessionId, ATLAS.merchantId, ATLAS.initialAmountMinor);
    const offer = {
      offerId,
      sessionId,
      merchantId: ATLAS.merchantId,
      merchantName: ATLAS.merchantName,
      providerId: ATLAS.providerId,
      mcc: ATLAS.mcc,
      contentRoot,
      purpose: DEFAULT_TERMS.service,
      amountMinor: ATLAS.initialAmountMinor,
      currency: 'USD',
      terms: { ...DEFAULT_TERMS },
      binding: false,
      issuedAt: createdAt,
    };
    const session = {
      sessionId,
      missionId,
      contentRoot,
      providerId,
      status: 'offers_received',
      maximumRounds,
      maximumAmountMinor,
      currentSellerAmountMinor: ATLAS.initialAmountMinor,
      initialAmountMinor: ATLAS.initialAmountMinor,
      offers: [offer],
      rounds: [],
      quote: null,
      createdAt,
      completedAt: null,
      idempotencyKey: idempotencyKey || null,
      mode: this.mode,
    };
    this.sessions.set(sessionId, session);
    this.sessionByMission.set(missionId, sessionId);
    return clone(session);
  }

  sendCounterOffer({ sessionId, offerId, amountMinor, terms, idempotencyKey } = {}) {
    sessionId = requiredString(sessionId, 'sessionId');
    offerId = requiredString(offerId, 'offerId');
    amountMinor = positiveMinor(amountMinor, 'amountMinor');
    if (idempotencyKey && this.idempotentResponses.has(idempotencyKey)) {
      return clone(this.idempotentResponses.get(idempotencyKey));
    }

    const session = this.sessions.get(sessionId);
    if (!session) throw new NegotiationError('NEGOTIATION_SESSION_NOT_FOUND', 'Negotiation session not found.', 404);
    if (!['offers_received', 'countering'].includes(session.status)) {
      throw new NegotiationError('NEGOTIATION_ALREADY_FINAL', 'The negotiation has already reached a final state.', 409);
    }
    if (session.offers[0].offerId !== offerId) {
      throw new NegotiationError('NEGOTIATION_OFFER_MISMATCH', 'The offer does not belong to this session.');
    }
    if (session.rounds.length >= session.maximumRounds) {
      session.status = 'rejected';
      session.completedAt = this.clock().toISOString();
      throw new NegotiationError('NEGOTIATION_ROUNDS_EXCEEDED', 'The maximum negotiation rounds have been used.');
    }
    if (amountMinor > session.maximumAmountMinor || amountMinor >= session.currentSellerAmountMinor) {
      throw new NegotiationError('NON_IMPROVING_COUNTEROFFER', 'The buyer counter must improve on the current seller price.');
    }
    const normalizedTerms = terms === undefined ? { ...DEFAULT_TERMS } : clone(terms);
    if (JSON.stringify(normalizedTerms) !== JSON.stringify(DEFAULT_TERMS)) {
      throw new NegotiationError('NEGOTIATION_TERMS_NOT_SUPPORTED', 'The local merchant only accepts the bounded one-time recovery terms.');
    }

    const roundNumber = session.rounds.length + 1;
    const timestamp = this.clock().toISOString();
    let seller;
    let quote = null;

    if (amountMinor >= ATLAS.floorAmountMinor) {
      const issuedAt = timestamp;
      const expiresAt = new Date(this.clock().getTime() + 15 * 60 * 1000).toISOString();
      quote = {
        quoteId: localId('quote', sessionId, amountMinor, issuedAt),
        sessionId,
        merchantId: ATLAS.merchantId,
        merchantName: ATLAS.merchantName,
        providerId: ATLAS.providerId,
        mcc: ATLAS.mcc,
        contentRoot: session.contentRoot,
        purpose: DEFAULT_TERMS.service,
        amountMinor,
        currency: 'USD',
        terms: { ...DEFAULT_TERMS },
        binding: true,
        issuedAt,
        expiresAt,
      };
      quote.quoteDigest = createQuoteDigest(quote);
      seller = {
        action: 'accept',
        amountMinor,
        quoteId: quote.quoteId,
        reasonCode: 'SELLER_ACCEPTED_BOUNDED_PRICE',
        timestamp,
      };
      session.quote = quote;
      session.status = 'quote_ready';
      session.completedAt = timestamp;
    } else if (roundNumber >= session.maximumRounds) {
      seller = {
        action: 'decline',
        amountMinor: session.currentSellerAmountMinor,
        quoteId: null,
        reasonCode: 'SELLER_FLOOR_NOT_MET',
        timestamp,
      };
      session.status = 'rejected';
      session.completedAt = timestamp;
    } else {
      const sellerAmount = Math.max(
        ATLAS.floorAmountMinor,
        Math.floor((session.currentSellerAmountMinor + amountMinor) / 2),
      );
      seller = {
        action: 'counter',
        amountMinor: sellerAmount,
        quoteId: null,
        reasonCode: 'SELLER_COUNTERED_WITHIN_CEILING',
        timestamp,
      };
      session.currentSellerAmountMinor = sellerAmount;
      session.status = 'countering';
    }

    const round = {
      roundId: localId('round', sessionId, roundNumber, amountMinor, timestamp),
      roundNumber,
      offerId,
      buyer: {
        amountMinor,
        reasonCode: roundNumber === 1 ? 'TARGET_PRICE' : 'BEST_WITHIN_POLICY',
        terms: { ...DEFAULT_TERMS },
        timestamp,
      },
      seller,
    };
    session.rounds.push(round);

    const response = { session: clone(session), round: clone(round), quote: quote ? clone(quote) : null };
    if (idempotencyKey) this.idempotentResponses.set(idempotencyKey, response);
    return clone(response);
  }

  getBindingQuote({ sessionId, quoteId } = {}) {
    sessionId = requiredString(sessionId, 'sessionId');
    quoteId = requiredString(quoteId, 'quoteId');
    const session = this.sessions.get(sessionId);
    if (!session) throw new NegotiationError('NEGOTIATION_SESSION_NOT_FOUND', 'Negotiation session not found.', 404);
    if (!session.quote || session.quote.quoteId !== quoteId) {
      throw new NegotiationError('NEGOTIATION_QUOTE_NOT_FOUND', 'Binding quote not found.', 404);
    }
    if (this.clock().getTime() >= new Date(session.quote.expiresAt).getTime()) {
      session.status = 'expired';
      throw new NegotiationError('QUOTE_EXPIRED', 'Binding quote has expired.');
    }
    return clone(session.quote);
  }

  getSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) throw new NegotiationError('NEGOTIATION_SESSION_NOT_FOUND', 'Negotiation session not found.', 404);
    return clone(session);
  }
}

module.exports = {
  ATLAS,
  DEFAULT_TERMS,
  LocalNegotiationAdapter,
  NegotiationError,
};
