"use strict";

function integer(value, fallback = 0) {
  return Number.isSafeInteger(value) ? value : fallback;
}

/**
 * The demo adapters deliberately keep their ledgers in memory. On a Vercel
 * request, rebuild those deterministic ledgers from the durable public audit
 * state before continuing a step. This is only valid for local adapters; live
 * payment providers require their own durable operation/reconciliation layer.
 */
async function rehydrateLocalAdapters(state, adapters) {
  const { rain, monad, x402, negotiation, recovery } = adapters;
  await Promise.all([rain.reset(), monad.reset(), x402.reset(), negotiation.reset(), recovery.reset()]);

  for (const mission of state.missions || []) {
    const manifest = recovery.buildManifest(integer(mission.manifest?.totalPieces, 24));
    if (manifest.contentRoot !== mission.contentRoot) {
      const error = new Error("Stored mission content root does not match the verified fixture.");
      error.code = "PERSISTED_STATE_MANIFEST_MISMATCH";
      throw error;
    }
    recovery.start(mission.id, manifest);
    const recovered = integer(mission.pieces?.recovered);
    const verified = integer(mission.pieces?.verified);
    if (recovered > 0) recovery.recoverThrough(mission.id, recovered);
    if (verified > 0) {
      if (verified !== recovered) {
        const error = new Error("Stored recovery state has an invalid verification count.");
        error.code = "PERSISTED_STATE_RECOVERY_MISMATCH";
        throw error;
      }
      recovery.verifyAll(mission.id);
    }

    const x402Receipts = (mission.payments || []).filter((payment) => (
      payment?.mode === "monad-testnet"
    ));
    const localX402Receipts = (mission.payments || []).filter((payment) => (
      payment?.mode === "local" && payment?.network === "eip155:10143"
    ));
    const pendingX402 = mission.externalOperations?.x402Pending;
    if (pendingX402 && x402.mode !== "monad-testnet") {
      const error = new Error("Stored mission has an unresolved Monad x402 payment prepared by another adapter mode.");
      error.code = "PERSISTED_STATE_X402_MODE_MISMATCH";
      throw error;
    }
    if (
      integer(mission.stepIndex) < 9 &&
      x402.mode === "local" &&
      x402Receipts.length > 0
    ) {
      const error = new Error("Stored mission x402 settlement belongs to the Monad testnet adapter.");
      error.code = "PERSISTED_STATE_X402_MODE_MISMATCH";
      throw error;
    }
    if (
      integer(mission.stepIndex) < 9 &&
      x402.mode === "monad-testnet" &&
      localX402Receipts.length > 0
    ) {
      const error = new Error("Stored mission x402 receipt belongs to the local simulation adapter.");
      error.code = "PERSISTED_STATE_X402_MODE_MISMATCH";
      throw error;
    }
    if (x402.mode === "monad-testnet") {
      if (typeof x402.restoreReceipts !== "function") {
        const error = new Error("The live x402 adapter cannot restore persisted receipts.");
        error.code = "X402_RECONCILIATION_UNAVAILABLE";
        throw error;
      }
      if (pendingX402) {
        if (x402Receipts.length > 0 || typeof x402.restorePendingPayment !== "function") {
          const error = new Error("Stored Monad x402 reconciliation state is inconsistent.");
          error.code = "X402_RECONCILIATION_UNAVAILABLE";
          throw error;
        }
        x402.restorePendingPayment(pendingX402);
      }
      x402.restoreReceipts(x402Receipts);
      if (
        integer(mission.stepIndex) < 9 &&
        integer(mission.stepIndex) >= 1 &&
        x402Receipts.length !== 1
      ) {
        const error = new Error("Stored mission is missing its unique confirmed Monad x402 receipt.");
        error.code = "PERSISTED_STATE_X402_RECEIPT_MISSING";
        throw error;
      }
    } else if (integer(mission.stepIndex) >= 1) {
      x402.settleAvailability({
        missionId: mission.id,
        contentRoot: mission.contentRoot,
        payer: mission.principal.id,
        budgetCurrency: mission.budget.currency || "USD",
      });
    }

    if (integer(mission.stepIndex) >= 2) {
      monad.createBounty({
        missionId: mission.id,
        sponsor: mission.principal.id,
        contentRoot: mission.contentRoot,
        rewardMinor: mission.budget.rewardMinor,
        stakeMinor: mission.budget.stakeMinor,
        currency: mission.budget.currency || "USD",
      });
    }
    if (integer(mission.stepIndex) >= 3) {
      monad.claimBounty(mission.id, mission.provider.id);
    }
    if (integer(mission.stepIndex) >= 7) {
      monad.recordAttestations(mission.id, mission.verifiers.slice(0, 2).map((verifier) => ({
        verifierId: verifier.id,
        result: "pass",
      })));
      const releasedMinor = integer(mission.budget.releasedMinor);
      const rewardMinor = integer(mission.budget.rewardMinor);
      if (releasedMinor >= Math.floor((rewardMinor * 70) / 100)) {
        monad.releaseTranche(mission.id, 70, "recovery");
      }
      if (releasedMinor >= Math.floor((rewardMinor * 90) / 100)) {
        monad.releaseTranche(mission.id, 90, "availability");
      }
      if (releasedMinor >= rewardMinor) monad.releaseTranche(mission.id, 100, "replication");
    }

    if (
      mission.rainCard?.cardId &&
      mission.rainCard.mode !== rain.mode &&
      integer(mission.stepIndex) < 9
    ) {
      const error = new Error("Stored mission card authority belongs to a different Rain adapter mode.");
      error.code = "PERSISTED_STATE_RAIN_MODE_MISMATCH";
      throw error;
    }

    if (
      mission.rainCard?.cardId &&
      mission.rainCard.mode === rain.mode &&
      integer(mission.stepIndex) < 9 &&
      typeof rain.restoreCard === "function"
    ) {
      const settledCount = (mission.payments || []).filter((payment) => (
        payment.cardId === mission.rainCard.cardId && payment.authorized === true
      )).length;
      rain.restoreCard({
        ...mission.rainCard,
        transactionCount: Math.max(integer(mission.rainCard.transactionCount), settledCount),
      });
    }
  }
}

module.exports = { rehydrateLocalAdapters };
