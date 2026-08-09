"use strict";

const { assertApplicationRequest, createApplication } = require("../server");
const { MemoryStore } = require("../src/store");
const { NeonStateStore, StateConflictError } = require("../src/neon-state");
const { rehydrateLocalAdapters } = require("../src/rehydrate-local");
const { migrateStateForRuntime } = require("../src/state-migrations");
const { createInternalX402SellerFetch } = require("../src/services/x402-internal-fetch");
const { MonadX402Seller } = require("../src/services/x402-seller");
const { NeonX402SettlementStore } = require("../src/services/x402-seller-store");
const {
  assertLivePreviewRequest,
  assertLivePreviewState,
  vercelRuntimePolicy,
} = require("../src/vercel-policy");

function restoreRewrittenApiUrl(request) {
  const host = typeof request.headers?.host === "string" ? request.headers.host : "localhost";
  const url = new URL(request.url || "/", `https://${host}`);
  const routedPath = url.searchParams.get("__lazarus_path");
  if (routedPath === null) return;

  const segments = routedPath.replace(/^\/+|\/+$/g, "").split("/");
  if (!segments.length || segments.some((segment) => !/^[A-Za-z0-9_-]+$/.test(segment))) {
    const error = new Error("The deployment received an invalid API route.");
    error.code = "INVALID_DEPLOYMENT_ROUTE";
    error.statusCode = 400;
    throw error;
  }

  url.searchParams.delete("__lazarus_path");
  url.searchParams.delete("path");
  const query = url.searchParams.toString();
  request.url = `/api/${segments.join("/")}${query ? `?${query}` : ""}`;
}

function createBufferedResponse(response) {
  const headers = new Map();
  const chunks = [];
  let statusCode = 200;
  let ended = false;
  return {
    get headersSent() {
      return ended;
    },
    get statusCode() {
      return statusCode;
    },
    setHeader(name, value) {
      headers.set(name, value);
    },
    getHeader(name) {
      return headers.get(name);
    },
    writeHead(nextStatusCode, nextHeaders = {}) {
      statusCode = nextStatusCode;
      for (const [name, value] of Object.entries(nextHeaders)) headers.set(name, value);
      return this;
    },
    end(chunk) {
      if (chunk !== undefined && chunk !== null) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      ended = true;
      return this;
    },
    flush() {
      response.writeHead(statusCode, Object.fromEntries(headers));
      response.end(chunks.length ? Buffer.concat(chunks) : undefined);
    },
  };
}

function adapterRehydrationScope(request) {
  if (request.method !== "POST") return null;
  const host = typeof request.headers?.host === "string" ? request.headers.host : "localhost";
  const pathname = new URL(request.url || "/", `https://${host}`).pathname;
  const match = pathname.match(/^\/api\/missions\/([^/]+)\/(step|run|blocked-purchase|negotiation)$/);
  if (!match) return null;
  return Object.freeze({
    targetMissionId: decodeURIComponent(match[1]),
    restoreTargetRecovery: match[2] === "step" || match[2] === "run",
  });
}

function createRuntime() {
  const deploymentPolicy = vercelRuntimePolicy(process.env);
  const adapterMode = deploymentPolicy.adapterMode;
  const protectedSellerHost = process.env.VERCEL_BRANCH_URL || process.env.VERCEL_URL;
  const availabilityBaseUrl = deploymentPolicy.liveBuyerEnabled
    ? `https://${protectedSellerHost}/api/x402/availability/`
    : process.env.X402_AVAILABILITY_BASE_URL;
  const runtimeEnv = {
    ...process.env,
    ...(availabilityBaseUrl ? { X402_AVAILABILITY_BASE_URL: availabilityBaseUrl } : {}),
    ...(deploymentPolicy.liveBuyerEnabled
      ? { X402_PAYMENT_NAMESPACE: deploymentPolicy.stateKey }
      : {}),
  };

  const store = new MemoryStore(() => ({ missions: [] }));
  const persistence = new NeonStateStore({
    connectionString: process.env.DATABASE_URL,
    key: deploymentPolicy.stateKey,
  });
  const x402Seller = deploymentPolicy.sellerEnabled
    ? new MonadX402Seller({
      availabilityBaseUrl,
      payToAddress: runtimeEnv.MONAD_PAY_TO_ADDRESS,
      facilitatorUrl: runtimeEnv.X402_FACILITATOR_URL,
      amountAtomic: runtimeEnv.X402_EXPECTED_AMOUNT_ATOMIC || "10000",
      maxTimeoutSeconds: Number(runtimeEnv.X402_MAX_AUTHORIZATION_SECONDS || 300),
      settlementStore: new NeonX402SettlementStore({ connectionString: process.env.DATABASE_URL }),
    })
    : null;
  const x402FetchImpl = deploymentPolicy.liveBuyerEnabled
    ? createInternalX402SellerFetch({ seller: x402Seller, availabilityBaseUrl })
    : null;
  let revision = null;
  let persistedSnapshot = null;
  const saveIfChanged = async (state) => {
    if (revision === null) throw new Error("Deployment persistence was not initialized.");
    const serialized = JSON.stringify(state);
    if (serialized === persistedSnapshot) return revision;
    revision = await persistence.save(state, revision);
    persistedSnapshot = serialized;
    return revision;
  };
  const application = createApplication({
    adapterMode,
    env: runtimeEnv,
    store,
    resetStateOnStart: false,
    allowRemoteHost: true,
    enableEventStream: false,
    runtime: "vercel",
    persistState: saveIfChanged,
    x402Seller,
    x402FetchImpl,
    livePreviewOneShot: deploymentPolicy.livePreviewOneShot,
  });
  return {
    ...application,
    deploymentPolicy,
    persistence,
    initializePersistence(snapshot) {
      revision = snapshot.revision;
      persistedSnapshot = JSON.stringify(snapshot.state);
    },
    saveIfChanged,
  };
}

function sendDeploymentProblem(response, error) {
  const statusCode = error.statusCode || 500;
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(`${JSON.stringify({
    error: error.code || "DEPLOYMENT_REQUEST_FAILED",
    message: statusCode >= 500
      ? "The deployment could not complete this request. Check Vercel function logs with the request time."
      : error.message,
  })}\n`);
}

module.exports = async function handler(request, response) {
  try {
    restoreRewrittenApiUrl(request);
    // Reject invalid hosts/origins before constructing adapters, opening Neon,
    // or re-fetching any authenticated merchant/provider state.
    assertApplicationRequest(request, { allowRemoteHost: true });
    // Keep mutable adapters and mission state request-local. Vercel can run a
    // polling GET alongside a long POST in one warm process; sharing a runtime
    // would let the GET replace the POST's in-flight state.
    const app = createRuntime();
    assertLivePreviewRequest(request, app.deploymentPolicy);
    const snapshot = await app.persistence.load(app.stateFactory);
    app.initializePersistence(snapshot);
    migrateStateForRuntime(snapshot.state, app.system);
    assertLivePreviewState(snapshot.state, app.deploymentPolicy);
    app.store.replace(snapshot.state);
    const rehydrationScope = adapterRehydrationScope(request);
    if (rehydrationScope) {
      await rehydrateLocalAdapters(app.store.get(), app.adapters, rehydrationScope);
    }

    const bufferedResponse = createBufferedResponse(response);
    await app.requestHandler(request, bufferedResponse);
    if (request.method === "POST" && bufferedResponse.statusCode < 400) {
      await app.saveIfChanged(app.store.get());
    }
    bufferedResponse.flush();
  } catch (error) {
    if (error instanceof StateConflictError) return sendDeploymentProblem(response, error);
    return sendDeploymentProblem(response, error);
  }
};
