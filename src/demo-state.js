const { randomUUID } = require("node:crypto");
const { RATE_SET_ID, currencyInfo, fromAccountingMinorUp } = require("./domain/currency");

const DEFAULT_MISSION_LIFETIME_MS = 60 * 60 * 1000;
const LIVE_PREVIEW_MISSION_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;

function publicManifest(manifest) {
  return {
    name: manifest.name,
    license: manifest.license,
    totalBytes: manifest.totalBytes,
    totalPieces: manifest.totalPieces,
    contentSha256: manifest.contentSha256,
    contentRoot: manifest.contentRoot,
    pieces: manifest.pieces,
  };
}

function makeEvent({ source, title, description, status = "info", timestamp = new Date().toISOString() }) {
  return {
    id: randomUUID(),
    source,
    title,
    description,
    status,
    timestamp,
  };
}

function createMission({
  recovery,
  id = "mission_lazarus_demo",
  title = "Restore the CC0 Rainfall Dataset",
  rewardMinor = 500,
  totalBudgetMinor = 2000,
  currency = "USD",
  currencyRateSet = RATE_SET_ID,
  lifetimeMs = DEFAULT_MISSION_LIFETIME_MS,
} = {}) {
  const manifest = recovery.buildManifest(24);
  recovery.start(id, manifest);
  const currencyMetadata = currencyInfo(currency);
  if (!currencyMetadata) throw new Error("CURRENCY_NOT_SUPPORTED");
  const converted = (usdMinor) => fromAccountingMinorUp(usdMinor, currency);
  const stakeMinor = converted(200);
  if (
    !Number.isSafeInteger(lifetimeMs) ||
    lifetimeMs < DEFAULT_MISSION_LIFETIME_MS ||
    lifetimeMs > LIVE_PREVIEW_MISSION_LIFETIME_MS
  ) {
    throw new Error("MISSION_LIFETIME_INVALID");
  }
  const expiresAt = new Date(Date.now() + lifetimeMs).toISOString();
  const negotiationTerms = {
    purchaseModel: "one_time",
    service: "archival_egress",
    autoRenewal: false,
    dataSharing: false,
    exclusivity: false,
  };

  return {
    id,
    title,
    objective: "Reconstruct a known CC0 fixture, verify every piece, and model two complete replicas.",
    status: "DEAD",
    statusLabel: "Fixture unavailable — no modeled replica",
    availability: 0,
    stepIndex: 0,
    running: false,
    createdAt: new Date().toISOString(),
    completedAt: null,
    principal: {
      id: "principal_lazarus_demo",
      name: "Lazarus Demo Sponsor",
      verification: "Simulated local principal",
      actorMode: "simulated",
      connected: false,
      externalEndpoint: false,
    },
    provider: {
      id: "provider_atlas_archive",
      name: "Atlas Archive Node",
      state: "unassigned",
      stakeMinor,
      stakeCurrency: currency,
      collateral: {
        mode: "local-reference-only",
        referenceAmountMinor: stakeMinor,
        referenceCurrency: currency,
        settlementAsset: "MON",
        amountAtomic: null,
      },
      reputation: 92,
      actorMode: "simulated",
      connected: false,
      externalEndpoint: false,
    },
    rightsEvidence: true,
    deadline: expiresAt,
    manifest: publicManifest(manifest),
    contentRoot: manifest.contentRoot,
    pieces: recovery.progress(id),
    seeders: 0,
    budget: {
      currency,
      exponent: currencyMetadata.minorDigits,
      accountingCurrency: currency,
      currencyRateSet,
      fx: {
        mode: "demo-fixed-not-market-rate",
        rateSet: currencyRateSet,
        referenceCurrency: "USD",
        minorPerUsd: currencyMetadata.minorPerUsd,
      },
      railSettlement: {
        rain: { currency: "USD", mode: "sandbox-card-authorization" },
        localScopedCard: { currency, mode: "simulation" },
        monad: { asset: "USDC", decimals: 6, network: "eip155:10143" },
        gasAndCollateral: { asset: "MON", decimals: 18, network: "eip155:10143" },
      },
      totalMinor: totalBudgetMinor,
      spentMinor: 0,
      rewardMinor,
      releasedMinor: 0,
      stakeMinor,
    },
    policy: {
      rightsClass: "public_domain",
      rightsEvidence: "fixtures/cc0-rainfall-dataset/LICENSE.md",
      allowedMerchantIds: ["merchant_atlas_archive"],
      allowedMerchants: ["merchant_atlas_archive"],
      allowedMccs: ["5734", "4816"],
      maximumTransactionMinor: converted(1200),
      perTransactionLimitMinor: converted(1200),
      maximumTransactions: 1,
      maxTransactions: 1,
      totalLimitMinor: totalBudgetMinor,
      expiresAt,
      humanApprovalThresholdMinor: converted(1500),
      approvalThresholdMinor: converted(1500),
      allowedCurrencies: [currency],
      allowedRails: ["monad_escrow", "x402_monad", "rain_card"],
      killSwitchActive: false,
    },
    negotiation: {
      status: "not_started",
      executionMode: "local-simulation",
      merchantAuthenticated: false,
      merchantSignedQuote: false,
      sessionId: null,
      targetAmountMinor: converted(900),
      maximumAmountMinor: converted(1200),
      initialAmountMinor: converted(1200),
      maximumRounds: 3,
      autoApprovalThresholdMinor: converted(1000),
      allowedMerchantIds: ["merchant_atlas_archive"],
      allowedMccs: ["5734"],
      allowedCurrencies: [currency],
      requiredTerms: negotiationTerms,
      offers: [],
      rounds: [],
      acceptedQuote: null,
      decision: null,
      savingsMinor: 0,
      savingsBps: 0,
      completedAt: null,
    },
    rainCard: null,
    policyDecisions: [],
    payments: [],
    transactions: [],
    verifiers: [
      { id: "verifier_north", name: "North Verifier", state: "pending", reputation: 97, actorMode: "simulated", connected: false, externalEndpoint: false },
      { id: "verifier_east", name: "East Verifier", state: "pending", reputation: 94, actorMode: "simulated", connected: false, externalEndpoint: false },
      { id: "verifier_west", name: "West Verifier", state: "pending", reputation: 91, actorMode: "simulated", connected: false, externalEndpoint: false },
    ],
    audit: {
      expectedContentSha256: manifest.contentSha256,
      reconstructedContentSha256: null,
      rootMatched: false,
      quorum: "0/2",
    },
    events: [
      makeEvent({
        source: "Local recovery fixture",
        title: "Demo artifact marked unavailable",
        description: "Manifest valid; the demo begins with zero modeled replicas. No peer network was scanned.",
        status: "warning",
      }),
    ],
  };
}

function createDefaultState(recovery, {
  system = {},
  missionLifetimeMs = DEFAULT_MISSION_LIFETIME_MS,
} = {}) {
  const mission = createMission({ recovery, lifetimeMs: missionLifetimeMs });
  return {
    schemaVersion: 3,
    activeMissionId: mission.id,
    system: {
      name: "Lazarus Mesh",
      mode: "local",
      rain: "local-adapter",
      monad: "local-ledger",
      x402: "local-handshake",
      negotiation: "local-bargaining",
      networkAccess: false,
      startedAt: new Date().toISOString(),
      ...system,
    },
    missions: [mission],
  };
}

module.exports = {
  DEFAULT_MISSION_LIFETIME_MS,
  LIVE_PREVIEW_MISSION_LIFETIME_MS,
  createDefaultState,
  createMission,
  makeEvent,
};
