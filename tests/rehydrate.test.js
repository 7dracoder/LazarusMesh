"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { rehydrateLocalAdapters } = require("../src/rehydrate-local");
const {
  DEFAULT_CONFIRMATIONS,
  MONAD_TESTNET_CHAIN_ID,
  MONAD_TESTNET_EXPLORER,
  MONAD_TESTNET_NETWORK,
  MONAD_TESTNET_USDC,
  MonadX402Adapter,
  paymentIdentifier,
  receiptIdentifier,
} = require("../src/services/x402-monad");

const CONTENT_ROOT = "bafy-rehydrate-root";
const MISSION_ID = "mission-rehydrate";
const PRINCIPAL_ID = "principal-rehydrate";
const PAYER = "0x1111111111111111111111111111111111111111";
const PAYEE = "0x2222222222222222222222222222222222222222";
const TX_HASH = `0x${"ab".repeat(32)}`;

function mission(overrides = {}) {
  return {
    id: MISSION_ID,
    contentRoot: CONTENT_ROOT,
    stepIndex: 1,
    manifest: { totalPieces: 24 },
    pieces: { recovered: 0, verified: 0 },
    principal: { id: PRINCIPAL_ID },
    provider: { id: "provider_atlas_archive" },
    verifiers: [
      { id: "verifier_north" },
      { id: "verifier_east" },
    ],
    budget: {
      currency: "USD",
      rewardMinor: 500,
      stakeMinor: 200,
      releasedMinor: 0,
    },
    payments: [],
    transactions: [],
    ...overrides,
  };
}

function adaptersFor(x402, { contentRoot = CONTENT_ROOT } = {}) {
  return {
    x402,
    rain: {
      mode: "local",
      reset() {},
    },
    monad: {
      reset() {},
      createBounty() {},
      claimBounty() {},
      recordAttestations() {},
      releaseTranche() {},
    },
    negotiation: {
      reset() {},
    },
    recovery: {
      reset() {},
      buildManifest() {
        return { contentRoot };
      },
      start() {},
      recoverThrough() {},
      verifyAll() {},
    },
  };
}

function confirmedReceipt() {
  return {
    receiptId: receiptIdentifier(MISSION_ID, CONTENT_ROOT),
    missionId: MISSION_ID,
    contentRoot: CONTENT_ROOT,
    principalId: PRINCIPAL_ID,
    payer: PAYER,
    payee: PAYEE,
    paymentId: paymentIdentifier(MISSION_ID, CONTENT_ROOT),
    amountMinor: 1,
    currency: "USD",
    budgetImpactMinor: 1,
    settlementAsset: {
      symbol: "USDC",
      address: MONAD_TESTNET_USDC,
      decimals: 6,
      amountAtomic: "10000",
    },
    network: MONAD_TESTNET_NETWORK,
    chainId: MONAD_TESTNET_CHAIN_ID,
    blockNumber: 123,
    confirmations: DEFAULT_CONFIRMATIONS,
    transactionHash: TX_HASH,
    explorerUrl: `${MONAD_TESTNET_EXPLORER}${TX_HASH}`,
    status: "settled",
    confirmed: true,
    synthetic: false,
    fundsMoved: true,
    chainWrite: true,
    externalEndpoint: true,
    timestamp: "2026-08-08T16:00:00.000Z",
    paymentResponse: {
      candidateProviders: 1,
      recommendedProvider: "provider_atlas_archive",
      estimatedRecoverySeconds: 45,
      estimatedCostMinor: 1200,
      estimatedCostCurrency: "USD",
      confidence: 0.94,
    },
    mode: "monad-testnet",
  };
}

function pendingPayment() {
  return {
    receiptId: receiptIdentifier(MISSION_ID, CONTENT_ROOT),
    paymentId: paymentIdentifier(MISSION_ID, CONTENT_ROOT),
    missionId: MISSION_ID,
    contentRoot: CONTENT_ROOT,
    principalId: PRINCIPAL_ID,
    payer: PAYER,
    payee: PAYEE,
    asset: MONAD_TESTNET_USDC,
    amountAtomic: "10000",
    currency: "USD",
    network: MONAD_TESTNET_NETWORK,
    mode: "monad-testnet",
    status: "reconciliation_required",
    outcome: "unknown",
    synthetic: false,
    externalEndpoint: true,
    preparedAt: "2026-08-08T16:00:00.000Z",
  };
}

test("unfinished missions fail closed when persisted x402 evidence belongs to another adapter mode", async (t) => {
  await t.test("local runtime cannot replay a live Monad receipt", async () => {
    let settlementCalls = 0;
    const x402 = {
      mode: "local",
      reset() {},
      settleAvailability() {
        settlementCalls += 1;
      },
    };
    const state = {
      missions: [mission({
        payments: [{ mode: "monad-testnet", network: MONAD_TESTNET_NETWORK }],
      })],
    };

    await assert.rejects(
      rehydrateLocalAdapters(state, adaptersFor(x402)),
      (error) => error.code === "PERSISTED_STATE_X402_MODE_MISMATCH",
    );
    assert.equal(settlementCalls, 0);
  });

  await t.test("live Monad runtime cannot reinterpret a local receipt", async () => {
    let restoreCalls = 0;
    const x402 = {
      mode: "monad-testnet",
      reset() {},
      restoreReceipts() {
        restoreCalls += 1;
      },
    };
    const state = {
      missions: [mission({
        payments: [{ mode: "local", network: MONAD_TESTNET_NETWORK }],
      })],
    };

    await assert.rejects(
      rehydrateLocalAdapters(state, adaptersFor(x402)),
      (error) => error.code === "PERSISTED_STATE_X402_MODE_MISMATCH",
    );
    assert.equal(restoreCalls, 0);
  });
});

test("a completed mission can load in live-x402 mode without requiring historical receipt reconstruction", async () => {
  const restoredBatches = [];
  const x402 = {
    mode: "monad-testnet",
    reset() {},
    restoreReceipts(receipts) {
      restoredBatches.push(structuredClone(receipts));
    },
  };
  const state = {
    missions: [mission({
      stepIndex: 9,
      payments: [],
    })],
  };

  await rehydrateLocalAdapters(state, adaptersFor(x402));

  assert.deepEqual(restoredBatches, [[]]);
});

test("rehydrating a confirmed live-x402 receipt prevents signing or paying again", async () => {
  let networkTouched = false;
  const x402 = new MonadX402Adapter({
    availabilityBaseUrl: "https://seller.example/availability/",
    payToAddress: PAYEE,
    signer: {
      address: PAYER,
      async signTypedData() {
        networkTouched = true;
        throw new Error("restored settlement must not be signed again");
      },
    },
    publicClient: {
      async getChainId() {
        networkTouched = true;
        throw new Error("restored settlement must not query the chain");
      },
      async readContract() {
        networkTouched = true;
        throw new Error("restored settlement must not query balance");
      },
      async waitForTransactionReceipt() {
        networkTouched = true;
        throw new Error("restored settlement must not query a receipt");
      },
    },
    fetchImpl: async () => {
      networkTouched = true;
      throw new Error("restored settlement must not make another paid request");
    },
    persistPendingPayment: async () => {
      networkTouched = true;
      throw new Error("restored settlement must not prepare another payment");
    },
  });
  const receipt = confirmedReceipt();
  const state = {
    missions: [mission({ payments: [receipt] })],
  };

  await rehydrateLocalAdapters(state, adaptersFor(x402));
  const replay = await x402.settleAvailability({
    missionId: MISSION_ID,
    contentRoot: CONTENT_ROOT,
    payer: PRINCIPAL_ID,
    budgetCurrency: "USD",
  });

  assert.deepEqual(replay, receipt);
  assert.equal(networkTouched, false);
});

test("rehydrating an unresolved live payment blocks another authorization", async () => {
  let networkTouched = false;
  const x402 = new MonadX402Adapter({
    availabilityBaseUrl: "https://seller.example/availability/",
    payToAddress: PAYEE,
    signer: {
      address: PAYER,
      async signTypedData() {
        networkTouched = true;
        throw new Error("pending settlement must not sign again");
      },
    },
    publicClient: {
      async getChainId() { networkTouched = true; throw new Error("no RPC"); },
      async readContract() { networkTouched = true; throw new Error("no RPC"); },
      async waitForTransactionReceipt() { networkTouched = true; throw new Error("no RPC"); },
    },
    fetchImpl: async () => { networkTouched = true; throw new Error("no fetch"); },
    persistPendingPayment: async () => { networkTouched = true; throw new Error("no write"); },
  });
  const state = {
    missions: [mission({
      stepIndex: 0,
      externalOperations: { x402Pending: pendingPayment() },
    })],
  };

  await rehydrateLocalAdapters(state, adaptersFor(x402));
  await assert.rejects(
    x402.settleAvailability({
      missionId: MISSION_ID,
      contentRoot: CONTENT_ROOT,
      payer: PRINCIPAL_ID,
      budgetCurrency: "USD",
    }),
    (error) => error.code === "X402_RECONCILIATION_REQUIRED",
  );
  assert.equal(networkTouched, false);
});
