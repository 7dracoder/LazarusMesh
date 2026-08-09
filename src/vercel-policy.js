"use strict";

const LIVE_MODE = "x402-testnet";
const LOCAL_MODE = "local";
const DEFAULT_STATE_KEY = "primary";
const DEMO_MISSION_ID = "mission_lazarus_demo";

class VercelPolicyError extends Error {
  constructor(code, message, { statusCode = 500 } = {}) {
    super(message);
    this.name = "VercelPolicyError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

function nonempty(env, name) {
  const value = env?.[name];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function configurationError(message) {
  return new VercelPolicyError("VERCEL_LIVE_MODE_DENIED", message);
}

function strictBoolean(env, name, fallback = false) {
  const value = nonempty(env, name);
  if (value === null) return fallback;
  if (value === "true") return true;
  if (value === "false") return false;
  throw configurationError(`${name} must be exactly true or false.`);
}

function stateKey(env) {
  const value = nonempty(env, "LAZARUS_STATE_KEY") || DEFAULT_STATE_KEY;
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
    throw configurationError("LAZARUS_STATE_KEY is invalid.");
  }
  return value;
}

function positiveInteger(env, name, fallback) {
  const raw = nonempty(env, name);
  if (raw === null) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw configurationError(`${name} must be a positive integer.`);
  }
  return value;
}

function hostname(value, name) {
  if (!value || !/^[A-Za-z0-9.-]+$/.test(value)) {
    throw configurationError(`${name} must be a Vercel hostname.`);
  }
  return value.toLowerCase();
}

function vercelRuntimePolicy(env = process.env) {
  const adapterMode = nonempty(env, "ADAPTER_MODE") || LOCAL_MODE;
  if (adapterMode !== LOCAL_MODE) {
    throw configurationError("Vercel supports ADAPTER_MODE=local only; Rain sandbox credentials stay off deployed runtimes.");
  }

  const monadExecutionMode = nonempty(env, "MONAD_EXECUTION_MODE") || LOCAL_MODE;
  if (![LOCAL_MODE, LIVE_MODE].includes(monadExecutionMode)) {
    throw configurationError("MONAD_EXECUTION_MODE is unsupported on Vercel.");
  }

  const sellerEnabled = strictBoolean(env, "X402_SELLER_ENABLED", false);
  const key = stateKey(env);
  if (monadExecutionMode === LOCAL_MODE) {
    if (sellerEnabled) {
      throw configurationError("The x402 seller may run only with the armed buyer in a protected live Preview.");
    }
    return Object.freeze({
      adapterMode,
      monadExecutionMode,
      liveBuyerEnabled: false,
      livePreviewOneShot: false,
      sellerEnabled,
      stateKey: key,
      allowedHosts: [],
    });
  }

  if (nonempty(env, "VERCEL") !== "1") {
    throw configurationError("Live Monad execution is allowed only inside Vercel's protected preview runtime.");
  }
  if (nonempty(env, "VERCEL_ENV") !== "preview" || nonempty(env, "VERCEL_TARGET_ENV") !== "preview") {
    throw configurationError("Live Monad execution is never allowed in production or development deployments.");
  }
  if (!strictBoolean(env, "ALLOW_EXTERNAL_WRITES_ON_VERCEL", false)) {
    throw configurationError("ALLOW_EXTERNAL_WRITES_ON_VERCEL must explicitly arm the protected preview.");
  }
  if (!sellerEnabled) {
    throw configurationError("The live buyer requires its durable seller in the same protected preview.");
  }

  const branch = nonempty(env, "LIVE_PREVIEW_BRANCH");
  if (!branch || nonempty(env, "VERCEL_GIT_COMMIT_REF") !== branch) {
    throw configurationError("The deployment branch does not match LIVE_PREVIEW_BRANCH.");
  }
  if (key === DEFAULT_STATE_KEY || !key.startsWith("preview-")) {
    throw configurationError("Live preview payments require an isolated preview-* LAZARUS_STATE_KEY.");
  }
  if (nonempty(env, "X402_EXPECTED_AMOUNT_ATOMIC") !== "10000" || nonempty(env, "X402_MAX_PAYMENT_ATOMIC") !== "10000") {
    throw configurationError("The protected preview must pin both x402 price and cap to 10000 atomic test USDC.");
  }
  if (positiveInteger(env, "X402_MAX_AUTHORIZATION_SECONDS", 300) > 300) {
    throw configurationError("The protected preview authorization window cannot exceed 300 seconds.");
  }
  if (positiveInteger(env, "MONAD_X402_CONFIRMATIONS", 6) < 6) {
    throw configurationError("The protected preview requires at least six Monad confirmations.");
  }
  if (nonempty(env, "MONAD_PRIVATE_KEY")) {
    throw configurationError("Raw private keys are forbidden on Vercel; configure the scoped Privy signer instead.");
  }

  const privyNames = [
    "PRIVY_APP_ID",
    "PRIVY_APP_SECRET",
    "PRIVY_PAYER_WALLET_ID",
    "PRIVY_PAYER_ADDRESS",
  ];
  const missingPrivy = privyNames.filter((name) => !nonempty(env, name));
  if (missingPrivy.length) {
    throw configurationError(`The protected preview is missing ${missingPrivy.join(", ")}.`);
  }

  const allowedHosts = [nonempty(env, "VERCEL_URL"), nonempty(env, "VERCEL_BRANCH_URL")]
    .filter(Boolean)
    .map((value, index) => hostname(value, index === 0 ? "VERCEL_URL" : "VERCEL_BRANCH_URL"));
  if (!allowedHosts.length) {
    throw configurationError("The protected preview must expose a Vercel deployment or branch hostname.");
  }

  return Object.freeze({
    adapterMode,
    monadExecutionMode,
    liveBuyerEnabled: true,
    livePreviewOneShot: true,
    sellerEnabled,
    stateKey: key,
    allowedHosts: Object.freeze([...new Set(allowedHosts)]),
  });
}

function requestHost(request) {
  const raw = request?.headers?.host;
  if (typeof raw !== "string" || !raw.trim()) return null;
  try {
    return new URL(`https://${raw.trim()}`).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function assertLivePreviewRequest(request, policy) {
  if (!policy?.liveBuyerEnabled) return;
  const host = requestHost(request);
  if (!host || !policy.allowedHosts.includes(host)) {
    throw new VercelPolicyError(
      "LIVE_PREVIEW_HOST_DENIED",
      "Live Monad actions are available only on this protected Vercel preview hostname.",
      { statusCode: 403 },
    );
  }
  const forwardedHost = request?.headers?.["x-forwarded-host"];
  if (typeof forwardedHost === "string" && forwardedHost.trim()) {
    const normalizedForwardedHost = requestHost({ headers: { host: forwardedHost } });
    if (!normalizedForwardedHost || !policy.allowedHosts.includes(normalizedForwardedHost)) {
      throw new VercelPolicyError(
        "LIVE_PREVIEW_HOST_DENIED",
        "The forwarded host is not an approved protected preview hostname.",
        { statusCode: 403 },
      );
    }
  }
}

function assertLivePreviewState(state, policy) {
  if (!policy?.liveBuyerEnabled) return;
  if (
    !Array.isArray(state?.missions) ||
    state.missions.length !== 1 ||
    state.missions[0]?.id !== DEMO_MISSION_ID
  ) {
    throw configurationError("The live preview must use only the single bundled demo mission.");
  }
}

module.exports = {
  DEFAULT_STATE_KEY,
  DEMO_MISSION_ID,
  VercelPolicyError,
  assertLivePreviewRequest,
  assertLivePreviewState,
  vercelRuntimePolicy,
};
