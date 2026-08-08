const { randomUUID } = require("node:crypto");

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
} = {}) {
  const manifest = recovery.buildManifest(24);
  recovery.start(id, manifest);
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
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
    objective: "Recover a known CC0 dataset, verify every piece, and restore at least two independent seeders.",
    status: "DEAD",
    statusLabel: "Dead — no complete peers",
    availability: 0,
    stepIndex: 0,
    running: false,
    createdAt: new Date().toISOString(),
    completedAt: null,
    principal: {
      id: "principal_rain_labs",
      name: "Rain Labs Research",
      verification: "Local verified demo business",
    },
    provider: {
      id: "provider_atlas_archive",
      name: "Atlas Archive Node",
      state: "unassigned",
      stakeMinor: 200,
      reputation: 92,
    },
    rightsEvidence: true,
    deadline: expiresAt,
    manifest: publicManifest(manifest),
    contentRoot: manifest.contentRoot,
    pieces: recovery.progress(id),
    seeders: 0,
    budget: {
      currency: "USD",
      totalMinor: totalBudgetMinor,
      spentMinor: 0,
      rewardMinor,
      releasedMinor: 0,
      stakeMinor: 200,
    },
    policy: {
      rightsClass: "public_domain",
      rightsEvidence: "fixtures/cc0-rainfall-dataset/LICENSE.md",
      allowedMerchantIds: ["merchant_atlas_archive"],
      allowedMerchants: ["merchant_atlas_archive"],
      allowedMccs: ["5734", "4816"],
      maximumTransactionMinor: 1200,
      perTransactionLimitMinor: 1200,
      maximumTransactions: 1,
      maxTransactions: 1,
      totalLimitMinor: totalBudgetMinor,
      expiresAt,
      humanApprovalThresholdMinor: 1500,
      approvalThresholdMinor: 1500,
      allowedRails: ["monad_escrow", "x402_monad", "rain_card"],
      killSwitchActive: false,
    },
    negotiation: {
      status: "not_started",
      sessionId: null,
      targetAmountMinor: 900,
      maximumAmountMinor: 1200,
      initialAmountMinor: 1200,
      maximumRounds: 3,
      autoApprovalThresholdMinor: 1000,
      allowedMerchantIds: ["merchant_atlas_archive"],
      allowedMccs: ["5734"],
      allowedCurrencies: ["USD"],
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
      { id: "verifier_north", name: "North Verifier", state: "pending", reputation: 97 },
      { id: "verifier_east", name: "East Verifier", state: "pending", reputation: 94 },
      { id: "verifier_west", name: "West Verifier", state: "pending", reputation: 91 },
    ],
    audit: {
      expectedContentSha256: manifest.contentSha256,
      reconstructedContentSha256: null,
      rootMatched: false,
      quorum: "0/2",
    },
    events: [
      makeEvent({
        source: "Recovery network",
        title: "Artifact unavailable",
        description: "Manifest valid; zero complete peers detected. Recovery mission ready.",
        status: "warning",
      }),
    ],
  };
}

function createDefaultState(recovery, { system = {} } = {}) {
  const mission = createMission({ recovery });
  return {
    schemaVersion: 1,
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

module.exports = { createDefaultState, createMission, makeEvent };
