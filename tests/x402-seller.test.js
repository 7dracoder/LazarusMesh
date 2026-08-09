"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  decodePaymentRequiredHeader,
  decodePaymentResponseHeader,
  encodePaymentSignatureHeader,
} = require("@x402/core/http");
const {
  PAYMENT_IDENTIFIER,
  appendPaymentIdentifierToExtensions,
} = require("@x402/extensions/payment-identifier");
const { encodeAbiParameters, encodeEventTopics } = require("viem");
const {
  DEFAULT_AMOUNT_ATOMIC,
  DEFAULT_PROVIDER_ID,
  MONAD_TESTNET_NETWORK,
  MONAD_TESTNET_USDC,
  MonadX402Seller,
  paymentFingerprint,
} = require("../src/services/x402-seller");
const { MemoryX402SettlementStore } = require("../src/services/x402-seller-store");
const {
  MonadX402Adapter,
  TRANSFER_EVENT_ABI,
} = require("../src/services/x402-monad");

const PAYEE = "0x2222222222222222222222222222222222222222";
const PAYER = "0x1111111111111111111111111111111111111111";
const TX_HASH = `0x${"ab".repeat(32)}`;
const CONTENT_ROOT = "e0ea9e4d2e6207ea5285b7a12fee1b40d19dd85c19a0d5dfd90fdfc353408ce0";
const AVAILABILITY_BASE_URL = "https://seller.example/api/x402/availability/";
const RESOURCE_URL = `${AVAILABILITY_BASE_URL}${CONTENT_ROOT}`;
const PAYMENT_ID = "lazarus_x402_1234567890abcdef1234567890abcdef12345678";

class BufferedResponse {
  constructor() {
    this.statusCode = 200;
    this.headers = new Map();
    this.chunks = [];
  }

  writeHead(statusCode, headers = {}) {
    this.statusCode = statusCode;
    for (const [key, value] of Object.entries(headers)) {
      this.headers.set(key.toLowerCase(), value);
    }
  }

  end(chunk) {
    if (chunk !== undefined && chunk !== null) this.chunks.push(Buffer.from(String(chunk)));
  }

  header(name) {
    return this.headers.get(name.toLowerCase());
  }

  json() {
    return JSON.parse(Buffer.concat(this.chunks).toString("utf8"));
  }

  body() {
    return Buffer.concat(this.chunks);
  }
}

function request({ method = "GET", paymentHeader, path = RESOURCE_URL } = {}) {
  return {
    method,
    url: new URL(path).pathname,
    headers: {
      accept: "application/json",
      host: "seller.example",
      ...(paymentHeader ? { "payment-signature": paymentHeader } : {}),
    },
  };
}

function fakeFacilitator({ settleSuccess = true } = {}) {
  const calls = { supported: 0, verify: 0, settle: 0 };
  return {
    calls,
    async getSupported() {
      calls.supported += 1;
      return {
        kinds: [{ x402Version: 2, scheme: "exact", network: MONAD_TESTNET_NETWORK }],
        extensions: [],
        signers: {},
      };
    },
    async verify() {
      calls.verify += 1;
      return { isValid: true, payer: PAYER };
    },
    async settle() {
      calls.settle += 1;
      if (!settleSuccess) {
        return {
          success: false,
          errorReason: "transaction_failed",
          errorMessage: "Settlement failed",
          network: MONAD_TESTNET_NETWORK,
          transaction: "",
        };
      }
      return {
        success: true,
        payer: PAYER,
        transaction: TX_HASH,
        network: MONAD_TESTNET_NETWORK,
        amount: DEFAULT_AMOUNT_ATOMIC,
      };
    },
  };
}

function makeSeller(options = {}) {
  const facilitator = options.facilitatorClient || fakeFacilitator();
  const settlementStore = options.settlementStore || new MemoryX402SettlementStore();
  const seller = new MonadX402Seller({
    availabilityBaseUrl: AVAILABILITY_BASE_URL,
    payToAddress: PAYEE,
    facilitatorClient: facilitator,
    settlementStore,
    allowEphemeralStore: true,
  });
  return { facilitator, seller, settlementStore };
}

async function getRequirements(seller) {
  const response = new BufferedResponse();
  assert.equal(await seller.handle(request(), response, new URL(RESOURCE_URL)), true);
  assert.equal(response.statusCode, 402);
  return {
    response,
    required: decodePaymentRequiredHeader(response.header("payment-required")),
  };
}

function paymentPayload(required, { paymentId = PAYMENT_ID, payload = { signature: "0x1234" } } = {}) {
  const extensions = structuredClone(required.extensions);
  if (paymentId) appendPaymentIdentifierToExtensions(extensions, paymentId);
  return {
    x402Version: 2,
    resource: structuredClone(required.resource),
    accepted: structuredClone(required.accepts[0]),
    payload,
    extensions,
  };
}

test("seller refuses ephemeral idempotency storage unless a test explicitly opts in", () => {
  assert.throws(() => new MonadX402Seller({
    availabilityBaseUrl: AVAILABILITY_BASE_URL,
    payToAddress: PAYEE,
    facilitatorClient: fakeFacilitator(),
    settlementStore: new MemoryX402SettlementStore(),
  }), /must be durable/);
});

test("seller advertises one pinned Monad testnet USDC payment with required idempotency", async () => {
  const { facilitator, seller } = makeSeller();
  const { response, required } = await getRequirements(seller);

  assert.equal(response.header("cache-control"), "private, no-store");
  assert.equal(required.x402Version, 2);
  assert.equal(required.resource.url, RESOURCE_URL);
  assert.equal(required.resource.mimeType, "application/json");
  assert.equal(required.accepts.length, 1);
  assert.deepEqual(required.accepts[0], {
    scheme: "exact",
    network: MONAD_TESTNET_NETWORK,
    asset: MONAD_TESTNET_USDC,
    amount: DEFAULT_AMOUNT_ATOMIC,
    payTo: PAYEE,
    maxTimeoutSeconds: 300,
    extra: {
      name: "USDC",
      version: "2",
      assetTransferMethod: "eip3009",
    },
  });
  assert.equal(required.extensions[PAYMENT_IDENTIFIER].info.required, true);
  assert.equal(facilitator.calls.supported, 1);
  assert.equal(facilitator.calls.verify, 0);
  assert.equal(facilitator.calls.settle, 0);
});

test("seller verifies, settles, persists, and returns buyer-compatible availability", async () => {
  const { facilitator, seller, settlementStore } = makeSeller();
  const { required } = await getRequirements(seller);
  const payload = paymentPayload(required);
  const response = new BufferedResponse();

  await seller.handle(request({ paymentHeader: encodePaymentSignatureHeader(payload) }), response, new URL(RESOURCE_URL));

  assert.equal(response.statusCode, 200);
  assert.equal(facilitator.calls.verify, 1);
  assert.equal(facilitator.calls.settle, 1);
  const settlement = decodePaymentResponseHeader(response.header("payment-response"));
  assert.deepEqual(settlement, {
    success: true,
    payer: PAYER,
    transaction: TX_HASH,
    network: MONAD_TESTNET_NETWORK,
    amount: DEFAULT_AMOUNT_ATOMIC,
  });
  assert.deepEqual(response.json(), {
    availability: {
      contentRoot: CONTENT_ROOT,
      paymentId: PAYMENT_ID,
      candidateProviders: 1,
      recommendedProvider: DEFAULT_PROVIDER_ID,
      estimatedRecoverySeconds: 45,
      estimatedCostMinor: 1200,
      estimatedCostCurrency: "USD",
      confidence: 0.94,
    },
  });
  const stored = await settlementStore.get(PAYMENT_ID);
  assert.equal(stored.status, "settled");
  assert.equal(stored.contentRoot, CONTENT_ROOT);
  assert.equal(stored.fingerprint, paymentFingerprint(payload));
});

test("the existing Monad buyer completes its full protocol against the seller", async () => {
  const { facilitator, seller } = makeSeller();
  const sellerFetch = async (url, options = {}) => {
    const headers = Object.fromEntries(new Headers(options.headers || {}).entries());
    const incoming = request({
      method: options.method || "GET",
      paymentHeader: headers["payment-signature"],
      path: String(url),
    });
    incoming.headers = { ...incoming.headers, ...headers };
    const outgoing = new BufferedResponse();
    await seller.handle(incoming, outgoing, new URL(url));
    return new Response(outgoing.body(), {
      status: outgoing.statusCode,
      headers: Object.fromEntries(outgoing.headers),
    });
  };
  const signer = {
    address: PAYER,
    async signTypedData() {
      return `0x${"11".repeat(65)}`;
    },
  };
  const publicClient = {
    async getChainId() {
      return 10143;
    },
    async readContract() {
      return 1_000_000n;
    },
    async waitForTransactionReceipt() {
      return {
        status: "success",
        transactionHash: TX_HASH,
        to: MONAD_TESTNET_USDC,
        blockNumber: 123n,
        logs: [{
          address: MONAD_TESTNET_USDC,
          topics: encodeEventTopics({
            abi: TRANSFER_EVENT_ABI,
            eventName: "Transfer",
            args: { from: PAYER, to: PAYEE },
          }),
          data: encodeAbiParameters([{ type: "uint256" }], [10_000n]),
        }],
      };
    },
  };
  const buyer = new MonadX402Adapter({
    availabilityBaseUrl: AVAILABILITY_BASE_URL,
    payToAddress: PAYEE,
    signer,
    publicClient,
    fetchImpl: sellerFetch,
    confirmations: 1,
    persistPendingPayment: async () => {},
  });

  const requirement = await buyer.requestAvailability(CONTENT_ROOT, { budgetCurrency: "AUD" });
  const receipt = await buyer.settleAvailability({
    missionId: "mission-seller-integration",
    contentRoot: CONTENT_ROOT,
    payer: "principal-owner",
    budgetCurrency: "AUD",
  });

  assert.equal(requirement.status, 402);
  assert.equal(receipt.status, "settled");
  assert.equal(receipt.transactionHash, TX_HASH);
  assert.equal(receipt.paymentResponse.recommendedProvider, DEFAULT_PROVIDER_ID);
  assert.equal(receipt.paymentResponse.estimatedCostCurrency, "AUD");
  assert.equal(facilitator.calls.verify, 1);
  assert.equal(facilitator.calls.settle, 1);
});

test("an identical paid retry replays the durable receipt without another facilitator call", async () => {
  const { facilitator, seller } = makeSeller();
  const { required } = await getRequirements(seller);
  const header = encodePaymentSignatureHeader(paymentPayload(required));
  const first = new BufferedResponse();
  const replay = new BufferedResponse();

  await seller.handle(request({ paymentHeader: header }), first, new URL(RESOURCE_URL));
  await seller.handle(request({ paymentHeader: header }), replay, new URL(RESOURCE_URL));

  assert.equal(first.statusCode, 200);
  assert.equal(replay.statusCode, 200);
  assert.deepEqual(replay.json(), first.json());
  assert.deepEqual(
    decodePaymentResponseHeader(replay.header("payment-response")),
    decodePaymentResponseHeader(first.header("payment-response")),
  );
  assert.equal(facilitator.calls.verify, 1);
  assert.equal(facilitator.calls.settle, 1);
});

test("the same payment identifier cannot authorize a different signed payload", async () => {
  const { facilitator, seller } = makeSeller();
  const { required } = await getRequirements(seller);
  const first = paymentPayload(required);
  const conflicting = paymentPayload(required, { payload: { signature: "0xdifferent" } });

  await seller.handle(
    request({ paymentHeader: encodePaymentSignatureHeader(first) }),
    new BufferedResponse(),
    new URL(RESOURCE_URL),
  );
  const response = new BufferedResponse();
  await seller.handle(
    request({ paymentHeader: encodePaymentSignatureHeader(conflicting) }),
    response,
    new URL(RESOURCE_URL),
  );

  assert.equal(response.statusCode, 409);
  assert.equal(response.json().error, "X402_PAYMENT_ID_CONFLICT");
  assert.equal(facilitator.calls.verify, 1);
  assert.equal(facilitator.calls.settle, 1);
});

test("a paid request without the required payment identifier is rejected before settlement", async () => {
  const { facilitator, seller } = makeSeller();
  const { required } = await getRequirements(seller);
  const payload = paymentPayload(required, { paymentId: null });
  const response = new BufferedResponse();

  await seller.handle(
    request({ paymentHeader: encodePaymentSignatureHeader(payload) }),
    response,
    new URL(RESOURCE_URL),
  );

  assert.equal(response.statusCode, 400);
  assert.equal(response.json().error, "X402_PAYMENT_ID_REQUIRED");
  assert.equal(facilitator.calls.verify, 1);
  assert.equal(facilitator.calls.settle, 0);
});

test("an unconfirmed settlement remains blocked for operator reconciliation", async () => {
  const facilitator = fakeFacilitator({ settleSuccess: false });
  const { seller, settlementStore } = makeSeller({ facilitatorClient: facilitator });
  const { required } = await getRequirements(seller);
  const header = encodePaymentSignatureHeader(paymentPayload(required));
  const failed = new BufferedResponse();
  const retry = new BufferedResponse();

  await seller.handle(request({ paymentHeader: header }), failed, new URL(RESOURCE_URL));
  await seller.handle(request({ paymentHeader: header }), retry, new URL(RESOURCE_URL));

  assert.equal(failed.statusCode, 402);
  assert.equal(failed.json().error, "X402_SETTLEMENT_FAILED");
  assert.equal((await settlementStore.get(PAYMENT_ID)).status, "uncertain");
  assert.equal(retry.statusCode, 409);
  assert.equal(retry.json().error, "X402_RECONCILIATION_REQUIRED");
  assert.equal(facilitator.calls.verify, 1);
  assert.equal(facilitator.calls.settle, 1);
});

test("seller rejects malformed resource identities and unsupported methods", async () => {
  const { seller } = makeSeller();
  const malformed = new BufferedResponse();
  const wrongMethod = new BufferedResponse();

  assert.equal(await seller.handle(
    request({ path: "https://seller.example/api/x402/availability/short" }),
    malformed,
    new URL("https://seller.example/api/x402/availability/short"),
  ), true);
  assert.equal(malformed.statusCode, 400);
  assert.equal(malformed.json().error, "X402_CONTENT_ROOT_INVALID");

  assert.equal(await seller.handle(
    request({ method: "POST" }),
    wrongMethod,
    new URL(RESOURCE_URL),
  ), true);
  assert.equal(wrongMethod.statusCode, 405);
  assert.equal(wrongMethod.header("allow"), "GET");
});
