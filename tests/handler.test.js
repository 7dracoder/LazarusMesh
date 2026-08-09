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
