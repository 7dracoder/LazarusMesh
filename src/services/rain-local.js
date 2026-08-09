const { localId } = require("../lib/ids");

function isNonemptyStringArray(value) {
  return Array.isArray(value) && value.length > 0 && value.every(
    (item) => typeof item === "string" && item.trim().length > 0,
  );
}

class RainPolicyError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "RainPolicyError";
    this.code = code;
  }
}

class LocalRainAdapter {
  constructor({ clock = () => new Date() } = {}) {
    this.clock = clock;
    this.cards = new Map();
  }

  reset() {
    this.cards.clear();
  }

  createScopedCard(policy) {
    if (!policy?.missionId || !policy?.principalId) {
      throw new RainPolicyError("INVALID_POLICY", "Mission and principal are required.");
    }
    if (!Number.isSafeInteger(policy.maximumAmountMinor) || policy.maximumAmountMinor <= 0) {
      throw new RainPolicyError("INVALID_POLICY", "Maximum amount must be positive integer minor units.");
    }
    if (!Number.isSafeInteger(policy.maxTransactions) || policy.maxTransactions <= 0) {
      throw new RainPolicyError("INVALID_POLICY", "Maximum transaction count must be positive.");
    }
    if (!isNonemptyStringArray(policy.allowedMerchantIds)) {
      throw new RainPolicyError("INVALID_POLICY", "At least one merchant must be scoped.");
    }
    if (!isNonemptyStringArray(policy.allowedMccs)) {
      throw new RainPolicyError("INVALID_POLICY", "At least one MCC must be scoped.");
    }
    const expiresAt = new Date(policy.expiresAt).getTime();
    if (!Number.isFinite(expiresAt) || expiresAt <= this.clock().getTime()) {
      throw new RainPolicyError("INVALID_POLICY", "Card expiry must be a valid future instant.");
    }

    const createdAt = this.clock().toISOString();
    const cardId = localId("rain_card", policy.missionId, createdAt, this.cards.size);
    const card = {
      cardId,
      principalId: policy.principalId,
      missionId: policy.missionId,
      state: "active",
      lastFour: String(4200 + this.cards.size).slice(-4),
      allowedMerchantIds: Object.freeze([...policy.allowedMerchantIds]),
      allowedMccs: Object.freeze([...policy.allowedMccs]),
      maximumAmountMinor: policy.maximumAmountMinor,
      maxTransactions: policy.maxTransactions,
      transactionCount: 0,
      expiresAt: policy.expiresAt,
      purpose: policy.purpose,
      quoteId: policy.quoteId || null,
      createdAt,
      mode: "local",
      enforcement: {
        amount: "local-policy-exact",
        mcc: "local-policy",
        expiry: "local-policy",
        merchant: "local-policy",
        transactionCount: "local-policy",
        task: "local-policy",
        retirement: "local-policy",
      },
    };
    this.cards.set(cardId, card);
    return structuredClone(card);
  }

  authorizePurchase(cardId, purchase) {
    const card = this.cards.get(cardId);
    const purchaseIntent = purchase && typeof purchase === "object" ? purchase : {};
    const checkedAt = this.clock().toISOString();
    let code = "AUTHORIZED";

    if (!card) code = "CARD_NOT_FOUND";
    else if (card.state !== "active") code = "CARD_INACTIVE";
    else if (!Number.isSafeInteger(purchaseIntent.amountMinor) || purchaseIntent.amountMinor <= 0) code = "INVALID_AMOUNT";
    else if (new Date(card.expiresAt).getTime() <= this.clock().getTime()) code = "CARD_EXPIRED";
    else if (card.transactionCount >= card.maxTransactions) code = "TRANSACTION_COUNT_EXCEEDED";
    else if (purchaseIntent.amountMinor > card.maximumAmountMinor) code = "AMOUNT_LIMIT_EXCEEDED";
    else if (!card.allowedMerchantIds.includes(purchaseIntent.merchantId)) {
      code = "MERCHANT_NOT_ALLOWED";
    } else if (!card.allowedMccs.includes(purchaseIntent.mcc)) {
      code = "MCC_NOT_ALLOWED";
    }

    const authorized = code === "AUTHORIZED";
    if (authorized) card.transactionCount += 1;

    return {
      transactionId: localId("rain_tx", cardId, purchaseIntent.merchantId, purchaseIntent.amountMinor, checkedAt),
      cardId,
      authorized,
      status: authorized && purchaseIntent.settle !== false ? "settled" : authorized ? "authorized" : "declined",
      code,
      merchantId: purchaseIntent.merchantId,
      merchantName: purchaseIntent.merchantName,
      mcc: purchaseIntent.mcc,
      amountMinor: purchaseIntent.amountMinor,
      currency: purchaseIntent.currency || "USD",
      checkedAt,
      quoteId: purchaseIntent.quoteId || null,
      mode: "local",
    };
  }

  retireCard(cardId) {
    const card = this.cards.get(cardId);
    if (!card) throw new RainPolicyError("CARD_NOT_FOUND", "Scoped card does not exist.");
    card.state = "retired";
    card.retiredAt = this.clock().toISOString();
    return structuredClone(card);
  }

  getCard(cardId) {
    const card = this.cards.get(cardId);
    return card ? structuredClone(card) : null;
  }

  restoreCard(card) {
    if (!card || typeof card.cardId !== "string" || !card.cardId) {
      throw new RainPolicyError("INVALID_RESTORED_CARD", "Stored card data is invalid.");
    }
    if (!isNonemptyStringArray(card.allowedMerchantIds) || !isNonemptyStringArray(card.allowedMccs)) {
      throw new RainPolicyError("INVALID_RESTORED_CARD", "Stored card scope is invalid.");
    }
    if (!Number.isSafeInteger(card.maximumAmountMinor) || card.maximumAmountMinor <= 0) {
      throw new RainPolicyError("INVALID_RESTORED_CARD", "Stored card limit is invalid.");
    }
    if (!Number.isSafeInteger(card.maxTransactions) || card.maxTransactions <= 0) {
      throw new RainPolicyError("INVALID_RESTORED_CARD", "Stored transaction count limit is invalid.");
    }
    this.cards.set(card.cardId, structuredClone({
      ...card,
      allowedMerchantIds: Object.freeze([...card.allowedMerchantIds]),
      allowedMccs: Object.freeze([...card.allowedMccs]),
      transactionCount: Math.min(
        card.maxTransactions,
        Math.max(0, Number.isSafeInteger(card.transactionCount) ? card.transactionCount : 0),
      ),
    }));
    return this.getCard(card.cardId);
  }
}

module.exports = { LocalRainAdapter, RainPolicyError };
