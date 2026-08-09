const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { createApplication } = require("../server");
const { MemoryStore } = require("../src/store");
const { rehydrateLocalAdapters } = require("../src/rehydrate-local");
const { LocalNegotiationAdapter } = require("../src/services/negotiation-local");
const { createMission } = require("../src/demo-state");
const { fromAccountingMinorUp } = require("../src/domain/currency");

async function withServer(run, applicationOptions = {}) {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lazarus-mesh-test-"));
  const { server } = createApplication({
    ...applicationOptions,
    dataFile: path.join(temporaryRoot, "state.json"),
  });
  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    await run(baseUrl);
  } finally {
    if (server.listening) await new Promise((resolve) => server.close(resolve));
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

test("full local workflow keeps each supported accounting currency isolated from settlement assets", async () => {
  const store = new MemoryStore(() => ({ missions: [] }));
  const app = createApplication({ store });
  const expectedSpent = {
    USD: 976,
    EUR: 898,
    GBP: 762,
    CAD: 1338,
    AUD: 1484,
  };

  for (const currency of Object.keys(expectedSpent)) {
    const mission = createMission({
      recovery: app.adapters.recovery,
      id: `mission_currency_${currency.toLowerCase()}`,
      title: `${currency} recovery`,
      currency,
      totalBudgetMinor: fromAccountingMinorUp(2000, currency),
      rewardMinor: fromAccountingMinorUp(500, currency),
    });
    app.orchestrator.addMission(mission);
    await app.orchestrator.run(mission.id, 0);

    assert.equal(mission.status, "COMPLETED");
    assert.equal(mission.budget.currency, currency);
    assert.equal(mission.budget.spentMinor, expectedSpent[currency]);
    assert.equal(mission.negotiation.acceptedQuote.currency, currency);
    assert.equal(mission.rainCard.currency, currency);
    assert.ok(mission.payments.every((payment) => payment.currency === currency));
    assert.ok(mission.transactions.every((transaction) => transaction.currency === currency));

    const discovery = mission.payments.find((payment) => payment.network === "eip155:10143");
    assert.equal(discovery.settlementAsset.symbol, "USDC");
    assert.equal(discovery.settlementAsset.decimals, 6);
    assert.equal(discovery.settlementAsset.amountAtomic, "10000");
    const bounty = mission.transactions.find((transaction) => transaction.operation === "createBounty");
    assert.equal(bounty.settlementAsset.symbol, "USDC");
    assert.match(bounty.settlementAsset.amountAtomic, /^\d+$/);
  }
});

test("full local recovery finishes with verified data, payments, and retired authority", async () => {
  await withServer(async (baseUrl) => {
    const state = await fetch(`${baseUrl}/api/state`).then((response) => response.json());
    const missionId = state.activeMissionId;
    const response = await fetch(`${baseUrl}/api/missions/${missionId}/run`, { method: "POST" });
    assert.equal(response.status, 200);
    const mission = await response.json();

    assert.equal(mission.status, "COMPLETED");
    assert.equal(mission.stepIndex, 9);
    assert.equal(mission.pieces.recovered, 24);
    assert.equal(mission.pieces.verified, 24);
    assert.equal(mission.seeders, 2);
    assert.equal(mission.audit.rootMatched, true);
    assert.equal(mission.budget.releasedMinor, mission.budget.rewardMinor);
    assert.equal(mission.budget.spentMinor, 976);
    assert.equal(mission.negotiation.status, "consumed");
    assert.equal(mission.negotiation.initialAmountMinor, 1200);
    assert.equal(mission.negotiation.acceptedQuote.amountMinor, 975);
    assert.equal(mission.negotiation.savingsMinor, 225);
    assert.equal(mission.negotiation.savingsBps, 1875);
    assert.equal(mission.negotiation.rounds.length, 2);
    assert.equal(mission.negotiation.acceptedQuote.merchantAuthenticated, false);
    assert.equal(mission.negotiation.acceptedQuote.merchantSigned, false);
    assert.equal(mission.rainCard.maximumAmountMinor, 975);
    assert.equal(mission.rainCard.state, "retired");
    assert.equal(mission.rainCard.synthetic, true);
    assert.equal(mission.rainCard.fundsMoved, false);
    assert.ok(mission.payments.some(
      (payment) => payment.status === "declined" && payment.code === "MERCHANT_NOT_ALLOWED" && payment.amountMinor === 900,
    ));
    assert.ok(mission.payments.some(
      (payment) => payment.authorized === true && payment.amountMinor === 975 && payment.quoteId === mission.negotiation.acceptedQuote.quoteId,
    ));
    assert.ok(mission.payments.some((payment) => payment.network === "eip155:10143"));
    assert.ok(mission.payments.every((payment) => payment.synthetic === true));
    assert.ok(mission.payments.every((payment) => payment.fundsMoved === false));
    assert.ok(mission.transactions.some((transaction) => transaction.operation === "releaseReward"));
    assert.ok(mission.transactions.every((transaction) => transaction.synthetic === true));
    assert.ok(mission.transactions.every((transaction) => transaction.fundsMoved === false));
    assert.ok(mission.transactions
      .filter((transaction) => transaction.rail === "Monad")
      .every((transaction) => transaction.chainWrite === false && transaction.details.chainWrite === false));
    assert.ok(mission.events.some((event) => event.title === "Archive purchase simulated" && /No money was charged/.test(event.description)));
    assert.ok(mission.events.some((event) => event.title === "Policy safety test passed" && /No funds moved/.test(event.description)));

    const retiredChallenge = await fetch(`${baseUrl}/api/missions/${missionId}/blocked-purchase`, { method: "POST" });
    assert.equal(retiredChallenge.status, 409);
    assert.equal((await retiredChallenge.json()).code, "CARD_AUTHORITY_INACTIVE");
  });
});

test("negotiation API requires discovery and returns an idempotent binding quote", async () => {
  await withServer(async (baseUrl) => {
    const state = await fetch(`${baseUrl}/api/state`).then((response) => response.json());
    const missionId = state.activeMissionId;

    const premature = await fetch(`${baseUrl}/api/missions/${missionId}/negotiation`, { method: "POST" });
    assert.equal(premature.status, 409);

    const discovered = await fetch(`${baseUrl}/api/missions/${missionId}/step`, { method: "POST" });
    assert.equal(discovered.status, 200);

    const first = await fetch(`${baseUrl}/api/missions/${missionId}/negotiation`).then((response) => response.json());
    const replay = await fetch(`${baseUrl}/api/missions/${missionId}/negotiation`, { method: "POST" }).then((response) => response.json());
    assert.equal(first.status, "quote_accepted");
    assert.equal(first.acceptedQuote.amountMinor, 975);
    assert.equal(first.rounds.length, 2);
    assert.equal(replay.acceptedQuote.quoteId, first.acceptedQuote.quoteId);
  });
});

test("live merchant mode rejects an unauthenticated or unsigned quote", async () => {
  const negotiation = new LocalNegotiationAdapter();
  negotiation.liveMerchantApi = true;
  await withServer(async (baseUrl) => {
    const state = await fetch(`${baseUrl}/api/state`).then((response) => response.json());
    assert.equal(state.system.negotiation.liveMerchantApi, true);
    assert.equal(state.system.negotiation.ready, false);
    assert.equal(state.system.negotiation.communication, "external-https-untrusted");
    assert.equal(state.system.actors.externalConnected, 0);
    assert.equal(state.system.actors.merchant.connected, true);
    assert.equal(state.system.actors.merchant.ready, false);
    assert.ok(state.system.productionBlockers.includes("live_merchant_negotiation"));

    const response = await fetch(`${baseUrl}/api/missions/${state.activeMissionId}/step`, { method: "POST" });
    assert.equal(response.status, 422);
    const body = await response.json();
    assert.equal(body.code, "MERCHANT_QUOTE_UNTRUSTED");
    const failedState = await fetch(`${baseUrl}/api/state`).then((result) => result.json());
    const mission = failedState.missions.find((item) => item.id === state.activeMissionId);
    assert.equal(mission.negotiation.acceptedQuote, null);
    assert.equal(mission.rainCard, null);
  }, { adapterOverrides: { negotiation } });
});

test("a failed run durably clears its transient running flag", async () => {
  const negotiation = new LocalNegotiationAdapter();
  negotiation.liveMerchantApi = true;
  const persisted = [];
  const store = new MemoryStore(() => ({ missions: [] }));
  const app = createApplication({
    store,
    adapterOverrides: { negotiation },
    persistState: async (state) => persisted.push(JSON.parse(JSON.stringify(state))),
  });

  await assert.rejects(
    app.orchestrator.run(store.get().activeMissionId, 0),
    (error) => error.code === "MERCHANT_QUOTE_UNTRUSTED",
  );

  assert.equal(store.get().missions[0].running, false);
  assert.ok(persisted.length >= 1);
  assert.equal(persisted.at(-1).missions[0].running, false);
});

test("retry after bargaining failure preserves one discovery receipt and spend", async () => {
  const negotiation = new LocalNegotiationAdapter();
  const getBindingQuote = negotiation.getBindingQuote.bind(negotiation);
  let failBindingOnce = true;
  negotiation.getBindingQuote = (input) => {
    const quote = getBindingQuote(input);
    if (failBindingOnce) {
      failBindingOnce = false;
      const error = new Error("Merchant quote lookup temporarily failed.");
      error.code = "MERCHANT_UNREACHABLE";
      error.statusCode = 502;
      throw error;
    }
    return quote;
  };

  const persisted = [];
  const store = new MemoryStore(() => ({ missions: [] }));
  const app = createApplication({
    store,
    adapterOverrides: { negotiation },
    persistState: async (state) => persisted.push(structuredClone(state)),
  });
  const mission = store.get().missions[0];

  await assert.rejects(
    app.orchestrator.run(mission.id, 0),
    (error) => error.code === "MERCHANT_UNREACHABLE",
  );

  const firstReceipt = mission.payments.find((payment) => payment.network === "eip155:10143");
  const firstAudit = mission.transactions.find((transaction) => transaction.operation === "availability intelligence");
  assert.equal(mission.stepIndex, 0);
  assert.equal(mission.status, "DISCOVERING");
  assert.equal(mission.budget.spentMinor, 1);
  assert.ok(firstReceipt);
  assert.ok(firstAudit);
  assert.equal(mission.payments.filter((payment) => payment.network === "eip155:10143").length, 1);
  assert.equal(mission.transactions.filter((transaction) => transaction.operation === "availability intelligence").length, 1);
  assert.equal(persisted.at(-1).missions[0].budget.spentMinor, 1);

  await app.orchestrator.run(mission.id, 0);

  const discoveryReceipts = mission.payments.filter((payment) => payment.network === "eip155:10143");
  const discoveryAudits = mission.transactions.filter((transaction) => transaction.operation === "availability intelligence");
  assert.equal(mission.status, "COMPLETED");
  assert.equal(mission.stepIndex, 9);
  assert.equal(mission.budget.spentMinor, 976);
  assert.equal(discoveryReceipts.length, 1);
  assert.equal(discoveryAudits.length, 1);
  assert.equal(discoveryReceipts[0].receiptId, firstReceipt.receiptId);
  assert.equal(discoveryReceipts[0].transactionHash, firstReceipt.transactionHash);
  assert.equal(discoveryAudits[0].id, firstAudit.id);
  assert.equal(mission.events.filter((event) => event.title === "Availability handshake simulated").length, 1);
});

test("mission audit export returns downloadable JSON", async () => {
  await withServer(async (baseUrl) => {
    const state = await fetch(`${baseUrl}/api/state`).then((response) => response.json());
    const missionId = state.activeMissionId;
    const response = await fetch(`${baseUrl}/api/missions/${missionId}/export`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-disposition"), new RegExp(`${missionId}-audit\\.json`));
    const audit = await response.json();
    assert.equal(audit.id, missionId);
    assert.equal(audit.policy.rightsClass, "public_domain");
  });
});

test("mission creation requires explicit rights attestation", async () => {
  await withServer(async (baseUrl) => {
    const denied = await fetch(`${baseUrl}/api/missions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "No rights" }),
    });
    assert.equal(denied.status, 422);
    const deniedBody = await denied.json();
    assert.equal(deniedBody.code, "RIGHTS_ATTESTATION_REQUIRED");
    assert.match(deniedBody.message, /right to recover/i);

    const created = await fetch(`${baseUrl}/api/missions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Authorized recovery",
        rightsAttestation: true,
        rewardMinor: 700,
        totalBudgetMinor: 2500,
      }),
    });
    assert.equal(created.status, 201);
    const mission = await created.json();
    assert.equal(mission.status, "DEAD");
    assert.equal(mission.budget.rewardMinor, 700);
  });
});

test("mission API accepts supported accounting currencies and rejects token symbols", async () => {
  await withServer(async (baseUrl) => {
    const created = await fetch(`${baseUrl}/api/missions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Euro recovery",
        rightsAttestation: true,
        currency: "EUR",
        rewardMinor: 460,
        totalBudgetMinor: 1840,
      }),
    });
    assert.equal(created.status, 201);
    const mission = await created.json();
    assert.equal(mission.budget.currency, "EUR");
    assert.equal(mission.budget.totalMinor, 1840);
    assert.deepEqual(mission.negotiation.allowedCurrencies, ["EUR"]);

    const rejected = await fetch(`${baseUrl}/api/missions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Token as fiat",
        rightsAttestation: true,
        currency: "USDC",
        rewardMinor: 500,
        totalBudgetMinor: 2000,
      }),
    });
    assert.equal(rejected.status, 422);
    const problem = await rejected.json();
    assert.equal(problem.code, "CURRENCY_NOT_SUPPORTED");
    assert.deepEqual(problem.supportedCurrencies, ["USD", "EUR", "GBP", "CAD", "AUD"]);
  });
});

test("mission creation rejects a budget below the published execution reserve", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/missions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Underfunded recovery",
        rightsAttestation: true,
        rewardMinor: 100,
        totalBudgetMinor: 1200,
      }),
    });
    assert.equal(response.status, 422);
    const body = await response.json();
    assert.equal(body.error, "BUDGET_BELOW_REQUIRED_RESERVE");
    assert.equal(body.code, "BUDGET_BELOW_REQUIRED_RESERVE");
    assert.equal(body.field, "totalBudgetMinor");
    assert.equal(body.minimumBudgetMinor, 1201);
    assert.match(body.message, /\$12\.01/);
  });
});

test("mission creation accepts the exact published execution reserve", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/missions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Boundary-funded recovery",
        rightsAttestation: true,
        rewardMinor: 100,
        totalBudgetMinor: 1201,
      }),
    });
    assert.equal(response.status, 201);
    const mission = await response.json();
    assert.equal(mission.budget.totalMinor, 1201);
    assert.equal(mission.budget.rewardMinor, 100);
  });
});

test("service spend cap and provider bounty are validated as separate commitments", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/missions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Separate funding envelopes",
        rightsAttestation: true,
        rewardMinor: 2000,
        totalBudgetMinor: 1201,
      }),
    });
    assert.equal(response.status, 201);
    const mission = await response.json();
    assert.equal(mission.budget.totalMinor, 1201);
    assert.equal(mission.budget.rewardMinor, 2000);
  });
});

test("state publishes mission limits and truthful integration capabilities", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/state`);
    assert.equal(response.status, 200);
    const state = await response.json();
    assert.equal(state.system.missionCreation.minimumBudgetMinor, 1201);
    assert.equal(state.system.missionCreation.maximumBudgetMinor, 500_000);
    assert.equal(state.system.missionCreation.minimumRewardMinor, 100);
    assert.equal(state.system.missionCreation.maximumRewardMinor, 100_000);
    assert.deepEqual(state.system.missionCreation.supportedCurrencies, ["USD", "EUR", "GBP", "CAD", "AUD"]);
    assert.equal(state.system.missionCreation.currencyLimits.EUR.minimumBudgetMinor, 1105);
    assert.deepEqual(state.system.missionCreation.adapterCurrencies.rainSandbox, ["USD"]);
    assert.deepEqual(state.system.missionCreation.adapterCurrencies.monadX402Settlement, ["USDC"]);
    assert.equal(state.system.missionCreation.contentRoot, state.missions[0].contentRoot);
    assert.equal(state.system.monad.writesEnabled, false);
    assert.equal(state.system.x402.liveSettlementEnabled, false);
    assert.equal(state.system.financialExecution.mode, "local-simulation");
    assert.equal(state.system.financialExecution.realFunds, false);
    assert.equal(state.system.financialExecution.livePaymentsEnabled, false);
    assert.equal(state.system.negotiation.liveMerchantApi, false);
    assert.equal(state.system.negotiation.merchantAuthenticated, false);
    assert.equal(state.system.negotiation.merchantSignedQuotes, false);
    assert.equal(state.system.negotiation.ready, false);
    assert.equal(state.system.negotiation.communication, "in-process-structured-messages");
    assert.equal(state.system.recovery.networkedProviders, false);
    assert.equal(state.system.actors.mode, "local-simulation");
    assert.equal(state.system.actors.externalConnected, 0);
    assert.equal(state.system.actors.buyer.kind, "deterministic-policy-workflow");
    assert.equal(state.system.actors.merchant.kind, "simulated-merchant-model");
    assert.equal(state.system.actors.merchant.connected, false);
    assert.equal(state.system.actors.provider.kind, "bundled-fixture-provider");
    assert.equal(state.system.actors.verifiers.kind, "scripted-local-quorum");
    assert.equal(state.system.actors.rails.agents, false);
    assert.equal(state.system.actors.communication.externalAgentConversation, false);
    assert.equal(state.system.actors.externalRequired, 3);
    assert.ok(state.system.productionBlockers.includes("live_merchant_negotiation"));
    assert.equal(state.system.networkAccess, false);
    assert.equal(state.missions[0].principal.actorMode, "simulated");
    assert.equal(state.missions[0].provider.externalEndpoint, false);
    assert.ok(state.missions[0].verifiers.every((verifier) => verifier.actorMode === "simulated"));
    assert.equal(state.system.productionReady, false);
  });
});

test("mission creation fails closed instead of ignoring unsupported artifact metadata", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/missions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Mismatched artifact",
        rightsAttestation: true,
        rewardMinor: 500,
        totalBudgetMinor: 2000,
        contentRoot: "f".repeat(64),
        pieceCount: 24,
        license: "CC0-1.0",
      }),
    });
    assert.equal(response.status, 422);
    const body = await response.json();
    assert.equal(body.code, "CONTENT_ROOT_NOT_AVAILABLE");
    assert.equal(body.field, "contentRoot");
    assert.match(body.message, /verified bundled fixture/i);
  });
});

test("mission creation rejects out-of-range values instead of silently clamping them", async () => {
  await withServer(async (baseUrl) => {
    const invalidReward = await fetch(`${baseUrl}/api/missions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Invalid reward",
        rightsAttestation: true,
        rewardMinor: 0,
        totalBudgetMinor: 2000,
      }),
    });
    assert.equal(invalidReward.status, 422);
    assert.equal((await invalidReward.json()).code, "REWARD_OUT_OF_RANGE");

    const excessiveBudget = await fetch(`${baseUrl}/api/missions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Invalid cap",
        rightsAttestation: true,
        rewardMinor: 500,
        totalBudgetMinor: 500_001,
      }),
    });
    assert.equal(excessiveBudget.status, 422);
    assert.equal((await excessiveBudget.json()).code, "BUDGET_ABOVE_MAXIMUM");
  });
});

test("reset followed by a new run keeps the new run lock", async () => {
  await withServer(async (baseUrl) => {
    const initial = await fetch(`${baseUrl}/api/state`).then((response) => response.json());
    const missionId = initial.activeMissionId;
    const firstRun = fetch(`${baseUrl}/api/missions/${missionId}/run`, { method: "POST" });
    await new Promise((resolve) => setTimeout(resolve, 80));
    const reset = await fetch(`${baseUrl}/api/demo/reset`, { method: "POST" });
    assert.equal(reset.status, 200);

    const secondRun = fetch(`${baseUrl}/api/missions/${missionId}/run`, { method: "POST" });
    // Wait beyond the cancelled run's 420 ms delay so its finally block has
    // executed; the new run must still own the lock.
    await new Promise((resolve) => setTimeout(resolve, 520));
    const conflictingStep = await fetch(`${baseUrl}/api/missions/${missionId}/step`, { method: "POST" });
    assert.equal(conflictingStep.status, 409);

    await Promise.all([firstRun, secondRun]);
  });
});

test("a run cancelled by reset returns the fresh reset mission", async () => {
  await withServer(async (baseUrl) => {
    const initial = await fetch(`${baseUrl}/api/state`).then((response) => response.json());
    const missionId = initial.activeMissionId;
    const runningRequest = fetch(`${baseUrl}/api/missions/${missionId}/run`, { method: "POST" });
    await new Promise((resolve) => setTimeout(resolve, 80));
    await fetch(`${baseUrl}/api/demo/reset`, { method: "POST" });
    const mission = await runningRequest.then((response) => response.json());
    assert.equal(mission.id, missionId);
    assert.equal(mission.status, "DEAD");
    assert.equal(mission.stepIndex, 0);
    assert.equal(mission.running, false);
  });
});

test("local server rejects cross-site mutations", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/demo/reset`, {
      method: "POST",
      headers: {
        Origin: "https://malicious.example",
        "Sec-Fetch-Site": "cross-site",
      },
    });
    assert.equal(response.status, 403);
    const body = await response.json();
    assert.match(body.error, /Cross-site|Cross-origin/);
  });
});

test("local server accepts a legitimate same-origin mutation", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/demo/reset`, {
      method: "POST",
      headers: { Origin: baseUrl },
    });
    assert.equal(response.status, 200);
    const state = await response.json();
    assert.equal(state.missions[0].status, "DEAD");
  });
});

test("mission creation rejects JSON null instead of returning an internal error", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/missions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "null",
    });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error, "JSON_OBJECT_REQUIRED");
  });
});

test("durable deployment state can rehydrate local adapters between every mission step", async () => {
  const store = new MemoryStore(() => ({ missions: [] }));
  const app = createApplication({
    store,
    resetStateOnStart: false,
    allowRemoteHost: true,
    enableEventStream: false,
    runtime: "vercel",
  });
  store.replace(app.stateFactory());
  const missionId = store.get().activeMissionId;

  for (let step = 1; step <= 9; step += 1) {
    await rehydrateLocalAdapters(store.get(), app.adapters);
    await app.orchestrator.step(missionId);
    // Simulate JSONB serialization plus a new serverless invocation.
    store.replace(JSON.parse(JSON.stringify(store.get())));
  }

  const mission = store.get().missions[0];
  assert.equal(mission.status, "COMPLETED");
  assert.equal(mission.pieces.verified, 24);
  assert.equal(mission.seeders, 2);
  assert.equal(mission.rainCard.state, "retired");
  assert.equal(store.get().system.deployment.stateStore, "managed-postgres");
  assert.equal(store.get().system.deployment.eventTransport, "polling");
});

test("serverless mode accepts remote hosts but requires a same-origin mutation", async () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lazarus-mesh-serverless-test-"));
  const { server } = createApplication({
    dataFile: path.join(temporaryRoot, "state.json"),
    allowRemoteHost: true,
    enableEventStream: false,
    runtime: "vercel",
  });
  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const denied = await fetch(`${baseUrl}/api/demo/reset`, { method: "POST" });
    assert.equal(denied.status, 403);
    assert.match((await denied.json()).error, /same-origin/i);

    const accepted = await fetch(`${baseUrl}/api/demo/reset`, {
      method: "POST",
      headers: { Origin: baseUrl },
    });
    assert.equal(accepted.status, 200);
  } finally {
    if (server.listening) await new Promise((resolve) => server.close(resolve));
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("mission creation rejects bodies above the local size limit cleanly", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/missions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ padding: "x".repeat(1_000_000) }),
    });
    assert.equal(response.status, 413);
    assert.match((await response.json()).error, /too large/i);
  });
});

test("local mutation guard rejects a rebinding Host even when Origin matches", async () => {
  await withServer(async (baseUrl) => {
    const target = new URL(baseUrl);
    const result = await new Promise((resolve, reject) => {
      const request = http.request({
        hostname: target.hostname,
        port: target.port,
        path: "/api/demo/reset",
        method: "POST",
        headers: {
          Host: "attacker.example",
          Origin: "http://attacker.example",
        },
      }, (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => resolve({
          status: response.statusCode,
          body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
        }));
      });
      request.on("error", reject);
      request.end();
    });
    assert.equal(result.status, 403);
    assert.match(result.body.error, /Non-local mutation/);
  });
});

test("local host guard rejects rebinding reads of state", async () => {
  await withServer(async (baseUrl) => {
    const target = new URL(baseUrl);
    const result = await new Promise((resolve, reject) => {
      const request = http.request({
        hostname: target.hostname,
        port: target.port,
        path: "/api/state",
        method: "GET",
        headers: { Host: "attacker.example" },
      }, (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => resolve({
          status: response.statusCode,
          body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
        }));
      });
      request.on("error", reject);
      request.end();
    });
    assert.equal(result.status, 403);
    assert.match(result.body.error, /Non-local/);
  });
});
