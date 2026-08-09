const { localId, localTxHash } = require("../lib/ids");
const { fromAccountingMinorUp, normalizeCurrency } = require("../domain/currency");

const MONAD_USDC_TESTNET = "0x534b2f3A21130d7a60830c2Df862319e593943A3";
const DISCOVERY_USD_MINOR = 1;
const DISCOVERY_USDC_ATOMIC = "10000";

class LocalX402Adapter {
  constructor({ clock = () => new Date() } = {}) {
    this.clock = clock;
    this.mode = "local";
    this.receipts = new Map();
  }

  reset() {
    this.receipts.clear();
  }

  requestAvailability(contentRoot, { budgetCurrency = "USD" } = {}) {
    if (typeof contentRoot !== "string" || contentRoot.trim().length === 0) {
      throw new Error("INVALID_CONTENT_ROOT");
    }
    const currency = normalizeCurrency(budgetCurrency);
    if (!currency) throw new Error("CURRENCY_NOT_SUPPORTED");
    return {
      status: 402,
      headers: {
        "PAYMENT-REQUIRED": Buffer.from(
          JSON.stringify({
            scheme: "exact",
            network: "eip155:10143",
            asset: MONAD_USDC_TESTNET,
            assetSymbol: "USDC",
            assetDecimals: 6,
            amountAtomic: DISCOVERY_USDC_ATOMIC,
            budgetImpactMinor: fromAccountingMinorUp(DISCOVERY_USD_MINOR, currency),
            budgetCurrency: currency,
            resource: `/availability/${contentRoot}`,
          }),
        ).toString("base64url"),
      },
    };
  }

  settleAvailability({ missionId, contentRoot, payer, budgetCurrency = "USD" }) {
    if (
      typeof missionId !== "string" || missionId.trim().length === 0 ||
      typeof contentRoot !== "string" || contentRoot.trim().length === 0 ||
      typeof payer !== "string" || payer.trim().length === 0
    ) {
      throw new Error("INVALID_X402_PAYMENT");
    }
    const currency = normalizeCurrency(budgetCurrency);
    if (!currency) throw new Error("CURRENCY_NOT_SUPPORTED");
    const receiptId = localId("x402", missionId, contentRoot, currency);
    const existing = this.receipts.get(receiptId);
    if (existing) return structuredClone(existing);
    const timestamp = this.clock().toISOString();
    const receipt = {
      receiptId,
      missionId,
      payer,
      payee: "Lazarus Availability Oracle",
      amountMinor: fromAccountingMinorUp(DISCOVERY_USD_MINOR, currency),
      currency,
      budgetImpactMinor: fromAccountingMinorUp(DISCOVERY_USD_MINOR, currency),
      settlementAsset: {
        symbol: "USDC",
        address: MONAD_USDC_TESTNET,
        decimals: 6,
        amountAtomic: DISCOVERY_USDC_ATOMIC,
      },
      network: "eip155:10143",
      transactionHash: localTxHash("x402", missionId, contentRoot, timestamp),
      status: "settled",
      synthetic: true,
      fundsMoved: false,
      externalEndpoint: false,
      timestamp,
      paymentResponse: {
        candidateProviders: 1,
        recommendedProvider: "provider_atlas_archive",
        estimatedRecoverySeconds: 45,
        estimatedCostMinor: fromAccountingMinorUp(1200, currency),
        estimatedCostCurrency: currency,
        confidence: 0.94,
      },
      mode: "local",
    };
    this.receipts.set(receipt.receiptId, receipt);
    return structuredClone(receipt);
  }
}

module.exports = { LocalX402Adapter };
