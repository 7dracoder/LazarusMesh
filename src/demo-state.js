const { randomUUID } = require("node:crypto");
const { RATE_SET_ID, currencyInfo, fromAccountingMinorUp } = require("./domain/currency");
const { STATE_SCHEMA_VERSION, createRuntimeBinding } = require("./state-migrations");

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
  negotiation,
  id = "mission_lazarus_demo",
  title = "Restore the CC0 Rainfall Dataset",
  rewardMinor = 500,
  totalBudgetMinor = 2000,
  currency = "USD",
  currencyRateSet = RATE_SET_ID,
  lifetimeMs = DEFAULT_MISSION_LIFETIME_MS,
} = {}) {
  const manifest = recovery.buildManifest();
  recovery.start(id, manifest);
  const liveMerchant = negotiation?.liveMerchantApi === true;
  const networkedProvider = recovery?.networkedProviders === true;
  const merchantProfile = negotiation?.merchant || {
    merchantId: "merchant_atlas_archive",
    merchantName: "Atlas Archive Cloud",
  };
  const providerProfile = recovery?.provider || {
    providerId: "provider_atlas_archive",
    providerName: "Atlas Archive Node",
  };
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
    objective: networkedProvider
      ? "Recover a pinned CC0 artifact from an authenticated provider, verify every piece, and model two complete replicas."
      : "Reconstruct a known CC0 fixture, verify every piece, and model two complete replicas.",
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
      id: providerProfile.providerId,
      name: providerProfile.providerName,
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
      actorMode: networkedProvider ? "external" : "simulated",
      connected: networkedProvider,
      externalEndpoint: networkedProvider,
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
      rightsEvidence: networkedProvider
        ? `Pinned ${manifest.license} provider manifest`
        : "fixtures/cc0-rainfall-dataset/LICENSE.md",
      allowedMerchantIds: [merchantProfile.merchantId],
      allowedMerchants: [merchantProfile.merchantId],
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
      executionMode: liveMerchant ? "external-merchant-api" : "local-simulation",
      merchantAuthenticated: liveMerchant && negotiation?.merchantAuthenticated === true,
      merchantSignedQuote: liveMerchant && negotiation?.merchantSignedQuotes === true,
      sessionId: null,
      targetAmountMinor: converted(900),
      maximumAmountMinor: converted(1200),
      initialAmountMinor: converted(1200),
      maximumRounds: 3,
      autoApprovalThresholdMinor: converted(1000),
      allowedMerchantIds: [merchantProfile.merchantId],
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
        source: networkedProvider ? "Pinned recovery provider" : "Local recovery fixture",
        title: networkedProvider ? "Remote artifact marked unavailable" : "Demo artifact marked unavailable",
        description: networkedProvider
          ? "The sponsor-pinned manifest is valid; no bytes have been requested from the authenticated provider yet."
          : "Manifest valid; the demo begins with zero modeled replicas. No peer network was scanned.",
        status: "warning",
      }),
    ],
  };
}

function createDefaultState(recovery, {
  system = {},
  negotiation,
  missionLifetimeMs = DEFAULT_MISSION_LIFETIME_MS,
} = {}) {
  const remoteMissionId = negotiation?.liveMerchantApi === true
    ? `mission_${randomUUID().replaceAll("-", "").slice(0, 16)}`
    : undefined;
  const mission = createMission({
    recovery,
    negotiation,
    ...(remoteMissionId ? { id: remoteMissionId } : {}),
    lifetimeMs: missionLifetimeMs,
  });
  const stateSystem = {
    name: "Lazarus Mesh",
    mode: "local",
    rain: "local-adapter",
    monad: "local-ledger",
    x402: "local-handshake",
    negotiation: "local-bargaining",
    networkAccess: false,
    startedAt: new Date().toISOString(),
    ...system,
  };
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    runtimeBinding: createRuntimeBinding(stateSystem),
    activeMissionId: mission.id,
    system: stateSystem,
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
