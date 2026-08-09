"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  decodePaymentSignatureHeader,
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
} = require("@x402/core/http");
const {
  PAYMENT_IDENTIFIER,
  declarePaymentIdentifierExtension,
  extractPaymentIdentifier,
} = require("@x402/extensions/payment-identifier");
const { encodeAbiParameters, encodeEventTopics } = require("viem");
const {
  DEFAULT_CONFIRMATIONS,
  MONAD_TESTNET_NETWORK,
  MONAD_TESTNET_USDC,
  MonadX402Adapter,
  TRANSFER_EVENT_ABI,
  paymentIdentifier,
} = require("../src/services/x402-monad");

const FIXED_NOW = new Date("2026-08-08T16:00:00.000Z");
const PAYER = "0x1111111111111111111111111111111111111111";
const PAYEE = "0x2222222222222222222222222222222222222222";
const TX_HASH = `0x${"ab".repeat(32)}`;
const CONTENT_ROOT = "bafy-test-root";
const MISSION_ID = "mission-test";
const PRINCIPAL_ID = "principal-test";
const RESOURCE_BASE = "https://seller.example/availability/";
const RESOURCE_URL = `${RESOURCE_BASE}${CONTENT_ROOT}`;

function jsonResponse(payload, status, headers = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json",
      ...headers,
    },
  });
}

function transferLog({ from = PAYER, to = PAYEE, value = 10_000n } = {}) {
  return {
    address: MONAD_TESTNET_USDC,
    topics: encodeEventTopics({
      abi: TRANSFER_EVENT_ABI,
      eventName: "Transfer",
      args: { from, to },
    }),
    data: encodeAbiParameters([{ type: "uint256" }], [value]),
  };
}

function requirement(overrides = {}) {
  return {
    scheme: "exact",
    network: MONAD_TESTNET_NETWORK,
    asset: MONAD_TESTNET_USDC,
    amount: "10000",
    payTo: PAYEE,
    maxTimeoutSeconds: 300,
    extra: {
      name: "USDC",
      version: "2",
      assetTransferMethod: "eip3009",
    },
    ...overrides,
  };
}

function paymentRequired({
  requirementOverrides = {},
  accepts,
  extensions = {
    [PAYMENT_IDENTIFIER]: declarePaymentIdentifierExtension(true),
  },
  resourceUrl = RESOURCE_URL,
} = {}) {
  return {
    x402Version: 2,
    resource: {
      url: resourceUrl,
      description: "Lazarus availability discovery",
      mimeType: "application/json",
    },
    accepts: accepts || [requirement(requirementOverrides)],
    extensions,
  };
}

function availability(paymentId, overrides = {}) {
  return {
    contentRoot: CONTENT_ROOT,
    paymentId,
    candidateProviders: 1,
    recommendedProvider: "provider_atlas_archive",
    estimatedRecoverySeconds: 45,
    estimatedCostMinor: 1200,
    estimatedCostCurrency: "USD",
    confidence: 0.94,
    ...overrides,
  };
}

function makeHarness({
  chainId = 10143,
  balance = 1_000_000n,
  required = paymentRequired(),
  transactionReceipt = {},
  paidStatus = 200,
  paidBody,
  settleResponse = {},
  paidFetchError = null,
  adapterOverrides = {},
} = {}) {
  const calls = [];
  const signatures = [];
  const receiptWaits = [];
  const pendingPayments = [];
  let signCount = 0;

  const signer = {
    address: PAYER,
    async signTypedData(typedData) {
      signCount += 1;
      signatures.push(typedData);
      return `0x${"11".repeat(65)}`;
    },
  };
  const publicClient = {
    async getChainId() {
      return chainId;
    },
    async readContract() {
      return balance;
    },
    async waitForTransactionReceipt(options) {
      receiptWaits.push(options);
      return {
        status: "success",
        transactionHash: TX_HASH,
        to: MONAD_TESTNET_USDC,
        blockNumber: 123n,
        logs: [transferLog()],
        ...transactionReceipt,
      };
    },
  };
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), options });
    const paymentHeader = options.headers["PAYMENT-SIGNATURE"];
    if (!paymentHeader) {
      return jsonResponse(
        { error: "Payment required" },
        402,
        { "PAYMENT-REQUIRED": encodePaymentRequiredHeader(required) },
      );
    }
    if (paidFetchError) throw paidFetchError;
    const decodedPayment = decodePaymentSignatureHeader(paymentHeader);
    const paymentId = extractPaymentIdentifier(decodedPayment);
    const body = paidBody === undefined ? availability(paymentId) : paidBody;
    return jsonResponse(body, paidStatus, {
      "PAYMENT-RESPONSE": encodePaymentResponseHeader({
        success: true,
        payer: PAYER,
        transaction: TX_HASH,
        network: MONAD_TESTNET_NETWORK,
        amount: "10000",
        ...settleResponse,
      }),
    });
  };

  const adapter = new MonadX402Adapter({
    availabilityBaseUrl: RESOURCE_BASE,
    payToAddress: PAYEE,
    signer,
    publicClient,
    fetchImpl,
    clock: () => new Date(FIXED_NOW),
    persistPendingPayment: async (pending) => pendingPayments.push(structuredClone(pending)),
    ...adapterOverrides,
  });

  return {
    adapter,
    calls,
    publicClient,
    pendingPayments,
    receiptWaits,
    signatures,
    get signCount() {
      return signCount;
    },
  };
}

async function preflightAndSettle(harness, overrides = {}) {
  await harness.adapter.requestAvailability(CONTENT_ROOT, {
    budgetCurrency: overrides.budgetCurrency || "USD",
  });
  return harness.adapter.settleAvailability({
    missionId: MISSION_ID,
    contentRoot: CONTENT_ROOT,
    payer: PRINCIPAL_ID,
    budgetCurrency: overrides.budgetCurrency || "USD",
  });
}

test("live Monad x402 signs one bounded EIP-3009 payment and independently verifies its transfer", async () => {
  const harness = makeHarness();

  const preflight = await harness.adapter.requestAvailability(CONTENT_ROOT, {
    budgetCurrency: "EUR",
  });
  assert.equal(preflight.status, 402);
  assert.equal(preflight.mode, "monad-testnet");
  assert.equal(preflight.payment.amountAtomic, "10000");
  assert.equal(preflight.payment.payTo, PAYEE);

  const [first, concurrent] = await Promise.all([
    harness.adapter.settleAvailability({
      missionId: MISSION_ID,
      contentRoot: CONTENT_ROOT,
      payer: PRINCIPAL_ID,
      budgetCurrency: "EUR",
    }),
    harness.adapter.settleAvailability({
      missionId: MISSION_ID,
      contentRoot: CONTENT_ROOT,
      payer: PRINCIPAL_ID,
      budgetCurrency: "EUR",
    }),
  ]);
  const replay = await harness.adapter.settleAvailability({
    missionId: MISSION_ID,
    contentRoot: CONTENT_ROOT,
    payer: PRINCIPAL_ID,
    budgetCurrency: "EUR",
  });

  assert.deepEqual(concurrent, first);
  assert.deepEqual(replay, first);
  assert.equal(harness.calls.length, 2, "one preflight and one paid request");
  assert.equal(harness.signCount, 1);
  assert.equal(harness.receiptWaits.length, 1);
  assert.deepEqual(harness.receiptWaits[0], {
    hash: TX_HASH,
    confirmations: DEFAULT_CONFIRMATIONS,
    timeout: 12_000,
  });

  const sentPayload = decodePaymentSignatureHeader(
    harness.calls[1].options.headers["PAYMENT-SIGNATURE"],
  );
  const expectedPaymentId = paymentIdentifier(MISSION_ID, CONTENT_ROOT);
  assert.equal(extractPaymentIdentifier(sentPayload), expectedPaymentId);
  assert.equal(sentPayload.accepted.network, MONAD_TESTNET_NETWORK);
  assert.equal(sentPayload.accepted.asset, MONAD_TESTNET_USDC);
  assert.equal(sentPayload.accepted.amount, "10000");
  assert.equal(sentPayload.payload.authorization.from, PAYER);
  assert.equal(sentPayload.payload.authorization.to, PAYEE);
  assert.equal(sentPayload.payload.authorization.value, "10000");

  assert.equal(first.status, "settled");
  assert.equal(first.synthetic, false);
  assert.equal(first.fundsMoved, true);
  assert.equal(first.externalEndpoint, true);
  assert.equal(first.chainWrite, true);
  assert.equal(first.currency, "EUR");
  assert.equal(first.budgetImpactMinor, 1);
  assert.equal(first.transactionHash, TX_HASH);
  assert.equal(first.blockNumber, 123);
  assert.equal(first.explorerUrl, `https://testnet.monadscan.com/tx/${TX_HASH}`);
  assert.equal(first.paymentId, expectedPaymentId);
  assert.deepEqual(first.settlementAsset, {
    symbol: "USDC",
    address: MONAD_TESTNET_USDC,
    decimals: 6,
    amountAtomic: "10000",
  });
  assert.equal(first.paymentResponse.estimatedCostCurrency, "EUR");
  assert.equal(first.paymentResponse.estimatedCostMinor, 1104);
  assert.equal(harness.signatures[0].domain.chainId, 10143);
  assert.equal(harness.signatures[0].primaryType, "TransferWithAuthorization");
  assert.equal(harness.pendingPayments.length, 1);
  assert.equal(harness.pendingPayments[0].paymentId, expectedPaymentId);
  assert.equal(harness.pendingPayments[0].status, "reconciliation_required");
});

test("payment identifiers are isolated by the durable preview namespace", async () => {
  const namespace = "preview-x402-cycle-a";
  const harness = makeHarness({ adapterOverrides: { paymentNamespace: namespace } });
  const receipt = await preflightAndSettle(harness);
  assert.equal(receipt.paymentId, paymentIdentifier(MISSION_ID, CONTENT_ROOT, namespace));
  assert.notEqual(
    receipt.paymentId,
    paymentIdentifier(MISSION_ID, CONTENT_ROOT, "preview-x402-cycle-b"),
  );
});

test("persisted live receipts rehydrate without another signature, HTTP call, or chain write", async () => {
  const source = makeHarness();
  const receipt = await preflightAndSettle(source);
  let touchedNetwork = false;
  const restored = new MonadX402Adapter({
    availabilityBaseUrl: RESOURCE_BASE,
    payToAddress: PAYEE,
    signer: {
      address: PAYER,
      async signTypedData() {
        throw new Error("must not sign during restoration");
      },
    },
    publicClient: {
      async getChainId() {
        touchedNetwork = true;
        throw new Error("must not query RPC during restoration");
      },
      async readContract() {
        touchedNetwork = true;
        throw new Error("must not query balance during restoration");
      },
      async waitForTransactionReceipt() {
        touchedNetwork = true;
        throw new Error("must not query receipt during restoration");
      },
    },
    fetchImpl: async () => {
      touchedNetwork = true;
      throw new Error("must not fetch during restoration");
    },
    persistPendingPayment: async () => {
      throw new Error("must not persist a pending payment during restoration");
    },
  });

  assert.deepEqual(restored.restoreReceipt(receipt), receipt);
  const replay = await restored.settleAvailability({
    missionId: MISSION_ID,
    contentRoot: CONTENT_ROOT,
    payer: PRINCIPAL_ID,
    budgetCurrency: "USD",
  });
  assert.deepEqual(replay, receipt);
  assert.equal(touchedNetwork, false);
});

test("settlement is refused before a fresh, verified 402 preflight", async () => {
  const harness = makeHarness();
  await assert.rejects(
    harness.adapter.settleAvailability({
      missionId: MISSION_ID,
      contentRoot: CONTENT_ROOT,
      payer: PRINCIPAL_ID,
      budgetCurrency: "USD",
    }),
    (error) => error.code === "X402_PREFLIGHT_REQUIRED" && error.statusCode === 409,
  );
  assert.equal(harness.signCount, 0);
  assert.equal(harness.calls.length, 0);
});

test("paid transmission is refused when the pending-payment gate cannot be persisted", async () => {
  const harness = makeHarness({
    adapterOverrides: {
      persistPendingPayment: async () => {
        throw new Error("durable store unavailable");
      },
    },
  });
  await harness.adapter.requestAvailability(CONTENT_ROOT);
  await assert.rejects(
    harness.adapter.settleAvailability({
      missionId: MISSION_ID,
      contentRoot: CONTENT_ROOT,
      payer: PRINCIPAL_ID,
    }),
    (error) => (
      error.code === "X402_PENDING_PAYMENT_PERSIST_FAILED" &&
      error.statusCode === 503 &&
      error.retryable === true
    ),
  );
  assert.equal(harness.signCount, 1, "an unused signature may exist, but it is never transmitted");
  assert.equal(harness.calls.length, 1);
});

test("a definitive pre-transmission signing failure creates no durable pending gate", async () => {
  const harness = makeHarness({
    adapterOverrides: {
      signer: {
        address: PAYER,
        async signTypedData() {
          throw new Error("signer unavailable");
        },
      },
    },
  });
  await harness.adapter.requestAvailability(CONTENT_ROOT);
  await assert.rejects(
    harness.adapter.settleAvailability({
      missionId: MISSION_ID,
      contentRoot: CONTENT_ROOT,
      payer: PRINCIPAL_ID,
    }),
    (error) => (
      error.code === "X402_PAYMENT_SIGNATURE_FAILED" &&
      error.statusCode === 503 &&
      error.retryable === true
    ),
  );
  assert.equal(harness.pendingPayments.length, 0);
  assert.equal(harness.calls.length, 1, "no paid request reached the seller");
});

test("payment policy rejects a wrong asset, payee, price, or missing idempotency support before signing", async (t) => {
  const cases = [
    {
      name: "asset",
      required: paymentRequired({
        requirementOverrides: { asset: "0x3333333333333333333333333333333333333333" },
      }),
      code: "X402_PAYMENT_POLICY_MISMATCH",
    },
    {
      name: "payee",
      required: paymentRequired({
        requirementOverrides: { payTo: "0x3333333333333333333333333333333333333333" },
      }),
      code: "X402_PAYMENT_POLICY_MISMATCH",
    },
    {
      name: "price",
      required: paymentRequired({ requirementOverrides: { amount: "10001" } }),
      code: "X402_PAYMENT_POLICY_MISMATCH",
    },
    {
      name: "payment identifier",
      required: paymentRequired({ extensions: {} }),
      code: "X402_IDEMPOTENCY_UNSUPPORTED",
    },
    {
      name: "optional payment identifier",
      required: paymentRequired({
        extensions: {
          [PAYMENT_IDENTIFIER]: declarePaymentIdentifierExtension(false),
        },
      }),
      code: "X402_IDEMPOTENCY_UNSUPPORTED",
    },
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const harness = makeHarness({ required: scenario.required });
      await assert.rejects(
        harness.adapter.requestAvailability(CONTENT_ROOT),
        (error) => error.code === scenario.code,
      );
      assert.equal(harness.signCount, 0);
      assert.equal(harness.calls.length, 1);
    });
  }
});

test("wrong RPC chain and insufficient test-USDC balance fail closed before signing", async (t) => {
  await t.test("wrong chain", async () => {
    const harness = makeHarness({ chainId: 1 });
    await assert.rejects(
      harness.adapter.requestAvailability(CONTENT_ROOT),
      (error) => error.code === "MONAD_CHAIN_ID_MISMATCH",
    );
    assert.equal(harness.calls.length, 0);
    assert.equal(harness.signCount, 0);
  });

  await t.test("insufficient balance", async () => {
    const harness = makeHarness({ balance: 9_999n });
    await harness.adapter.requestAvailability(CONTENT_ROOT);
    await assert.rejects(
      harness.adapter.settleAvailability({
        missionId: MISSION_ID,
        contentRoot: CONTENT_ROOT,
        payer: PRINCIPAL_ID,
      }),
      (error) => error.code === "X402_INSUFFICIENT_TEST_USDC",
    );
    assert.equal(harness.calls.length, 1);
    assert.equal(harness.signCount, 0);
  });
});

test("a settlement header is not trusted without the exact confirmed USDC Transfer log", async () => {
  const harness = makeHarness({
    transactionReceipt: {
      logs: [transferLog({ to: "0x3333333333333333333333333333333333333333" })],
    },
  });
  await harness.adapter.requestAvailability(CONTENT_ROOT);
  await assert.rejects(
    harness.adapter.settleAvailability({
      missionId: MISSION_ID,
      contentRoot: CONTENT_ROOT,
      payer: PRINCIPAL_ID,
    }),
    (error) => (
      error.code === "X402_TRANSACTION_RECEIPT_INVALID" &&
      error.fundsMoved === true &&
      error.transactionHash === TX_HASH
    ),
  );
  assert.equal(harness.signCount, 1);
  assert.equal(harness.calls.length, 2);
});

test("an unknown settlement outcome tombstones the payment and blocks another authorization", async () => {
  const harness = makeHarness({
    paidFetchError: new Error("connection dropped after payment submission"),
  });
  await harness.adapter.requestAvailability(CONTENT_ROOT);

  await assert.rejects(
    harness.adapter.settleAvailability({
      missionId: MISSION_ID,
      contentRoot: CONTENT_ROOT,
      payer: PRINCIPAL_ID,
    }),
    (error) => (
      error.code === "X402_SETTLEMENT_OUTCOME_UNKNOWN" &&
      error.outcomeUnknown === true &&
      error.retryable === false
    ),
  );

  // A UI/demo reset is not evidence that the signed authorization was unused.
  harness.adapter.reset();
  await assert.rejects(
    harness.adapter.settleAvailability({
      missionId: MISSION_ID,
      contentRoot: CONTENT_ROOT,
      payer: PRINCIPAL_ID,
    }),
    (error) => (
      error.code === "X402_RECONCILIATION_REQUIRED" &&
      error.outcomeUnknown === true &&
      error.statusCode === 409
    ),
  );

  const payload = decodePaymentSignatureHeader(
    harness.calls[1].options.headers["PAYMENT-SIGNATURE"],
  );
  assert.equal(harness.signCount, 1);
  assert.equal(harness.calls.length, 2);
  assert.equal(
    extractPaymentIdentifier(payload),
    paymentIdentifier(MISSION_ID, CONTENT_ROOT),
  );
});

test("a persisted pending-payment tombstone survives adapter reconstruction", async () => {
  const source = makeHarness({
    paidFetchError: new Error("connection dropped after payment submission"),
  });
  await source.adapter.requestAvailability(CONTENT_ROOT);
  await assert.rejects(
    source.adapter.settleAvailability({
      missionId: MISSION_ID,
      contentRoot: CONTENT_ROOT,
      payer: PRINCIPAL_ID,
    }),
    (error) => error.code === "X402_SETTLEMENT_OUTCOME_UNKNOWN",
  );

  const restored = makeHarness();
  restored.adapter.restorePendingPayment(source.pendingPayments[0]);
  await assert.rejects(
    restored.adapter.settleAvailability({
      missionId: MISSION_ID,
      contentRoot: CONTENT_ROOT,
      payer: PRINCIPAL_ID,
    }),
    (error) => error.code === "X402_RECONCILIATION_REQUIRED",
  );
  assert.equal(restored.signCount, 0);
  assert.equal(restored.calls.length, 0);
});

test("restored receipt integrity checks reject a changed transaction identity", async () => {
  const source = makeHarness();
  const receipt = await preflightAndSettle(source);
  const target = makeHarness().adapter;

  assert.throws(
    () => target.restoreReceipt({
      ...receipt,
      transactionHash: `0x${"cd".repeat(32)}`,
    }),
    (error) => error.code === "X402_INVALID_RESTORED_RECEIPT",
  );
  assert.throws(
    () => target.restoreReceipt({
      ...receipt,
      amountMinor: receipt.amountMinor + 1,
      budgetImpactMinor: receipt.budgetImpactMinor + 1,
    }),
    (error) => error.code === "X402_INVALID_RESTORED_RECEIPT",
  );
});
