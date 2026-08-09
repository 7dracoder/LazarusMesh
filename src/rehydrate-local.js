"use strict";

function integer(value, fallback = 0) {
  return Number.isSafeInteger(value) ? value : fallback;
}

const RECOVERY_STATE_LAST_REQUIRED_STEP = 6;

function persistedStateError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function canonicalStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalStringify(value[key])}`).join(",")}}`;
}

function assertManifestMatches(mission, expectedManifest) {
  const stored = mission?.manifest;
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) {
    throw persistedStateError(
      "PERSISTED_STATE_MANIFEST_MISMATCH",
      "Stored mission is missing its pinned recovery manifest.",
    );
  }
  const fields = ["name", "license", "totalBytes", "totalPieces", "contentSha256", "contentRoot"];
  const mismatch = fields.some((field) => (
    expectedManifest[field] !== undefined && stored[field] !== expectedManifest[field]
  ));
  const piecesMismatch = Array.isArray(expectedManifest.pieces)
    && canonicalStringify(stored.pieces) !== canonicalStringify(expectedManifest.pieces);
  if (mismatch || piecesMismatch || expectedManifest.contentRoot !== mission.contentRoot) {
    throw persistedStateError(
      "PERSISTED_STATE_MANIFEST_MISMATCH",
      "Stored mission manifest does not match the recovery adapter's pinned artifact.",
    );
  }
}

function assertRecoveryModeMatches(mission, recovery) {
  const remote = recovery.networkedProviders === true;
  const storedExternal = mission.provider?.actorMode === "external"
    || mission.provider?.externalEndpoint === true;
  const storedLocal = mission.provider?.actorMode === "simulated"
    || mission.provider?.externalEndpoint === false;
  if ((remote && storedLocal) || (!remote && storedExternal)) {
    throw persistedStateError(
      "PERSISTED_STATE_RECOVERY_MODE_MISMATCH",
      "Stored mission recovery mode does not match the configured recovery adapter.",
    );
  }
  if (
    remote
    && recovery.provider?.providerId
    && mission.provider?.id !== recovery.provider.providerId
  ) {
    throw persistedStateError(
      "PERSISTED_STATE_RECOVERY_MODE_MISMATCH",
      "Stored mission provider does not match the configured remote recovery provider.",
    );
  }
}

function shouldRestoreRecoverySession(mission, {
  targetMissionId,
  restoreTargetRecovery,
  scoped,
}) {
  if (scoped && mission.id !== targetMissionId) return false;
  if (scoped && restoreTargetRecovery !== true) return false;
  return integer(mission.stepIndex) <= RECOVERY_STATE_LAST_REQUIRED_STEP;
}

function restoreNegotiationBindings(state, negotiation) {
  if (negotiation.liveMerchantApi !== true) return;
  if (typeof negotiation.bindSession !== "function") {
    throw persistedStateError(
      "PERSISTED_STATE_NEGOTIATION_RECONCILIATION_UNAVAILABLE",
      "The remote negotiation adapter cannot restore persisted mission bindings.",
    );
  }
  for (const mission of state.missions || []) {
    const storedSessionId = mission.negotiation?.sessionId;
    const quoteSessionId = mission.negotiation?.acceptedQuote?.sessionId;
    if (
      storedSessionId !== undefined
      && storedSessionId !== null
      && quoteSessionId !== undefined
      && quoteSessionId !== null
      && storedSessionId !== quoteSessionId
    ) {
      throw persistedStateError(
        "PERSISTED_STATE_NEGOTIATION_SESSION_MISMATCH",
        "Stored negotiation and quote session identifiers do not match.",
      );
    }
    const sessionId = storedSessionId || quoteSessionId;
    if (sessionId) negotiation.bindSession(mission.id, sessionId, mission.deadline);
  }
}

/**
 * Rebuild request-local adapter state from the durable public audit snapshot.
 * Local adapters reconstruct deterministically. A configured remote recovery
 * adapter re-fetches only the already-recorded piece prefix and verifies it
 * against the sponsor-pinned manifest before a mutation continues. Live
 * payment providers still require their own durable reconciliation layer.
 */
async function rehydrateLocalAdapters(state, adapters, options = {}) {
  const { rain, monad, x402, negotiation, recovery } = adapters;
  const scoped = Object.hasOwn(options, "targetMissionId");
  const targetMissionId = scoped ? options.targetMissionId : null;
  const restoreTargetRecovery = scoped ? options.restoreTargetRecovery !== false : true;
  if (scoped && (typeof targetMissionId !== "string" || !targetMissionId)) {
    throw new TypeError("targetMissionId must be a non-empty string when rehydration is scoped.");
  }
  await Promise.all([rain.reset(), monad.reset(), x402.reset(), negotiation.reset(), recovery.reset()]);
  restoreNegotiationBindings(state, negotiation);

  for (const mission of state.missions || []) {
    const manifest = recovery.buildManifest(integer(mission.manifest?.totalPieces, 24));
    assertManifestMatches(mission, manifest);
    assertRecoveryModeMatches(mission, recovery);
    const recovered = integer(mission.pieces?.recovered);
    const verified = integer(mission.pieces?.verified);
    if (recovered < 0 || verified < 0 || verified > recovered || recovered > manifest.totalPieces) {
      throw persistedStateError(
        "PERSISTED_STATE_RECOVERY_MISMATCH",
        "Stored recovery state has invalid recovered or verified counts.",
      );
    }
    if (shouldRestoreRecoverySession(mission, {
      targetMissionId,
      restoreTargetRecovery,
      scoped,
    })) {
      await recovery.start(mission.id, manifest);
      if (recovered > 0) await recovery.recoverThrough(mission.id, recovered);
      if (verified > 0) await recovery.verifyAll(mission.id);
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
