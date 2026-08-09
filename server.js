const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { JsonStore } = require("./src/store");
const { loadEnvFile, monadNetworkConfig, monadReadiness, rainSandboxConfig } = require("./src/config");
const { LocalRainAdapter } = require("./src/services/rain-local");
const { RainSandboxAdapter } = require("./src/services/rain-sandbox");
const { LocalMonadAdapter } = require("./src/services/monad-local");
const { probeMonadNetwork } = require("./src/services/monad-network");
const { LocalX402Adapter } = require("./src/services/x402-local");
const { LocalNegotiationAdapter } = require("./src/services/negotiation-local");
const { LocalRecoveryAdapter } = require("./src/services/recovery-local");
const { createDefaultState, createMission } = require("./src/demo-state");
const { LazarusOrchestrator } = require("./src/orchestrator");

const ROOT = __dirname;
if (require.main === module) loadEnvFile(path.join(ROOT, ".env"));
const PUBLIC_ROOT = path.join(ROOT, "public");
const DATA_FILE = path.join(ROOT, ".data", "state.json");
// Intentionally fixed to loopback for this offline build.
const HOST = "127.0.0.1";
const PORT = Number(process.env.PORT || 4173);
const BODY_LIMIT = 1_000_000;

const MISSION_CREATION_POLICY = Object.freeze({
  sourceMode: "bundled-verified-fixture",
  currency: "USD",
  budgetKind: "recovery-service-spend-cap",
  exposureFormula: "service-cap-plus-provider-reward",
  minimumBudgetMinor: 1201,
  maximumBudgetMinor: 500_000,
  defaultBudgetMinor: 2000,
  minimumRewardMinor: 100,
  maximumRewardMinor: 100_000,
  defaultRewardMinor: 500,
  archiveReserveMinor: 1200,
  discoveryReserveMinor: 1,
  pieceCount: 24,
  license: "CC0-1.0",
});

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

function securityHeaders(contentType = "application/json; charset=utf-8") {
  return {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  };
}

function sendJson(response, statusCode, data) {
  response.writeHead(statusCode, securityHeaders());
  response.end(`${JSON.stringify(data)}\n`);
}

function sendApiProblem(response, statusCode, {
  code,
  message,
  field,
  details = {},
}) {
  return sendJson(response, statusCode, {
    error: code,
    code,
    message,
    ...(field ? { field } : {}),
    ...details,
  });
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let rejected = false;
    request.on("data", (chunk) => {
      if (rejected) return;
      size += chunk.length;
      if (size > BODY_LIMIT) {
        rejected = true;
        const error = new Error("Request body too large.");
        error.statusCode = 413;
        reject(error);
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (rejected) return;
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        const error = new Error("Invalid JSON body.");
        error.statusCode = 400;
        reject(error);
      }
    });
    request.on("error", reject);
  });
}

function assertLoopbackHost(request) {
  const hostHeader = request.headers.host;
  let hostname;
  try {
    hostname = new URL(`http://${hostHeader}`).hostname.toLowerCase().replace(/^\[|\]$/g, "");
  } catch {
    const error = new Error("Invalid request host.");
    error.statusCode = 403;
    throw error;
  }
  if (!["127.0.0.1", "localhost", "::1"].includes(hostname)) {
    const error = new Error("Non-local mutation blocked.");
    error.statusCode = 403;
    throw error;
  }
}

function assertRequestHost(request, { allowRemoteHost = false } = {}) {
  if (!allowRemoteHost) return assertLoopbackHost(request);
  const hostHeader = String(request.headers.host || "");
  try {
    const hostname = new URL(`https://${hostHeader}`).hostname;
    if (!hostname) throw new Error("Missing host.");
  } catch {
    const error = new Error("Invalid request host.");
    error.statusCode = 403;
    throw error;
  }
}

function assertSameOriginMutation(request, { requireOrigin = false } = {}) {
  const hostHeader = String(request.headers.host || "");
  const fetchSite = request.headers["sec-fetch-site"];
  if (fetchSite === "cross-site") {
    const error = new Error("Cross-site mutation blocked.");
    error.statusCode = 403;
    throw error;
  }
  const origin = request.headers.origin;
  if (requireOrigin && !origin) {
    const error = new Error("A same-origin browser request is required.");
    error.statusCode = 403;
    throw error;
  }
  if (origin) {
    let originHost;
    try {
      originHost = new URL(origin).host;
    } catch {
      const error = new Error("Invalid request origin.");
      error.statusCode = 403;
      throw error;
    }
    if (originHost.toLowerCase() !== hostHeader.toLowerCase()) {
      const error = new Error("Cross-origin mutation blocked.");
      error.statusCode = 403;
      throw error;
    }
  }
}

function createApplication({
  adapterMode = "local",
  env = {},
  adapterOverrides = {},
  dataFile = DATA_FILE,
  store: providedStore,
  resetStateOnStart = true,
  allowRemoteHost = false,
  enableEventStream = true,
  runtime = "local",
} = {}) {
  if (!["local", "rain-sandbox"].includes(adapterMode)) {
    throw new Error(`Unsupported ADAPTER_MODE: ${adapterMode}`);
  }
  const rain = adapterOverrides.rain || (adapterMode === "rain-sandbox"
    ? new RainSandboxAdapter(rainSandboxConfig(env))
    : new LocalRainAdapter());
  const monad = adapterOverrides.monad || new LocalMonadAdapter();
  const x402 = adapterOverrides.x402 || new LocalX402Adapter();
  const negotiation = adapterOverrides.negotiation || new LocalNegotiationAdapter();
  const recovery = adapterOverrides.recovery || new LocalRecoveryAdapter();
  const creationManifest = recovery.buildManifest(MISSION_CREATION_POLICY.pieceCount);
  const clients = new Set();
  const readiness = monadReadiness(env);
  const monadProbeConfig = monadNetworkConfig(env);
  const runMonadProbe = adapterOverrides.monadProbe || (() => probeMonadNetwork(monadProbeConfig));
  const system = {
    mode: adapterMode === "rain-sandbox" ? "hybrid-sandbox" : "local",
    rain: {
      mode: rain.mode || (adapterMode === "rain-sandbox" ? "rain-sandbox" : "local"),
      external: adapterMode === "rain-sandbox",
      sensitiveCardData: "discarded",
    },
    monad: {
      mode: "local-ledger",
      network: readiness.network,
      chainId: readiness.chainId,
      rpcConfigured: readiness.rpcConfigured,
      signerConfigured: readiness.signerConfigured,
      contractConfigured: readiness.contractConfigured,
      writesEnabled: false,
    },
    x402: {
      mode: "local-handshake",
      network: readiness.network,
      facilitatorConfigured: readiness.facilitatorConfigured,
      liveSettlementEnabled: false,
    },
    negotiation: {
      mode: negotiation.mode || "local-negotiation",
      liveMerchantApi: false,
    },
    recovery: {
      mode: "verified-local-fixture",
      networkedProviders: false,
      persistentReseeding: false,
    },
    deployment: {
      runtime,
      stateStore: providedStore ? "managed-postgres" : "local-json",
      eventTransport: enableEventStream ? "sse" : "polling",
      publicDemo: allowRemoteHost,
    },
    missionCreation: {
      ...MISSION_CREATION_POLICY,
      manifestName: creationManifest.name,
      contentRoot: creationManifest.contentRoot,
      pieceCount: creationManifest.totalPieces,
      license: creationManifest.license,
    },
    productionReady: false,
    productionBlockers: [
      ...(!readiness.signerConfigured ? ["monad_signer"] : []),
      ...(!readiness.contractConfigured ? ["monad_bounty_contract"] : []),
      ...(!readiness.payToConfigured ? ["x402_pay_to_address"] : []),
      "live_merchant_negotiation",
      "network_recovery_provider",
      "persistent_reseeding",
    ],
    orchestrator: { status: "ready" },
    paymentRails: {
      online: adapterMode === "rain-sandbox" ? 1 : 0,
      total: 3,
    },
    verifiers: { status: "local quorum" },
    networkAccess: adapterMode === "rain-sandbox" || (
      readiness.rpcConfigured && readiness.facilitatorConfigured
    ),
  };

  const stateFactory = () => createDefaultState(recovery, { system });
  const store = providedStore || new JsonStore(dataFile, stateFactory);
  const previousState = store.get();
  if (adapterMode === "rain-sandbox") {
    const unresolvedAuthority = previousState.missions?.find((mission) => (
      mission.rainCard?.mode === "rain-sandbox" &&
      ["active", "expiry_scheduled"].includes(mission.rainCard.state) &&
      new Date(mission.rainCard.expiresAt).getTime() > Date.now()
    ));
    if (unresolvedAuthority) {
      const error = new Error("Startup blocked: the prior audit snapshot contains an unexpired Rain sandbox card. Reconcile it or wait for its recorded expiry before starting a fresh session.");
      error.code = "RAIN_SANDBOX_AUTHORITY_UNRESOLVED";
      throw error;
    }
  }
  // Local CLI sessions intentionally start fresh because their demo adapter
  // ledgers are ephemeral. Serverless calls set this false and rehydrate those
  // deterministic ledgers from their durable state snapshot per request.
  if (resetStateOnStart) store.replace(stateFactory());

  function broadcast(message) {
    const payload = `event: ${message.type}\ndata: ${JSON.stringify(message.data)}\n\n`;
    for (const client of clients) client.write(payload);
  }

  const orchestrator = new LazarusOrchestrator({ store, rain, monad, x402, negotiation, recovery, broadcast });

  async function routeApi(request, response, url) {
    if (request.method === "POST") assertSameOriginMutation(request, { requireOrigin: allowRemoteHost });
    if (request.method === "GET" && url.pathname === "/api/health") {
      let rainHealth = { ok: true, mode: rain.mode || "local", authenticated: false };
      if (typeof rain.health === "function") {
        try {
          rainHealth = await rain.health();
        } catch (error) {
          rainHealth = {
            ok: false,
            mode: rain.mode || "rain-sandbox",
            error: { code: error.code || "RAIN_HEALTH_CHECK_FAILED" },
          };
        }
      }
      const probeConfigured = readiness.rpcConfigured && readiness.facilitatorConfigured;
      const monadNetwork = probeConfigured
        ? await runMonadProbe()
        : { ok: false, configured: false, caip2Network: readiness.network };
      const ok = rainHealth.ok === true && (!probeConfigured || monadNetwork.ok === true);
      return sendJson(response, ok ? 200 : 503, {
        ok,
        name: "Lazarus Mesh",
        mode: system.mode,
        networkAccess: system.networkAccess,
        adapters: {
          rain: rainHealth,
          monad: {
            execution: "local-ledger",
            writesEnabled: false,
            network: monadNetwork,
            signerConfigured: readiness.signerConfigured,
            contractConfigured: readiness.contractConfigured,
            payToConfigured: readiness.payToConfigured,
          },
          x402: {
            execution: "local-handshake",
            liveSettlementEnabled: false,
            facilitatorConfigured: readiness.facilitatorConfigured,
          },
          negotiation: { mode: negotiation.mode || "local-negotiation" },
          recovery: { mode: "real-bytes-local" },
        },
      });
    }

    if (request.method === "GET" && url.pathname === "/api/state") {
      return sendJson(response, 200, orchestrator.publicState());
    }

    if (request.method === "GET" && url.pathname === "/api/events" && !enableEventStream) {
      return sendApiProblem(response, 405, {
        code: "EVENT_STREAM_DISABLED",
        message: "This deployment uses polling for state synchronization.",
      });
    }

    if (request.method === "GET" && url.pathname === "/api/events") {
      response.writeHead(200, {
        ...securityHeaders("text/event-stream; charset=utf-8"),
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      response.write(`event: state\ndata: ${JSON.stringify(orchestrator.publicState())}\n\n`);
      clients.add(response);
      request.on("close", () => clients.delete(response));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/demo/reset") {
      const state = await orchestrator.reset(stateFactory);
      return sendJson(response, 200, state);
    }

    if (request.method === "POST" && url.pathname === "/api/missions") {
      const body = await readJson(request);
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        return sendApiProblem(response, 400, {
          code: "JSON_OBJECT_REQUIRED",
          message: "Send the mission as a JSON object.",
        });
      }
      if (body.rightsAttestation !== true) {
        return sendApiProblem(response, 422, {
          code: "RIGHTS_ATTESTATION_REQUIRED",
          message: "Confirm that you have the right to recover and reseed this artifact.",
          field: "rightsAttestation",
        });
      }
      const title = typeof body.title === "string" ? body.title.trim().slice(0, 100) : "Restore authorized dataset";
      const rewardMinor = body.rewardMinor === undefined
        ? MISSION_CREATION_POLICY.defaultRewardMinor
        : body.rewardMinor;
      const totalBudgetMinor = body.totalBudgetMinor === undefined
        ? MISSION_CREATION_POLICY.defaultBudgetMinor
        : body.totalBudgetMinor;

      if (
        !Number.isSafeInteger(rewardMinor) ||
        rewardMinor < MISSION_CREATION_POLICY.minimumRewardMinor ||
        rewardMinor > MISSION_CREATION_POLICY.maximumRewardMinor
      ) {
        return sendApiProblem(response, 422, {
          code: "REWARD_OUT_OF_RANGE",
          message: "Provider reward must be between $1.00 and $1,000.00.",
          field: "rewardMinor",
          details: {
            minimumRewardMinor: MISSION_CREATION_POLICY.minimumRewardMinor,
            maximumRewardMinor: MISSION_CREATION_POLICY.maximumRewardMinor,
          },
        });
      }

      if (!Number.isSafeInteger(totalBudgetMinor)) {
        return sendApiProblem(response, 422, {
          code: "INVALID_BUDGET_AMOUNT",
          message: "Recovery spend cap must be a valid amount in whole cents.",
          field: "totalBudgetMinor",
        });
      }

      if (totalBudgetMinor < MISSION_CREATION_POLICY.minimumBudgetMinor) {
        return sendApiProblem(response, 422, {
          code: "BUDGET_BELOW_REQUIRED_RESERVE",
          message: "Recovery spend cap must be at least $12.01: up to $12.00 for the archive quote plus $0.01 for discovery.",
          field: "totalBudgetMinor",
          details: {
            minimumBudgetMinor: MISSION_CREATION_POLICY.minimumBudgetMinor,
            archiveReserveMinor: MISSION_CREATION_POLICY.archiveReserveMinor,
            discoveryReserveMinor: MISSION_CREATION_POLICY.discoveryReserveMinor,
          },
        });
      }

      if (totalBudgetMinor > MISSION_CREATION_POLICY.maximumBudgetMinor) {
        return sendApiProblem(response, 422, {
          code: "BUDGET_ABOVE_MAXIMUM",
          message: "Recovery spend cap cannot exceed $5,000.00.",
          field: "totalBudgetMinor",
          details: { maximumBudgetMinor: MISSION_CREATION_POLICY.maximumBudgetMinor },
        });
      }

      const requestedRoot = typeof body.contentRoot === "string" ? body.contentRoot.trim().toLowerCase() : "";
      if (requestedRoot && requestedRoot !== creationManifest.contentRoot) {
        return sendApiProblem(response, 422, {
          code: "CONTENT_ROOT_NOT_AVAILABLE",
          message: "This runtime can create missions only for the verified bundled fixture. Configure a network recovery provider before using another content root.",
          field: "contentRoot",
          details: { supportedContentRoot: creationManifest.contentRoot },
        });
      }

      const requestedPieceCount = body.pieceCount ?? body.totalPieces;
      if (requestedPieceCount !== undefined && requestedPieceCount !== creationManifest.totalPieces) {
        return sendApiProblem(response, 422, {
          code: "PIECE_COUNT_NOT_SUPPORTED",
          message: `The verified bundled manifest contains exactly ${creationManifest.totalPieces} pieces.`,
          field: "pieceCount",
          details: { supportedPieceCount: creationManifest.totalPieces },
        });
      }

      if (body.license !== undefined && body.license !== creationManifest.license) {
        return sendApiProblem(response, 422, {
          code: "LICENSE_NOT_SUPPORTED",
          message: `The bundled artifact is verified under ${creationManifest.license}.`,
          field: "license",
          details: { supportedLicense: creationManifest.license },
        });
      }

      const mission = createMission({
        recovery,
        id: `mission_${randomUUID().replaceAll("-", "").slice(0, 16)}`,
        title: title || "Restore authorized dataset",
        rewardMinor,
        totalBudgetMinor,
      });
      orchestrator.addMission(mission);
      return sendJson(response, 201, mission);
    }

    const missionMatch = url.pathname.match(/^\/api\/missions\/([^/]+)\/(step|run|blocked-purchase)$/);
    if (request.method === "POST" && missionMatch) {
      const missionId = decodeURIComponent(missionMatch[1]);
      const action = missionMatch[2];
      if (action === "step") return sendJson(response, 200, await orchestrator.step(missionId));
      if (action === "run") return sendJson(response, 200, await orchestrator.run(missionId));
      return sendJson(response, 200, await orchestrator.triggerBlockedPurchase(missionId));
    }

    const negotiationMatch = url.pathname.match(/^\/api\/missions\/([^/]+)\/negotiation$/);
    if (negotiationMatch) {
      const missionId = decodeURIComponent(negotiationMatch[1]);
      if (request.method === "GET") {
        return sendJson(response, 200, orchestrator.getNegotiation(missionId));
      }
      if (request.method === "POST") {
        return sendJson(response, 200, await orchestrator.negotiate(missionId));
      }
    }

    const exportMatch = url.pathname.match(/^\/api\/missions\/([^/]+)\/export$/);
    if (request.method === "GET" && exportMatch) {
      const mission = orchestrator.getMission(decodeURIComponent(exportMatch[1]));
      response.writeHead(200, {
        ...securityHeaders("application/json; charset=utf-8"),
        "Content-Disposition": `attachment; filename="${mission.id}-audit.json"`,
      });
      return response.end(`${JSON.stringify(mission, null, 2)}\n`);
    }

    return sendJson(response, 404, { error: "API route not found." });
  }

  function serveStatic(request, response, url) {
    let pathname;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      return sendJson(response, 400, { error: "Malformed path." });
    }
    const requested = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
    const filePath = path.resolve(PUBLIC_ROOT, requested);
    if (!filePath.startsWith(`${path.resolve(PUBLIC_ROOT)}${path.sep}`) && filePath !== path.join(PUBLIC_ROOT, "index.html")) {
      return sendJson(response, 403, { error: "Forbidden." });
    }
    try {
      const stat = fs.statSync(filePath);
      if (!stat.isFile()) throw Object.assign(new Error("Not found"), { code: "ENOENT" });
      const contentType = CONTENT_TYPES[path.extname(filePath).toLowerCase()] || "application/octet-stream";
      response.writeHead(200, { ...securityHeaders(contentType), "Content-Length": stat.size });
      if (request.method === "HEAD") return response.end();
      fs.createReadStream(filePath).pipe(response);
    } catch (error) {
      if (error.code === "ENOENT") return sendJson(response, 404, { error: "Not found." });
      throw error;
    }
  }

  async function requestHandler(request, response) {
    const requestId = randomUUID();
    response.setHeader("X-Request-Id", requestId);
    try {
      assertRequestHost(request, { allowRemoteHost });
      const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
      if (url.pathname.startsWith("/api/")) await routeApi(request, response, url);
      else if (request.method === "GET" || request.method === "HEAD") serveStatic(request, response, url);
      else sendJson(response, 405, { error: "Method not allowed." });
    } catch (error) {
      if (!response.headersSent) {
        const statusCode = error.statusCode || 500;
        if (statusCode >= 500) {
          process.stderr.write(`${JSON.stringify({
            level: "error",
            timestamp: new Date().toISOString(),
            requestId,
            method: request.method,
            statusCode,
            code: error.code || "INTERNAL_SERVER_ERROR",
          })}\n`);
        }
        const clientMessage = statusCode >= 500
          ? "The server could not complete this request. Use the request ID when checking server logs."
          : (error.message || "Request failed.");
        sendJson(response, statusCode, {
          error: statusCode >= 500 ? "INTERNAL_SERVER_ERROR" : clientMessage,
          message: clientMessage,
          ...(error.code ? { code: error.code } : {}),
          requestId,
        });
      } else response.end();
    }
  }

  const server = http.createServer(requestHandler);

  server.on("close", () => {
    for (const client of clients) client.end();
    clients.clear();
  });

  return {
    server,
    requestHandler,
    orchestrator,
    store,
    stateFactory,
    adapters: { rain, monad, x402, negotiation, recovery },
  };
}

if (require.main === module) {
  const adapterMode = process.env.ADAPTER_MODE || "local";
  const { server } = createApplication({ adapterMode, env: process.env });
  server.listen(PORT, HOST, () => {
    process.stdout.write(`Lazarus Mesh (${adapterMode}): http://${HOST}:${PORT}\n`);
    process.stdout.write(adapterMode === "rain-sandbox"
      ? "Rain sandbox is live; Monad/x402 execution remains local with read-only testnet readiness checks.\n"
      : "All payment and chain execution is local.\n");
  });
}

module.exports = { createApplication };
