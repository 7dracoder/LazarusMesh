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

test("live x402 preview cannot be combined with a remote merchant artifact", () => {
  assert.throws(
    () => vercelRuntimePolicy(liveEnv({
      MERCHANT_MODE: "remote",
      LAZARUS_STATE_KEY: "merchant-preview-v1",
    })),
    /pinned local fixture/i,
  );
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
  const remoteMerchantPolicy = vercelRuntimePolicy({
    ADAPTER_MODE: "local",
    MONAD_EXECUTION_MODE: "local",
    MERCHANT_MODE: "remote",
    LAZARUS_STATE_KEY: "merchant-demo-production-v1",
    VERCEL_ENV: "production",
    X402_SELLER_ENABLED: "false",
  });
  assert.equal(remoteMerchantPolicy.merchantMode, "remote");
  assert.equal(remoteMerchantPolicy.stateKey, "merchant-demo-production-v1");
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

test("remote merchant production requires an explicit isolated state namespace", () => {
  const base = {
    ADAPTER_MODE: "local",
    MONAD_EXECUTION_MODE: "local",
    MERCHANT_MODE: "remote",
    VERCEL_ENV: "production",
    X402_SELLER_ENABLED: "false",
  };
  for (const stateKey of [undefined, "primary", "production-v1"]) {
    assert.throws(
      () => vercelRuntimePolicy({ ...base, ...(stateKey ? { LAZARUS_STATE_KEY: stateKey } : {}) }),
      /isolated merchant-\*/i,
    );
  }
  assert.equal(vercelRuntimePolicy({
    ...base,
    LAZARUS_STATE_KEY: "merchant-demo-production-v1",
  }).stateKey, "merchant-demo-production-v1");
});

test("rain sandbox is permitted on Vercel with an isolated state namespace", () => {
  const policy = vercelRuntimePolicy({
    ADAPTER_MODE: "rain-sandbox",
    MONAD_EXECUTION_MODE: "local",
    MERCHANT_MODE: "remote",
    VERCEL_ENV: "production",
    X402_SELLER_ENABLED: "false",
    LAZARUS_STATE_KEY: "merchant-rain-live-v1",
  });
  assert.equal(policy.adapterMode, "rain-sandbox");
  assert.equal(policy.liveBuyerEnabled, false);
  assert.equal(policy.sellerEnabled, false);
  assert.equal(policy.stateKey, "merchant-rain-live-v1");
});

test("rain sandbox on Vercel refuses the default or absent state namespace", () => {
  const base = {
    ADAPTER_MODE: "rain-sandbox",
    MONAD_EXECUTION_MODE: "local",
    VERCEL_ENV: "production",
    X402_SELLER_ENABLED: "false",
  };
  for (const stateKey of [undefined, "primary"]) {
    assert.throws(
      () => vercelRuntimePolicy({ ...base, ...(stateKey ? { LAZARUS_STATE_KEY: stateKey } : {}) }),
      /isolated LAZARUS_STATE_KEY/i,
    );
  }
});

test("an unsupported adapter mode still fails closed on Vercel", () => {
  assert.throws(() => vercelRuntimePolicy({
    ADAPTER_MODE: "rain-production",
    LAZARUS_STATE_KEY: "merchant-rain-live-v1",
  }), /exactly local or rain-sandbox/i);
});
<<<<<<< Updated upstream
=======

test("the protected preview accepts a dedicated raw payer key instead of Privy", () => {
  const rawKeyEnv = liveEnv({
    PRIVY_APP_ID: "",
    PRIVY_APP_SECRET: "",
    PRIVY_PAYER_WALLET_ID: "",
    PRIVY_PAYER_ADDRESS: "",
    MONAD_PRIVATE_KEY: `0x${"11".repeat(32)}`,
  });
  const policy = vercelRuntimePolicy(rawKeyEnv);
  assert.equal(policy.liveBuyerEnabled, true);
  assert.equal(policy.signerKind, "raw-private-key");

  // A complete Privy payer still works and is still reported distinctly.
  assert.equal(vercelRuntimePolicy(liveEnv()).signerKind, "privy-server-wallet");
});

test("the protected preview rejects a missing, malformed, or ambiguous signer", () => {
  const noPrivy = {
    PRIVY_APP_ID: "",
    PRIVY_APP_SECRET: "",
    PRIVY_PAYER_WALLET_ID: "",
    PRIVY_PAYER_ADDRESS: "",
  };
  // No signer at all.
  assert.throws(
    () => vercelRuntimePolicy(liveEnv(noPrivy)),
    /needs one payer signer/i,
  );
  // A raw key that is not a 32-byte hex value.
  for (const badKey of ["not-a-key", "0x1234", `0x${"11".repeat(31)}`, `0x${"zz".repeat(32)}`]) {
    assert.throws(
      () => vercelRuntimePolicy(liveEnv({ ...noPrivy, MONAD_PRIVATE_KEY: badKey })),
      /32-byte hexadecimal private key/i,
    );
  }
  // Both signers configured leaves the active one ambiguous.
  assert.throws(
    () => vercelRuntimePolicy(liveEnv({ MONAD_PRIVATE_KEY: `0x${"11".repeat(32)}` })),
    /never both/i,
  );
});

test("a raw payer key never enables live execution outside a protected preview", () => {
  const productionish = {
    ADAPTER_MODE: "local",
    MONAD_EXECUTION_MODE: "x402-testnet",
    MONAD_PRIVATE_KEY: `0x${"11".repeat(32)}`,
    ALLOW_EXTERNAL_WRITES_ON_VERCEL: "true",
    X402_SELLER_ENABLED: "true",
    LAZARUS_STATE_KEY: "preview-x402-v1",
    VERCEL: "1",
  };
  for (const overrides of [
    { VERCEL_ENV: "production", VERCEL_TARGET_ENV: "production" },
    { VERCEL_ENV: "development", VERCEL_TARGET_ENV: "development" },
    { VERCEL_ENV: "preview", VERCEL_TARGET_ENV: "production" },
  ]) {
    assert.throws(() => vercelRuntimePolicy({ ...productionish, ...overrides }));
  }
});
>>>>>>> Stashed changes
