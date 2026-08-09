"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { Readable } = require("node:stream");
const { createApplication } = require("../server");
const { MemoryStore } = require("../src/store");

class BufferedResponse {
  constructor() {
    this.statusCode = 200;
    this.headers = new Map();
    this.headersSent = false;
    this.chunks = [];
    this.done = new Promise((resolve) => { this.resolve = resolve; });
  }

  setHeader(name, value) {
    this.headers.set(String(name).toLowerCase(), value);
  }

  writeHead(statusCode, headers = {}) {
    this.statusCode = statusCode;
    for (const [name, value] of Object.entries(headers)) this.setHeader(name, value);
    this.headersSent = true;
    return this;
  }

  end(chunk) {
    if (chunk !== undefined && chunk !== null) this.chunks.push(Buffer.from(String(chunk)));
    this.headersSent = true;
    this.resolve();
    return this;
  }

  json() {
    return JSON.parse(Buffer.concat(this.chunks).toString("utf8"));
  }
}

async function request(handler, {
  method = "GET",
  url = "/api/state",
  body,
  host = "app.example",
} = {}) {
  const payload = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
  const incoming = Readable.from(payload);
  incoming.method = method;
  incoming.url = url;
  incoming.headers = {
    host,
    ...(method === "POST" ? {
      origin: `https://${host}`,
      "content-type": "application/json",
      "sec-fetch-site": "same-origin",
    } : {}),
  };
  const response = new BufferedResponse();
  await Promise.all([handler(incoming, response), response.done]);
  return response;
}

test("request handler completes a multi-currency mission without opening a socket", async () => {
  const store = new MemoryStore(() => ({ missions: [] }));
  const app = createApplication({
    store,
    allowRemoteHost: true,
    enableEventStream: false,
    runtime: "test",
  });

  const initial = await request(app.requestHandler);
  assert.equal(initial.statusCode, 200);
  assert.deepEqual(initial.json().system.missionCreation.supportedCurrencies, [
    "USD", "EUR", "GBP", "CAD", "AUD",
  ]);

  const created = await request(app.requestHandler, {
    method: "POST",
    url: "/api/missions",
    body: {
      title: "Euro handler recovery",
      rightsAttestation: true,
      currency: "EUR",
      totalBudgetMinor: 1840,
      rewardMinor: 460,
    },
  });
  assert.equal(created.statusCode, 201);
  const missionId = created.json().id;

  for (let step = 0; step < 9; step += 1) {
    const advanced = await request(app.requestHandler, {
      method: "POST",
      url: `/api/missions/${missionId}/step`,
    });
    assert.equal(advanced.statusCode, 200);
  }

  const completed = store.get().missions.find((mission) => mission.id === missionId);
  assert.equal(completed.status, "COMPLETED");
  assert.equal(completed.budget.currency, "EUR");
  assert.equal(completed.budget.spentMinor, 898);
  assert.equal(completed.rainCard.mode, "local");
  assert.equal(completed.rainCard.currency, "EUR");
  assert.ok(completed.payments.every((payment) => payment.synthetic === true));
  assert.ok(completed.transactions.every((transaction) => transaction.chainWrite !== true));
});

test("request handler rejects settlement assets as mission currencies", async () => {
  const store = new MemoryStore(() => ({ missions: [] }));
  const app = createApplication({ store, allowRemoteHost: true });
  const response = await request(app.requestHandler, {
    method: "POST",
    url: "/api/missions",
    body: {
      title: "Invalid accounting asset",
      rightsAttestation: true,
      currency: "USDC",
      totalBudgetMinor: 2000,
      rewardMinor: 500,
    },
  });
  assert.equal(response.statusCode, 422);
  assert.equal(response.json().code, "CURRENCY_NOT_SUPPORTED");
});

test("Rain sandbox mode rejects non-USD missions before any adapter call", async () => {
  let adapterCalled = false;
  const rain = {
    mode: "rain-sandbox",
    reset() {},
    async createScopedCard() { adapterCalled = true; },
  };
  const store = new MemoryStore(() => ({ missions: [] }));
  const app = createApplication({
    store,
    adapterMode: "rain-sandbox",
    adapterOverrides: { rain },
    allowRemoteHost: true,
  });
  const response = await request(app.requestHandler, {
    method: "POST",
    url: "/api/missions",
    body: {
      title: "Euro Rain sandbox mission",
      rightsAttestation: true,
      currency: "EUR",
      totalBudgetMinor: 1840,
      rewardMinor: 460,
    },
  });
  assert.equal(response.statusCode, 422);
  assert.equal(response.json().code, "RAIL_CURRENCY_UNSUPPORTED");
  assert.equal(adapterCalled, false);
});

test("reset cannot erase an unresolved Monad payment outcome", async () => {
  const store = new MemoryStore(() => ({ missions: [] }));
  const app = createApplication({ store, allowRemoteHost: true });
  store.get().missions[0].externalOperations = {
    x402Pending: { paymentId: "lazarus_x402_pending" },
  };

  const response = await request(app.requestHandler, {
    method: "POST",
    url: "/api/demo/reset",
  });
  assert.equal(response.statusCode, 409);
  assert.equal(response.json().code, "X402_RECONCILIATION_REQUIRED");
  assert.ok(store.get().missions[0].externalOperations.x402Pending);
});

test("protected live preview disables reset and arbitrary mission creation", async () => {
  const store = new MemoryStore(() => ({ missions: [] }));
  const app = createApplication({
    store,
    allowRemoteHost: true,
    livePreviewOneShot: true,
  });
  assert.ok(
    new Date(store.get().missions[0].deadline).getTime() - Date.now() >= 29 * 24 * 60 * 60 * 1000,
    "the immutable one-shot mission remains demoable beyond the default one-hour local session",
  );

  const reset = await request(app.requestHandler, {
    method: "POST",
    url: "/api/demo/reset",
  });
  assert.equal(reset.statusCode, 403);
  assert.equal(reset.json().code, "LIVE_PREVIEW_ONE_SHOT");

  const create = await request(app.requestHandler, {
    method: "POST",
    url: "/api/missions",
    body: { rightsAttestation: true },
  });
  assert.equal(create.statusCode, 403);
  assert.equal(create.json().code, "LIVE_PREVIEW_ONE_SHOT");
});

test("an unresolved x402 payment on one mission blocks every other mission before persistence", async () => {
  let persistenceCalls = 0;
  const store = new MemoryStore(() => ({ missions: [] }));
  const app = createApplication({
    store,
    persistState: async () => { persistenceCalls += 1; },
  });
  const first = store.get().missions[0];
  const second = structuredClone(first);
  second.id = "mission_other";
  first.externalOperations = {
    x402Pending: {
      receiptId: "receipt_first",
      paymentId: "payment_first",
    },
  };
  store.get().missions.push(second);

  await assert.rejects(
    () => app.internal.persistPendingX402Payment({
      missionId: second.id,
      contentRoot: second.contentRoot,
      principalId: second.principal.id,
      currency: second.budget.currency,
      receiptId: "receipt_second",
      paymentId: "payment_second",
    }),
    (error) => error.code === "X402_RECONCILIATION_REQUIRED" && error.statusCode === 409,
  );
  assert.equal(second.externalOperations, undefined);
  assert.equal(persistenceCalls, 0);
});

test("a confirmed live x402 receipt is never checkpointed before its step index", async () => {
  const snapshots = [];
  const store = new MemoryStore(() => ({ missions: [] }));
  const receiptId = "x402_monad_atomic_step";
  const paymentId = "lazarus_x402_atomic_step";
  const transactionHash = `0x${"ab".repeat(32)}`;
  const x402 = {
    mode: "monad-testnet",
    liveSettlementEnabled: true,
    async reset() {},
    async requestAvailability() { return { status: 402 }; },
    async settleAvailability({ missionId, contentRoot, payer, budgetCurrency }) {
      return {
        receiptId,
        paymentId,
        missionId,
        contentRoot,
        principalId: payer,
        budgetImpactMinor: 1,
        amountMinor: 1,
        currency: budgetCurrency,
        settlementAsset: { symbol: "USDC", amountAtomic: "10000", decimals: 6 },
        network: "eip155:10143",
        confirmations: 6,
        transactionHash,
        status: "settled",
        confirmed: true,
        synthetic: false,
        fundsMoved: true,
        chainWrite: true,
        externalEndpoint: true,
        timestamp: new Date().toISOString(),
      };
    },
  };
  const app = createApplication({
    store,
    allowRemoteHost: true,
    adapterOverrides: { x402 },
    persistState: async (state) => snapshots.push(structuredClone(state)),
  });
  const mission = store.get().missions[0];
  mission.externalOperations = {
    x402Pending: {
      receiptId,
      paymentId,
      missionId: mission.id,
      contentRoot: mission.contentRoot,
      principalId: mission.principal.id,
      currency: mission.budget.currency,
    },
  };

  const response = await request(app.requestHandler, {
    method: "POST",
    url: `/api/missions/${mission.id}/step`,
  });
  assert.equal(response.statusCode, 200);
  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0].missions[0].stepIndex, 1);
  assert.equal(snapshots[0].missions[0].payments[0].transactionHash, transactionHash);
  assert.equal(snapshots[0].missions[0].externalOperations, undefined);
});

test("application wiring reports opt-in Monad x402 writes without making the bounty live", () => {
  const store = new MemoryStore(() => ({ missions: [] }));
  const app = createApplication({
    store,
    env: {
      MONAD_EXECUTION_MODE: "x402-testnet",
      MONAD_RPC_URL: "https://testnet-rpc.monad.xyz",
      MONAD_PRIVATE_KEY: `0x${createHash("sha256").update("lazarus-mesh-test-signer").digest("hex")}`,
      MONAD_PAY_TO_ADDRESS: "0x2222222222222222222222222222222222222222",
      X402_AVAILABILITY_BASE_URL: "https://seller.example/availability/",
    },
  });

  assert.equal(app.system.x402.liveSettlementEnabled, true);
  assert.equal(app.system.monad.x402PaymentWritesEnabled, true);
  assert.equal(app.system.monad.bountyWritesEnabled, false);
  assert.equal(app.system.financialExecution.testnetTokensCanMove, true);
  assert.equal(app.system.financialExecution.realFunds, false);
});
