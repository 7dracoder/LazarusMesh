"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { privateKeyToAccount } = require("viem/accounts");
const { monadReadiness, monadX402Config } = require("../src/config");
const {
  EIP_3009_TYPES,
  MONAD_TESTNET_USDC,
  PrivyServerWalletSigner,
} = require("../src/services/privy-signer");

const FIXED_NOW = new Date("2026-08-09T12:00:00.000Z");
const PRIVATE_KEY = `0x${"12".repeat(32)}`;
const ACCOUNT = privateKeyToAccount(PRIVATE_KEY);
const PAYEE = "0x2222222222222222222222222222222222222222";
const APP_ID = "app_test";
const APP_SECRET = "fake-secret-used-only-in-unit-tests";
const WALLET_ID = "wallet_test";
const SIGNATURE_PATTERN = /^0x[0-9a-fA-F]{130}$/;

function approvedTypedData(overrides = {}) {
  const now = BigInt(Math.floor(FIXED_NOW.getTime() / 1000));
  return {
    domain: {
      name: "USDC",
      version: "2",
      chainId: 10143,
      verifyingContract: MONAD_TESTNET_USDC,
      ...overrides.domain,
    },
    types: {
      TransferWithAuthorization: EIP_3009_TYPES.map((field) => ({ ...field })),
      ...overrides.types,
    },
    primaryType: overrides.primaryType || "TransferWithAuthorization",
    message: {
      from: ACCOUNT.address,
      to: PAYEE,
      value: 10_000n,
      validAfter: 0n,
      validBefore: now + 300n,
      nonce: `0x${"ab".repeat(32)}`,
      ...overrides.message,
    },
  };
}

function makeSigner(fetchImpl, overrides = {}) {
  return new PrivyServerWalletSigner({
    appId: APP_ID,
    appSecret: APP_SECRET,
    walletId: WALLET_ID,
    address: ACCOUNT.address,
    expectedPayToAddress: PAYEE,
    maxPaymentAtomic: "10000",
    maxAuthorizationSeconds: 300,
    timeoutMs: 1000,
    apiBaseUrl: "https://api.privy.test/v1/",
    fetchImpl,
    clock: () => new Date(FIXED_NOW),
    ...overrides,
  });
}

test("Privy signer sends only approved EIP-712 data and returns a verified signature", async () => {
  let request;
  const signer = makeSigner(async (url, options) => {
    request = { url: String(url), options };
    const body = JSON.parse(options.body);
    const typedData = body.params.typed_data;
    const signature = await ACCOUNT.signTypedData({
      domain: typedData.domain,
      types: typedData.types,
      primaryType: typedData.primary_type,
      message: typedData.message,
    });
    return new Response(JSON.stringify({
      method: "eth_signTypedData_v4",
      data: { signature, encoding: "hex" },
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });

  const signature = await signer.signTypedData(approvedTypedData());

  assert.match(signature, SIGNATURE_PATTERN);
  assert.equal(request.url, `https://api.privy.test/v1/wallets/${WALLET_ID}/rpc`);
  assert.equal(request.options.method, "POST");
  assert.equal(request.options.redirect, "error");
  assert.equal(request.options.headers["privy-app-id"], APP_ID);
  assert.equal(
    Buffer.from(request.options.headers.authorization.slice("Basic ".length), "base64").toString("utf8"),
    `${APP_ID}:${APP_SECRET}`,
  );
  const sent = JSON.parse(request.options.body);
  assert.equal(sent.method, "eth_signTypedData_v4");
  assert.equal(sent.params.typed_data.primary_type, "TransferWithAuthorization");
  assert.equal(sent.params.typed_data.domain.chainId, 10143);
  assert.equal(sent.params.typed_data.message.value, "10000");
  assert.deepEqual(sent.params.typed_data.types.EIP712Domain, [
    { name: "name", type: "string" },
    { name: "version", type: "string" },
    { name: "chainId", type: "uint256" },
    { name: "verifyingContract", type: "address" },
  ]);
  assert.equal(request.options.body.includes(APP_SECRET), false);
  assert.deepEqual(Object.keys(signer), ["address"]);
});

test("Privy signer rejects out-of-policy x402 authorizations before any network request", async (t) => {
  const rejected = [
    ["wrong chain", { domain: { chainId: 143 } }],
    ["wrong contract", { domain: { verifyingContract: PAYEE } }],
    ["wrong payer", { message: { from: PAYEE } }],
    ["wrong payee", { message: { to: "0x3333333333333333333333333333333333333333" } }],
    ["over cap", { message: { value: 10_001n } }],
    ["long lived", { message: { validBefore: BigInt(Math.floor(FIXED_NOW.getTime() / 1000)) + 306n } }],
    ["wrong method", { primaryType: "Permit" }],
    ["malformed payee", { message: { to: "not-an-address" } }],
  ];

  for (const [name, overrides] of rejected) {
    await t.test(name, async () => {
      let fetchCount = 0;
      const signer = makeSigner(async () => {
        fetchCount += 1;
        throw new Error("must not fetch");
      });
      await assert.rejects(
        signer.signTypedData(approvedTypedData(overrides)),
        (error) => error.code === "PRIVY_SIGNER_POLICY_REJECTED",
      );
      assert.equal(fetchCount, 0);
    });
  }
});

test("Privy signer sanitizes API authentication failures", async () => {
  const upstreamDetail = `upstream included ${APP_SECRET}`;
  const signer = makeSigner(async () => new Response(JSON.stringify({ error: upstreamDetail }), {
    status: 401,
    headers: { "content-type": "application/json" },
  }));

  await assert.rejects(
    signer.signTypedData(approvedTypedData()),
    (error) => (
      error.code === "PRIVY_AUTH_FAILED" &&
      !error.message.includes(APP_SECRET) &&
      !error.message.includes(upstreamDetail)
    ),
  );
});

test("Privy signer rejects a signature produced by a different wallet", async () => {
  const other = privateKeyToAccount(`0x${"34".repeat(32)}`);
  const signer = makeSigner(async (_url, options) => {
    const typedData = JSON.parse(options.body).params.typed_data;
    const signature = await other.signTypedData({
      domain: typedData.domain,
      types: typedData.types,
      primaryType: typedData.primary_type,
      message: typedData.message,
    });
    return new Response(JSON.stringify({
      method: "eth_signTypedData_v4",
      data: { signature },
    }), { status: 200 });
  });

  await assert.rejects(
    signer.signTypedData(approvedTypedData()),
    (error) => error.code === "PRIVY_SIGNATURE_MISMATCH",
  );
});

test("Monad config builds the Privy account-like signer without exposing its secret", () => {
  const env = {
    PRIVY_APP_ID: APP_ID,
    PRIVY_APP_SECRET: APP_SECRET,
    PRIVY_PAYER_WALLET_ID: WALLET_ID,
    PRIVY_PAYER_ADDRESS: ACCOUNT.address,
    MONAD_PAY_TO_ADDRESS: PAYEE,
    X402_EXPECTED_AMOUNT_ATOMIC: "10000",
    X402_MAX_PAYMENT_ATOMIC: "10000",
    X402_PAYMENT_NAMESPACE: "preview-config-test",
  };

  const config = monadX402Config(env);
  assert.equal(config.privateKey, null);
  assert.equal(config.signer.address, ACCOUNT.address);
  assert.equal(typeof config.signer.signTypedData, "function");
  assert.equal(config.paymentNamespace, "preview-config-test");
  assert.equal(JSON.stringify(config).includes(APP_SECRET), false);
  assert.equal(monadReadiness(env).signerConfigured, true);
});

test("Monad config fails closed when Privy signer variables are incomplete", () => {
  assert.throws(
    () => monadX402Config({ PRIVY_APP_ID: APP_ID }),
    /Privy payer signer configuration is incomplete; missing PRIVY_APP_SECRET, PRIVY_PAYER_WALLET_ID, PRIVY_PAYER_ADDRESS/,
  );
  assert.equal(monadReadiness({ PRIVY_APP_ID: APP_ID }).signerConfigured, false);
});
