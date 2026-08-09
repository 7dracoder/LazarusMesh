const { localId, localTxHash } = require("../lib/ids");
const { normalizeCurrency, toAccountingMinorUp } = require("../domain/currency");

const MONAD_USDC_TESTNET = "0x534b2f3A21130d7a60830c2Df862319e593943A3";

function simulatedUsdcAtomic(amountMinor, currency) {
  const usdMinor = toAccountingMinorUp(amountMinor, currency);
  return BigInt(usdMinor) * 10_000n;
}

function simulatedUsdcSettlementAtomic(amountAtomic) {
  return {
    symbol: "USDC",
    address: MONAD_USDC_TESTNET,
    decimals: 6,
    amountAtomic: BigInt(amountAtomic).toString(),
    mode: "synthetic-reference",
  };
}

class LocalMonadAdapter {
  constructor({ clock = () => new Date() } = {}) {
    this.clock = clock;
    this.mode = "local";
    this.sequence = 0;
    this.bounties = new Map();
  }

  reset() {
    this.sequence = 0;
    this.bounties.clear();
  }

  receipt(operation, missionId, details = {}) {
    this.sequence += 1;
    const timestamp = this.clock().toISOString();
    return {
      operation,
      missionId,
      chainId: 10143,
      network: "local-monad-simulation",
      blockNumber: 9_000_000 + this.sequence,
      transactionHash: localTxHash(operation, missionId, this.sequence, timestamp),
      timestamp,
      confirmed: true,
      synthetic: true,
      fundsMoved: false,
      chainWrite: false,
      ...details,
    };
  }

  createBounty({ missionId, sponsor, contentRoot, rewardMinor, stakeMinor, currency = "USD" }) {
    const normalizedCurrency = normalizeCurrency(currency);
    if (
      typeof missionId !== "string" || missionId.length === 0 ||
      typeof sponsor !== "string" || sponsor.length === 0 ||
      typeof contentRoot !== "string" || contentRoot.length === 0 ||
      !Number.isSafeInteger(rewardMinor) || rewardMinor <= 0 ||
      !Number.isSafeInteger(stakeMinor) || stakeMinor <= 0 ||
      !normalizedCurrency
    ) {
      throw new Error("INVALID_BOUNTY_PARAMETERS");
    }
    if (this.bounties.has(missionId)) throw new Error("BOUNTY_ALREADY_EXISTS");
    const bounty = {
      bountyId: localId("bounty", missionId, contentRoot),
      missionId,
      sponsor,
      provider: null,
      contentRoot,
      rewardMinor,
      stakeMinor,
      currency: normalizedCurrency,
      releasedMinor: 0,
      settlementAmountAtomic: simulatedUsdcAtomic(rewardMinor, normalizedCurrency),
      releasedSettlementAtomic: 0n,
      status: "Open",
      attestations: [],
    };
    this.bounties.set(missionId, bounty);
    return this.receipt("createBounty", missionId, {
      bountyId: bounty.bountyId,
      amountMinor: rewardMinor,
      currency: bounty.currency,
      settlementAsset: simulatedUsdcSettlementAtomic(bounty.settlementAmountAtomic),
    });
  }

  claimBounty(missionId, provider) {
    const bounty = this.requireBounty(missionId);
    if (bounty.status !== "Open") throw new Error("BOUNTY_NOT_OPEN");
    if (typeof provider !== "string" || provider.trim().length === 0) {
      throw new Error("INVALID_PROVIDER");
    }
    bounty.provider = provider;
    bounty.status = "Claimed";
    return this.receipt("claimBounty", missionId, {
      provider,
      stakeMinor: bounty.stakeMinor,
      currency: bounty.currency,
      collateralAsset: {
        symbol: "MON",
        decimals: 18,
        amountAtomic: null,
        mode: "local-reference-only",
      },
    });
  }

  recordAttestations(missionId, attestations, quorum = 2) {
    const bounty = this.requireBounty(missionId);
    if (
      bounty.status !== "Claimed" ||
      !Array.isArray(attestations) || attestations.length === 0 || attestations.length > 32 ||
      !Number.isSafeInteger(quorum) || quorum < 2 || quorum > 32 ||
      attestations.some((item) => (
        !item || typeof item.verifierId !== "string" || item.verifierId.trim().length === 0 ||
        !["pass", "fail"].includes(item.result)
      ))
    ) {
      throw new Error("INVALID_ATTESTATIONS");
    }
    const uniquePassing = new Map(
      attestations.filter((item) => item.result === "pass").map((item) => [item.verifierId, item]),
    );
    if (uniquePassing.size < quorum) throw new Error("VERIFIER_QUORUM_NOT_REACHED");
    bounty.attestations = [...uniquePassing.values()];
    bounty.status = "Recovered";
    return this.receipt("recordAttestations", missionId, {
      currency: bounty.currency,
      quorum: uniquePassing.size,
      attestationDigest: localTxHash(JSON.stringify(bounty.attestations)),
    });
  }

  releaseTranche(missionId, percentage, label) {
    const bounty = this.requireBounty(missionId);
    if (!Number.isSafeInteger(percentage) || percentage < 1 || percentage > 100) {
      throw new Error("INVALID_RELEASE_PERCENTAGE");
    }
    if (!["Recovered", "Retaining"].includes(bounty.status)) throw new Error("BOUNTY_NOT_RELEASABLE");
    const targetReleased = Number(
      (BigInt(bounty.rewardMinor) * BigInt(percentage)) / 100n,
    );
    if (targetReleased <= bounty.releasedMinor || targetReleased > bounty.rewardMinor) {
      throw new Error("INVALID_RELEASE_PERCENTAGE");
    }
    const amountMinor = Math.max(0, targetReleased - bounty.releasedMinor);
    const targetSettlementAtomic = percentage === 100
      ? bounty.settlementAmountAtomic
      : (bounty.settlementAmountAtomic * BigInt(percentage)) / 100n;
    const amountSettlementAtomic = targetSettlementAtomic - bounty.releasedSettlementAtomic;
    if (amountSettlementAtomic < 0n) throw new Error("INVALID_RELEASE_PERCENTAGE");
    bounty.releasedMinor += amountMinor;
    bounty.releasedSettlementAtomic = targetSettlementAtomic;
    bounty.status = percentage >= 100 ? "Completed" : "Retaining";
    return this.receipt("releaseReward", missionId, {
      label,
      percentage,
      amountMinor,
      currency: bounty.currency,
      settlementAsset: simulatedUsdcSettlementAtomic(amountSettlementAtomic),
      totalReleasedMinor: bounty.releasedMinor,
    });
  }

  requireBounty(missionId) {
    const bounty = this.bounties.get(missionId);
    if (!bounty) throw new Error("BOUNTY_NOT_FOUND");
    return bounty;
  }
}

module.exports = { LocalMonadAdapter };
