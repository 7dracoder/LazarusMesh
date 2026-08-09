"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { migrateStateForRuntime } = require("../src/state-migrations");

function runtimeSystem() {
  return {
    negotiation: { ready: false },
    recovery: { networkedProviders: false },
    actors: { verifiers: { connected: false } },
    rain: { external: false },
    financialExecution: { realFunds: false },
  };
}

test("legacy deployed missions migrate to explicit local actor and no-funds metadata", () => {
  const state = {
    schemaVersion: 1,
    system: { name: "Lazarus Mesh" },
    missions: [{
      id: "mission_legacy",
      createdAt: "2026-08-08T16:00:00.000Z",
      objective: "Recover a known CC0 dataset, verify every piece, and restore at least two independent seeders.",
      statusLabel: "Dead — no complete peers",
      principal: { id: "principal_rain_labs", name: "Rain Labs Research" },
      provider: { id: "provider_atlas_archive", name: "Atlas Archive Node" },
      verifiers: [{ id: "verifier_north", name: "North Verifier" }],
      negotiation: {
        offers: [{}],
        rounds: [{ buyer: {}, seller: {} }],
        acceptedQuote: {
          amountMinor: 975,
          merchantAuthenticated: true,
          merchantSigned: true,
        },
      },
      rainCard: { mode: "local", principalId: "principal_rain_labs" },
      payments: [{
        mode: "local",
        status: "settled",
        payer: "principal_rain_labs",
        paymentResponse: { candidateProviders: 2, recommendedProvider: "provider_atlas_archive" },
      }],
      transactions: [
        { rail: "Rain scoped card", status: "settled" },
        { rail: "Monad", status: "confirmed", details: {} },
      ],
      events: [
        { id: "legacy_quote", title: "Binding archive quote accepted" },
        { id: "legacy_recovery", title: "First pieces recovered" },
      ],
    }],
  };

  const migrated = migrateStateForRuntime(state, runtimeSystem());
  const mission = migrated.missions[0];
  assert.equal(migrated.schemaVersion, 3);
  assert.equal(mission.objective, "Reconstruct a known CC0 fixture, verify every piece, and model two complete replicas.");
  assert.equal(mission.statusLabel, "Fixture unavailable — no modeled replica");
  assert.equal(mission.principal.id, "principal_lazarus_demo");
  assert.equal(mission.principal.name, "Lazarus Demo Sponsor");
  assert.equal(mission.principal.actorMode, "simulated");
  assert.equal(mission.provider.externalEndpoint, false);
  assert.equal(mission.verifiers[0].actorMode, "simulated");
  assert.equal(mission.negotiation.executionMode, "local-simulation");
  assert.equal(mission.negotiation.acceptedQuote.merchantAuthenticated, false);
  assert.equal(mission.negotiation.acceptedQuote.merchantSigned, false);
  assert.equal(mission.negotiation.offers[0].source, "simulated");
  assert.equal(mission.negotiation.rounds[0].buyer.source, "local-policy");
  assert.equal(mission.negotiation.rounds[0].seller.source, "simulated-merchant-model");
  assert.equal(mission.rainCard.synthetic, true);
  assert.equal(mission.rainCard.principalId, "principal_lazarus_demo");
  assert.equal(mission.rainCard.fundsMoved, false);
  assert.equal(mission.payments[0].synthetic, true);
  assert.equal(mission.payments[0].fundsMoved, false);
  assert.equal(mission.payments[0].payer, "principal_lazarus_demo");
  assert.equal(mission.payments[0].paymentResponse.candidateProviders, 1);
  assert.ok(mission.transactions.every((transaction) => transaction.synthetic === true));
  assert.ok(mission.transactions.every((transaction) => transaction.fundsMoved === false));
  assert.equal(mission.transactions[1].chainWrite, false);
  assert.equal(mission.transactions[1].details.chainWrite, false);
  assert.match(mission.events.find((event) => event.id === "legacy_quote").description, /No external merchant/);
  assert.match(mission.events.find((event) => event.id === "legacy_recovery").description, /bundled CC0 fixture/);
  assert.equal(mission.events.filter((event) => event.id === "actor_boundary_v2:mission_legacy").length, 1);

  migrateStateForRuntime(state, runtimeSystem());
  assert.equal(mission.events.filter((event) => event.id === "actor_boundary_v2:mission_legacy").length, 1);
});

test("schema-2 external Rain and Monad x402 evidence remains external under a local runtime", () => {
  const rainPayment = {
    mode: "rain-sandbox",
    receiptId: "rain_external_receipt",
    transactionHash: "rain_external_transaction",
    status: "settled",
    synthetic: false,
    fundsMoved: true,
    externalEndpoint: true,
    amountMinor: 975,
    currency: "USD",
  };
  const x402Payment = {
    mode: "monad-testnet",
    receiptId: "x402_external_receipt",
    transactionHash: `0x${"ab".repeat(32)}`,
    status: "settled",
    network: "eip155:10143",
    synthetic: false,
    fundsMoved: true,
    externalEndpoint: true,
    chainWrite: true,
    amountMinor: 1,
    budgetImpactMinor: 1,
    currency: "USD",
    settlementAsset: {
      symbol: "USDC",
      address: "0x534b2f3A21130d7a60830c2Df862319e593943A3",
      decimals: 6,
      amountAtomic: "10000",
    },
  };
  const rainTransaction = {
    id: "rain_external_transaction",
    rail: "Rain scoped card",
    status: "settled",
    synthetic: false,
    fundsMoved: true,
    externalEndpoint: true,
  };
  const x402Transaction = {
    id: x402Payment.transactionHash,
    rail: "x402 / Monad",
    status: "settled",
    synthetic: false,
    fundsMoved: true,
    externalEndpoint: true,
    chainWrite: true,
    details: {
      synthetic: false,
      fundsMoved: true,
      externalEndpoint: true,
      chainWrite: true,
    },
  };
  const state = {
    schemaVersion: 2,
    system: { name: "Lazarus Mesh" },
    missions: [{
      id: "mission_external_history",
      createdAt: "2026-08-08T16:00:00.000Z",
      completedAt: "2026-08-08T16:10:00.000Z",
      budget: { currency: "USD" },
      principal: { id: "principal_external", name: "External Sponsor" },
      rainCard: {
        cardId: "11111111-1111-4111-8111-111111111111",
        mode: "rain-sandbox",
        currency: "USD",
        synthetic: false,
        fundsMoved: true,
        externalEndpoint: true,
      },
      payments: [rainPayment, x402Payment],
      transactions: [rainTransaction, x402Transaction],
      events: [{
        id: "external_payment_event",
        source: "x402",
        title: "Availability intelligence purchased",
        description: "A confirmed external testnet payment was recorded.",
      }],
    }],
  };
  const expectedEvidence = structuredClone({
    rainPayment,
    x402Payment,
    rainTransaction,
    x402Transaction,
  });

  const migrated = migrateStateForRuntime(state, runtimeSystem());
  const mission = migrated.missions[0];

  assert.equal(migrated.schemaVersion, 3);
  assert.equal(mission.rainCard.mode, "rain-sandbox");
  assert.equal(mission.rainCard.synthetic, false);
  assert.equal(mission.rainCard.fundsMoved, true);
  assert.equal(mission.rainCard.externalEndpoint, true);
  assert.deepEqual(mission.payments[0], expectedEvidence.rainPayment);
  assert.deepEqual(mission.payments[1], expectedEvidence.x402Payment);
  assert.deepEqual(mission.transactions[0], expectedEvidence.rainTransaction);
  assert.deepEqual(mission.transactions[1], expectedEvidence.x402Transaction);
  assert.equal(mission.transactions[1].chainWrite, true);
  assert.equal(mission.transactions[1].details.chainWrite, true);
  assert.equal(
    mission.events.find((event) => event.id === "external_payment_event").description,
    "A confirmed external testnet payment was recorded.",
  );
  assert.match(
    mission.events.find((event) => event.id === "actor_boundary_v2:mission_external_history").description,
    /unless an external connector is explicitly reported/,
  );
});
