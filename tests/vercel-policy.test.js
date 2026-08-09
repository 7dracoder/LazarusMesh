"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  assertLivePreviewRequest,
  assertLivePreviewState,
  vercelRuntimePolicy,
} = require("../src/vercel-policy");

function liveEnv(overrides = {}) {
  return {
    VERCEL: "1",
    VERCEL_ENV: "preview",
    VERCEL_TARGET_ENV: "preview",
    VERCEL_URL: "lazarus-mesh-git-agent-preview.example.vercel.app",
    VERCEL_BRANCH_URL: "lazarus-mesh-agent-preview.example.vercel.app",
    VERCEL_GIT_COMMIT_REF: "agent/vercel-neon-deployment",
    LIVE_PREVIEW_BRANCH: "agent/vercel-neon-deployment",
    ALLOW_EXTERNAL_WRITES_ON_VERCEL: "true",
    ADAPTER_MODE: "local",
    MONAD_EXECUTION_MODE: "x402-testnet",
    LAZARUS_STATE_KEY: "preview-x402-v1",
    X402_EXPECTED_AMOUNT_ATOMIC: "10000",
    X402_MAX_PAYMENT_ATOMIC: "10000",
    X402_MAX_AUTHORIZATION_SECONDS: "300",
    MONAD_X402_CONFIRMATIONS: "6",
    X402_SELLER_ENABLED: "true",
    PRIVY_APP_ID: "app_id",
    PRIVY_APP_SECRET: "secret",
    PRIVY_PAYER_WALLET_ID: "wallet_id",
    PRIVY_PAYER_ADDRESS: "0x1111111111111111111111111111111111111111",
    ...overrides,
  };
}

test("live Monad buyer is allowed only on the explicitly armed protected preview", () => {
  const policy = vercelRuntimePolicy(liveEnv());
  assert.equal(policy.liveBuyerEnabled, true);
  assert.equal(policy.livePreviewOneShot, true);
  assert.equal(policy.stateKey, "preview-x402-v1");
});

test("production refuses live Monad even when every opt-in flag is present", () => {
  assert.throws(
    () => vercelRuntimePolicy(liveEnv({ VERCEL_ENV: "production", VERCEL_TARGET_ENV: "production" })),
    /never allowed in production/i,
  );
});

test("preview fails closed when an arming boundary is missing or weakened", () => {
  for (const overrides of [
    { VERCEL: "0" },
    { ALLOW_EXTERNAL_WRITES_ON_VERCEL: "false" },
    { VERCEL_GIT_COMMIT_REF: "main" },
    { LAZARUS_STATE_KEY: "primary" },
    { X402_MAX_PAYMENT_ATOMIC: "10001" },
    { X402_MAX_AUTHORIZATION_SECONDS: "301" },
    { MONAD_X402_CONFIRMATIONS: "5" },
    { PRIVY_APP_SECRET: "" },
    { X402_SELLER_ENABLED: "false" },
    { MONAD_PRIVATE_KEY: `0x${"11".repeat(32)}` },
  ]) {
    assert.throws(() => vercelRuntimePolicy(liveEnv(overrides)));
  }
});

test("live preview accepts only its Vercel deployment or branch host", () => {
  const policy = vercelRuntimePolicy(liveEnv());
  assert.doesNotThrow(() => assertLivePreviewRequest({
    headers: { host: "lazarus-mesh-agent-preview.example.vercel.app" },
  }, policy));
  assert.throws(() => assertLivePreviewRequest({
    headers: { host: "lazarus-mesh.vercel.app" },
  }, policy), (error) => error.code === "LIVE_PREVIEW_HOST_DENIED" && error.statusCode === 403);
});

test("live preview state is isolated to the fixed bundled mission", () => {
  const policy = vercelRuntimePolicy(liveEnv());
  assert.doesNotThrow(() => assertLivePreviewState({
    missions: [{ id: "mission_lazarus_demo" }],
  }, policy));
  assert.throws(() => assertLivePreviewState({
    missions: [{ id: "mission_lazarus_demo" }, { id: "mission_other" }],
  }, policy));
});

test("public production keeps both x402 buyer and seller local-only", () => {
  const policy = vercelRuntimePolicy({
    ADAPTER_MODE: "local",
    MONAD_EXECUTION_MODE: "local",
    VERCEL_ENV: "production",
    X402_SELLER_ENABLED: "false",
  });
  assert.equal(policy.liveBuyerEnabled, false);
  assert.equal(policy.sellerEnabled, false);
  assert.equal(policy.stateKey, "primary");
  assert.throws(() => vercelRuntimePolicy({
    ADAPTER_MODE: "local",
    MONAD_EXECUTION_MODE: "local",
    VERCEL_ENV: "production",
    X402_SELLER_ENABLED: "true",
  }));
  assert.throws(() => vercelRuntimePolicy({
    ADAPTER_MODE: "local",
    MONAD_EXECUTION_MODE: "local",
    VERCEL_ENV: "preview",
    X402_SELLER_ENABLED: "true",
  }), /only with the armed buyer/i);
});
