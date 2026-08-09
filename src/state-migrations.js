"use strict";

const { currencyInfo, normalizeCurrency } = require("./domain/currency");

const STATE_SCHEMA_VERSION = 3;
const MONAD_USDC_TESTNET = "0x534b2f3A21130d7a60830c2Df862319e593943A3";

function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function localPaymentRecord(record) {
  const value = object(record);
  return value.mode === "local"
    || value.synthetic === true
    || String(value.transactionHash || value.id || "").startsWith("local_");
}

function rewriteLegacyEvent(event, mission) {
  if (!event || typeof event !== "object") return event;
  const amount = Number.isSafeInteger(mission?.negotiation?.acceptedQuote?.amountMinor)
    ? `$${(mission.negotiation.acceptedQuote.amountMinor / 100).toFixed(2)}`
    : "the policy-bound amount";
  const replacements = {
    "Artifact unavailable": {
      source: "Local recovery fixture",
      title: "Demo artifact marked unavailable",
      description: "Manifest valid; the demo begins with zero modeled replicas. No peer network was scanned.",
    },
    "Binding archive quote accepted": {
      source: "Local bargaining policy",
      title: "Policy-bound demo quote accepted",
      description: `The simulated Atlas seller model accepted ${amount}. No external merchant was contacted.`,
    },
    "Availability handshake simulated": {
      source: "x402",
      title: "Availability handshake simulated",
      description: "The local HTTP 402 demo selected the simulated Atlas fixture provider. No external provider was contacted and no token moved.",
    },
    "Provider claim recorded": {
      source: "Monad",
      title: "Demo provider claim recorded",
      description: "The simulated Atlas fixture provider was assigned in the local ledger. No provider endpoint, collateral, or token was involved.",
    },
    "Demo provider claim recorded": {
      source: "Monad",
      title: "Demo provider claim recorded",
      description: "The simulated Atlas fixture provider was assigned in the local ledger. No provider endpoint, collateral, or token was involved.",
    },
    "First pieces recovered": {
      source: "Local recovery fixture",
      title: "First fixture pieces loaded",
      description: "Eight cryptographically addressed pieces were loaded from the bundled CC0 fixture; no external provider transferred data.",
    },
    "Recovery passed halfway": {
      source: "Local recovery fixture",
      title: "Fixture reconstruction passed halfway",
      description: "Sixteen of 24 bundled fixture pieces were loaded and matched against the manifest.",
    },
    "Random challenges passed": {
      source: "Local verifier quorum",
      title: "Scripted verification passed",
      description: "North and East are local verifier roles; they checked fixture pieces without contacting independent services.",
    },
    "Artifact resurrected": {
      source: "Recovery simulation",
      title: "Demo replicas modeled",
      description: "The demo modeled two complete replicas and recorded the milestone locally; no external seeding network was contacted.",
    },
    "Scoped card retired": {
      source: "Rain",
      title: "Simulated card retired",
      description: "The local card-policy simulation removed its demo authority; no real card existed.",
    },
    "Mission completed": {
      source: "Lazarus Mesh",
      title: "Mission simulation completed",
      description: "The bundled-fixture recovery simulation completed with scripted proofs, local receipts, and $0.00 charged.",
    },
  };
  return Object.assign(event, replacements[event.title] || {});
}

function migrateMission(mission, system, sourceSchemaVersion) {
  if (!mission || typeof mission !== "object") return mission;
  const merchantLive = system.negotiation?.ready === true;
  const providerLive = system.recovery?.networkedProviders === true;
  const verifiersLive = system.actors?.verifiers?.connected === true;
  const budgetCurrency = normalizeCurrency(mission.budget?.currency || "USD", "");
  if (!budgetCurrency) {
    const error = new Error("Stored mission uses an unsupported accounting currency.");
    error.code = "PERSISTED_STATE_CURRENCY_NOT_SUPPORTED";
    throw error;
  }
  const currencyMetadata = currencyInfo(budgetCurrency);
  const hasExternalExecutionEvidence = mission.rainCard?.mode === "rain-sandbox"
    || (Array.isArray(mission.payments) && mission.payments.some((payment) => (
      payment?.externalEndpoint === true || payment?.mode === "rain-sandbox" || payment?.mode === "monad-testnet"
    )))
    || (Array.isArray(mission.transactions) && mission.transactions.some((transaction) => (
      transaction?.externalEndpoint === true || transaction?.details?.externalEndpoint === true
    )));
  if (mission.budget && typeof mission.budget === "object") {
    mission.budget.currency = budgetCurrency;
    mission.budget.accountingCurrency = budgetCurrency;
    mission.budget.exponent = currencyMetadata.minorDigits;
    mission.budget.currencyRateSet ||= "lazarus-demo-reference-v1";
    mission.budget.fx = {
      ...object(mission.budget.fx),
      mode: "demo-fixed-not-market-rate",
      rateSet: mission.budget.currencyRateSet,
      referenceCurrency: "USD",
      minorPerUsd: currencyMetadata.minorPerUsd,
    };
    mission.budget.railSettlement = {
      ...object(mission.budget.railSettlement),
      rain: { currency: "USD", mode: "sandbox-card-authorization" },
      localScopedCard: { currency: budgetCurrency, mode: "simulation" },
      monad: { asset: "USDC", decimals: 6, network: "eip155:10143" },
      gasAndCollateral: { asset: "MON", decimals: 18, network: "eip155:10143" },
    };
  }

  if (mission.objective === "Recover a known CC0 dataset, verify every piece, and restore at least two independent seeders.") {
    mission.objective = "Reconstruct a known CC0 fixture, verify every piece, and model two complete replicas.";
  }
  if (mission.statusLabel === "Dead — no complete peers") {
    mission.statusLabel = "Fixture unavailable — no modeled replica";
  }

  if (mission.principal?.id === "principal_rain_labs" || mission.principal?.name === "Rain Labs Research") {
    mission.principal.id = "principal_lazarus_demo";
    mission.principal.name = "Lazarus Demo Sponsor";
    mission.principal.verification = "Simulated local principal";
  }
  if (mission.principal) {
    mission.principal.actorMode = "simulated";
    mission.principal.connected = false;
    mission.principal.externalEndpoint = false;
  }
  if (mission.provider) {
    mission.provider.actorMode = providerLive ? "external" : "simulated";
    mission.provider.connected = providerLive;
    mission.provider.externalEndpoint = providerLive;
  }
  for (const verifier of Array.isArray(mission.verifiers) ? mission.verifiers : []) {
    if (!verifier || typeof verifier !== "object") continue;
    verifier.actorMode = verifiersLive ? "external" : "simulated";
    verifier.connected = verifiersLive;
    verifier.externalEndpoint = verifiersLive;
  }

  if (mission.negotiation) {
    mission.negotiation.executionMode = merchantLive ? "external-merchant-api" : "local-simulation";
    mission.negotiation.merchantAuthenticated = merchantLive;
    mission.negotiation.merchantSignedQuote = merchantLive;
    if (mission.negotiation.acceptedQuote && !merchantLive) {
      mission.negotiation.acceptedQuote.source = "simulated";
      mission.negotiation.acceptedQuote.merchantAuthenticated = false;
      mission.negotiation.acceptedQuote.merchantSigned = false;
    }
    for (const offer of Array.isArray(mission.negotiation.offers) ? mission.negotiation.offers : []) {
      if (!offer || typeof offer !== "object" || merchantLive) continue;
      offer.source = "simulated";
      offer.merchantAuthenticated = false;
    }
    for (const round of Array.isArray(mission.negotiation.rounds) ? mission.negotiation.rounds : []) {
      if (!round || typeof round !== "object" || merchantLive) continue;
      if (round.buyer && typeof round.buyer === "object") round.buyer.source = "local-policy";
      if (round.seller && typeof round.seller === "object") round.seller.source = "simulated-merchant-model";
    }
  }

  if (mission.rainCard) {
    mission.rainCard.currency = String(mission.rainCard.currency || budgetCurrency).toUpperCase();
    if (mission.rainCard.mode === "local") {
      if (mission.rainCard.principalId === "principal_rain_labs") {
        mission.rainCard.principalId = "principal_lazarus_demo";
      }
      mission.rainCard.synthetic = true;
      mission.rainCard.fundsMoved = false;
      mission.rainCard.externalEndpoint = false;
    }
  }
  for (const payment of Array.isArray(mission.payments) ? mission.payments : []) {
    if (!localPaymentRecord(payment)) continue;
    if (payment.payer === "principal_rain_labs") payment.payer = "principal_lazarus_demo";
    payment.synthetic = true;
    payment.fundsMoved = false;
    payment.externalEndpoint = false;
    if (
      sourceSchemaVersion < STATE_SCHEMA_VERSION &&
      budgetCurrency === "USD" &&
      payment.network === "eip155:10143" &&
      String(payment.currency).toUpperCase() === "USDC"
    ) {
      const legacyMinor = Number.isSafeInteger(payment.amountMinor) ? payment.amountMinor : 0;
      payment.budgetImpactMinor ??= legacyMinor;
      payment.settlementAsset ||= {
        symbol: "USDC",
        address: MONAD_USDC_TESTNET,
        decimals: 6,
        amountAtomic: (BigInt(legacyMinor) * 10_000n).toString(),
        mode: "synthetic-reference",
      };
      payment.currency = budgetCurrency;
    }
    if (payment.paymentResponse?.recommendedProvider === "provider_atlas_archive") {
      payment.paymentResponse.candidateProviders = 1;
    }
  }
  for (const transaction of Array.isArray(mission.transactions) ? mission.transactions : []) {
    if (!transaction || typeof transaction !== "object") continue;
    const rail = String(transaction.rail || "").toLowerCase();
    const localFinancialRecord = transaction.synthetic === true
      || transaction.mode === "local"
      || transaction.details?.mode === "local"
      || String(transaction.id || "").startsWith("local_")
      || (
        sourceSchemaVersion < STATE_SCHEMA_VERSION &&
        !hasExternalExecutionEvidence &&
        transaction.externalEndpoint !== true &&
        transaction.synthetic !== false &&
        system.rain?.external !== true &&
        (rail.includes("rain") || rail.includes("monad") || rail.includes("x402"))
      );
    if (!localFinancialRecord) continue;
    transaction.synthetic = true;
    transaction.fundsMoved = false;
    transaction.externalEndpoint = false;
    if (rail.includes("monad")) transaction.chainWrite = false;
    if (
      sourceSchemaVersion < STATE_SCHEMA_VERSION &&
      budgetCurrency === "USD" &&
      rail.includes("x402") &&
      String(transaction.currency).toUpperCase() === "USDC"
    ) {
      const legacyMinor = Number.isSafeInteger(transaction.amountMinor) ? transaction.amountMinor : 0;
      transaction.settlementAsset ||= {
        symbol: "USDC",
        address: MONAD_USDC_TESTNET,
        decimals: 6,
        amountAtomic: (BigInt(legacyMinor) * 10_000n).toString(),
        mode: "synthetic-reference",
      };
      transaction.currency = budgetCurrency;
    } else if (rail.includes("monad") && Number.isSafeInteger(transaction.amountMinor)) {
      transaction.currency = budgetCurrency;
    }
    if (transaction.details && typeof transaction.details === "object") {
      transaction.details.synthetic = true;
      transaction.details.fundsMoved = false;
      if (rail.includes("monad")) transaction.details.chainWrite = false;
    }
  }

  if (
    sourceSchemaVersion < STATE_SCHEMA_VERSION &&
    !hasExternalExecutionEvidence &&
    system.rain?.external !== true &&
    Array.isArray(mission.events)
  ) {
    mission.events.forEach((event) => rewriteLegacyEvent(event, mission));
    if (!mission.events.some((event) => event?.id === `actor_boundary_v2:${mission.id}`)) {
      mission.events.unshift({
        id: `actor_boundary_v2:${mission.id}`,
        source: "Runtime disclosure",
        title: "Demo actor boundary confirmed",
        description: "Atlas, the provider, and verifier roles are local simulations. No external merchant or agent endpoint participated, and no funds moved.",
        status: "info",
        timestamp: mission.completedAt || mission.createdAt || new Date(0).toISOString(),
      });
    }
  } else if (Array.isArray(mission.events) && !mission.events.some((event) => event?.id === `actor_boundary_v2:${mission.id}`)) {
    mission.events.unshift({
      id: `actor_boundary_v2:${mission.id}`,
      source: "Runtime disclosure",
      title: "Demo actor boundary confirmed",
      description: "Atlas, the provider, and verifier roles are local simulations unless an external connector is explicitly reported. Rain sandbox and Monad rails are infrastructure, not merchant agents.",
      status: "info",
      timestamp: mission.completedAt || mission.createdAt || new Date(0).toISOString(),
    });
  }
  return mission;
}

function migrateStateForRuntime(state, runtimeSystem = {}) {
  if (!state || typeof state !== "object") return state;
  state.system = { ...object(state.system), ...object(runtimeSystem) };
  const version = Number.isSafeInteger(state.schemaVersion) ? state.schemaVersion : 1;
  for (const mission of Array.isArray(state.missions) ? state.missions : []) {
    migrateMission(mission, state.system, version);
  }
  state.schemaVersion = Math.max(version, STATE_SCHEMA_VERSION);
  return state;
}

module.exports = {
  STATE_SCHEMA_VERSION,
  // Backwards-compatible export for callers from the earlier actor-boundary migration.
  ACTOR_TRANSPARENCY_SCHEMA_VERSION: STATE_SCHEMA_VERSION,
  migrateStateForRuntime,
};
