const { localId, localTxHash } = require("../lib/ids");

class LocalX402Adapter {
  constructor({ clock = () => new Date() } = {}) {
    this.clock = clock;
    this.receipts = new Map();
  }

  reset() {
    this.receipts.clear();
  }

  requestAvailability(contentRoot) {
    if (typeof contentRoot !== "string" || contentRoot.trim().length === 0) {
      throw new Error("INVALID_CONTENT_ROOT");
    }
    return {
      status: 402,
      headers: {
        "PAYMENT-REQUIRED": Buffer.from(
          JSON.stringify({
            scheme: "exact",
            network: "eip155:10143",
            asset: "USDC",
            amountMinor: 1,
            resource: `/availability/${contentRoot}`,
          }),
        ).toString("base64url"),
      },
    };
  }

  settleAvailability({ missionId, contentRoot, payer }) {
    if (
      typeof missionId !== "string" || missionId.trim().length === 0 ||
      typeof contentRoot !== "string" || contentRoot.trim().length === 0 ||
      typeof payer !== "string" || payer.trim().length === 0
    ) {
      throw new Error("INVALID_X402_PAYMENT");
    }
    const receiptId = localId("x402", missionId, contentRoot);
    const existing = this.receipts.get(receiptId);
    if (existing) return structuredClone(existing);
    const timestamp = this.clock().toISOString();
    const receipt = {
      receiptId,
      missionId,
      payer,
      payee: "Lazarus Availability Oracle",
      amountMinor: 1,
      currency: "USDC",
      network: "eip155:10143",
      transactionHash: localTxHash("x402", missionId, contentRoot, timestamp),
      status: "settled",
      timestamp,
      paymentResponse: {
        candidateProviders: 2,
        recommendedProvider: "provider_atlas_archive",
        estimatedRecoverySeconds: 45,
        estimatedCostMinor: 1200,
        confidence: 0.94,
      },
      mode: "local",
    };
    this.receipts.set(receipt.receiptId, receipt);
    return structuredClone(receipt);
  }
}

module.exports = { LocalX402Adapter };
