const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { JsonStore } = require("./src/store");
const {
  loadEnvFile,
  merchantRemoteConfig,
  monadNetworkConfig,
  monadReadiness,
  monadX402Config,
  rainSandboxConfig,
} = require("./src/config");
const { LocalRainAdapter } = require("./src/services/rain-local");
const { RainSandboxAdapter } = require("./src/services/rain-sandbox");
const { LocalMonadAdapter } = require("./src/services/monad-local");
const { probeMonadNetwork } = require("./src/services/monad-network");
const { LocalX402Adapter } = require("./src/services/x402-local");
const { MonadX402Adapter } = require("./src/services/x402-monad");
const { LocalNegotiationAdapter } = require("./src/services/negotiation-local");
const { RemoteNegotiationAdapter } = require("./src/services/negotiation-remote");
const { LocalRecoveryAdapter } = require("./src/services/recovery-local");
const { RemoteRecoveryAdapter } = require("./src/services/recovery-remote");
const {
  LIVE_PREVIEW_MISSION_LIFETIME_MS,
  createDefaultState,
  createMission,
} = require("./src/demo-state");
const { LazarusOrchestrator } = require("./src/orchestrator");
const { potentiallyLiveRainSandboxCard } = require("./src/domain/authority");
const {
  RATE_SET_ID,
  currencyInfo,
  fromAccountingMinorUp,
  maximumDisplayMinor,
  minimumDisplayMinor,
  normalizeCurrency,
  publicCurrencyConfig,
} = require("./src/domain/currency");

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
  currencyConfig: publicCurrencyConfig(),
});

function missionCurrencyLimits(currency) {
  return {
    minimumBudgetMinor: minimumDisplayMinor(MISSION_CREATION_POLICY.minimumBudgetMinor, currency),
    maximumBudgetMinor: maximumDisplayMinor(MISSION_CREATION_POLICY.maximumBudgetMinor, currency),
    defaultBudgetMinor: fromAccountingMinorUp(MISSION_CREATION_POLICY.defaultBudgetMinor, currency),
    minimumRewardMinor: minimumDisplayMinor(MISSION_CREATION_POLICY.minimumRewardMinor, currency),
    maximumRewardMinor: maximumDisplayMinor(MISSION_CREATION_POLICY.maximumRewardMinor, currency),
    defaultRewardMinor: fromAccountingMinorUp(MISSION_CREATION_POLICY.defaultRewardMinor, currency),
    archiveReserveMinor: fromAccountingMinorUp(MISSION_CREATION_POLICY.archiveReserveMinor, currency),
    discoveryReserveMinor: fromAccountingMinorUp(MISSION_CREATION_POLICY.discoveryReserveMinor, currency),
  };
}

function formatMinor(amountMinor, currency) {
  const info = currencyInfo(currency);
  if (!info || !Number.isSafeInteger(amountMinor)) return `${amountMinor} ${currency}`;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    minimumFractionDigits: info.minorDigits,
    maximumFractionDigits: info.minorDigits,
  }).format(amountMinor / (10 ** info.minorDigits));
}

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

function assertApplicationRequest(request, { allowRemoteHost = false } = {}) {
  assertRequestHost(request, { allowRemoteHost });
  if (request.method === "POST") {
    assertSameOriginMutation(request, { requireOrigin: allowRemoteHost });
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
  persistState = async () => {},
  x402Seller = null,
  x402FetchImpl = null,
  livePreviewOneShot = false,
} = {}) {
  if (!["local", "rain-sandbox"].includes(adapterMode)) {
    throw new Error(`Unsupported ADAPTER_MODE: ${adapterMode}`);
  }
  const configuredMonadExecution = env.MONAD_EXECUTION_MODE || "local";
  if (!["local", "x402-testnet"].includes(configuredMonadExecution)) {
    throw new Error(`Unsupported MONAD_EXECUTION_MODE: ${configuredMonadExecution}`);
  }
  if (x402Seller !== null && typeof x402Seller?.handle !== "function") {
    throw new Error("The x402 seller must expose handle().");
  }
  if (x402FetchImpl !== null && typeof x402FetchImpl !== "function") {
    throw new Error("The x402 fetch implementation must be a function.");
  }
  const remoteMerchantConfig = merchantRemoteConfig(env);
  if (remoteMerchantConfig && configuredMonadExecution === "x402-testnet") {
    throw new Error("Remote merchant mode cannot share the current pinned local x402 testnet seller.");
  }
  let store;
  const persistPendingX402Payment = async (pending) => {
    if (!store) throw new Error("Mission state is not initialized.");
    const mission = store.get().missions?.find((item) => item.id === pending.missionId);
    if (
      !mission ||
      mission.contentRoot !== pending.contentRoot ||
      mission.principal?.id !== pending.principalId ||
      mission.budget?.currency !== pending.currency
    ) {
      const error = new Error("The x402 payment does not match the durable mission context.");
      error.code = "X402_PENDING_PAYMENT_CONTEXT_MISMATCH";
      error.statusCode = 409;
      throw error;
    }
    const unresolved = store.get().missions?.find((item) => item.externalOperations?.x402Pending);
    if (unresolved) {
      const error = new Error("An x402 payment is already awaiting reconciliation.");
      error.code = "X402_RECONCILIATION_REQUIRED";
      error.statusCode = 409;
      throw error;
    }
    mission.externalOperations ||= {};
    mission.externalOperations.x402Pending = structuredClone(pending);
    store.save();
    await persistState(store.get());
  };
  const rain = adapterOverrides.rain || (adapterMode === "rain-sandbox"
    ? new RainSandboxAdapter(rainSandboxConfig(env))
    : new LocalRainAdapter());
  const monad = adapterOverrides.monad || new LocalMonadAdapter();
  const negotiation = adapterOverrides.negotiation || (remoteMerchantConfig
    ? new RemoteNegotiationAdapter(remoteMerchantConfig)
    : new LocalNegotiationAdapter());
  const recovery = adapterOverrides.recovery || (remoteMerchantConfig
    ? new RemoteRecoveryAdapter(remoteMerchantConfig)
    : new LocalRecoveryAdapter());
  const providerProfile = recovery.provider || negotiation.provider || {
    providerId: "provider_atlas_archive",
    providerName: "Atlas Archive Node",
  };
  const x402 = adapterOverrides.x402 || (configuredMonadExecution === "x402-testnet"
    ? new MonadX402Adapter({
      ...monadX402Config(env),
      ...(x402FetchImpl ? { fetchImpl: x402FetchImpl } : {}),
      persistPendingPayment: persistPendingX402Payment,
    })
    : new LocalX402Adapter({ providerId: providerProfile.providerId }));
  const creationManifest = recovery.buildManifest();
  const clients = new Set();
  const readiness = monadReadiness(env);
  const x402Live = x402.mode === "monad-testnet" && x402.liveSettlementEnabled === true;
  const monadProbeConfig = monadNetworkConfig(env);
  const runMonadProbe = adapterOverrides.monadProbe || (() => probeMonadNetwork(monadProbeConfig));
  const liveMerchantApi = negotiation.liveMerchantApi === true;
  const merchantAuthenticated = liveMerchantApi && negotiation.merchantAuthenticated === true;
  const merchantSignedQuotes = liveMerchantApi && negotiation.merchantSignedQuotes === true;
  const merchantReady = liveMerchantApi && merchantAuthenticated && merchantSignedQuotes;
  const networkedProviders = recovery.networkedProviders === true;
  const persistentReseeding = recovery.persistentReseeding === true;
  const externalVerifierNetwork = false;
  const merchantProfile = negotiation.merchant || {
    merchantId: "merchant_atlas_archive",
    merchantName: "Atlas Archive Cloud",
  };
  const supportedCurrencies = MISSION_CREATION_POLICY.currencyConfig.supported
    .map((item) => item.code)
    .filter((currency) => (
      (!Array.isArray(negotiation.supportedCurrencies) || negotiation.supportedCurrencies.includes(currency))
      && (!Array.isArray(recovery.supportedCurrencies) || recovery.supportedCurrencies.includes(currency))
    ));
  if (!supportedCurrencies.length) throw new Error("Merchant and recovery adapters share no supported currency.");
  const system = {
    mode: liveMerchantApi || networkedProviders
      ? "hybrid-external-demo"
      : adapterMode === "rain-sandbox" || x402Live ? "hybrid-sandbox" : "local",
    rain: {
      mode: rain.mode || (adapterMode === "rain-sandbox" ? "rain-sandbox" : "local"),
      external: adapterMode === "rain-sandbox",
      sensitiveCardData: "discarded",
    },
    monad: {
      mode: x402Live ? "testnet-x402-plus-local-bounty" : "local-ledger",
      network: readiness.network,
      chainId: readiness.chainId,
      rpcConfigured: readiness.rpcConfigured,
      signerConfigured: readiness.signerConfigured,
      contractConfigured: readiness.contractConfigured,
      writesEnabled: x402Live,
      bountyWritesEnabled: false,
      x402PaymentWritesEnabled: x402Live,
    },
    x402: {
      mode: x402Live ? "monad-testnet" : "local-handshake",
      network: readiness.network,
      facilitatorConfigured: readiness.facilitatorConfigured,
      resourceConfigured: readiness.resourceConfigured,
      liveSettlementEnabled: x402Live,
      sellerEnabled: x402Seller !== null,
    },
    negotiation: {
      mode: negotiation.mode || "local-negotiation",
      liveMerchantApi,
      merchantAuthenticated,
      merchantSignedQuotes,
      ready: merchantReady,
      bountyMessaging: negotiation.bountyMessaging === true,
      communication: merchantReady
        ? "authenticated-https"
        : liveMerchantApi
          ? "external-https-untrusted"
          : "in-process-structured-messages",
    },
    recovery: {
      mode: networkedProviders ? "external-provider-api" : "verified-local-fixture",
      networkedProviders,
      persistentReseeding,
    },
    actors: {
      mode: liveMerchantApi || networkedProviders ? "hybrid" : "local-simulation",
      externalConnected: [merchantReady, networkedProviders, externalVerifierNetwork].filter(Boolean).length,
      externalRequired: 3,
      buyer: {
        id: "lazarus_buyer_policy",
        name: "Lazarus buyer policy",
        role: "buyer-orchestrator",
        kind: "deterministic-policy-workflow",
        simulated: true,
        connected: true,
        externalEndpoint: false,
        generativeChat: false,
      },
      merchant: {
        id: merchantProfile.merchantId,
        name: merchantProfile.merchantName,
        role: "seller",
        kind: liveMerchantApi ? "external-merchant-api" : "simulated-merchant-model",
        simulated: !liveMerchantApi,
        connected: liveMerchantApi,
        ready: merchantReady,
        authenticated: merchantAuthenticated,
        signedQuotes: merchantSignedQuotes,
        externalEndpoint: liveMerchantApi,
        ...(liveMerchantApi && negotiation.baseUrl
          ? { consoleUrl: negotiation.baseUrl.href }
          : {}),
      },
      provider: {
        id: providerProfile.providerId,
        name: providerProfile.providerName,
        role: "fulfillment-provider",
        kind: networkedProviders ? "external-provider-api" : "bundled-fixture-provider",
        simulated: !networkedProviders,
        connected: networkedProviders,
        externalEndpoint: networkedProviders,
      },
      verifiers: {
        names: ["North Verifier", "East Verifier", "West Verifier"],
        role: "verification-quorum",
        kind: externalVerifierNetwork ? "external-verifier-network" : "scripted-local-quorum",
        simulated: !externalVerifierNetwork,
        connected: externalVerifierNetwork,
        externalEndpoint: externalVerifierNetwork,
      },
      rails: {
        names: ["Rain", "Monad", "x402"],
        role: "payment-and-coordination-infrastructure",
        agents: false,
      },
      communication: {
        transport: merchantReady
          ? "authenticated-https"
          : liveMerchantApi
            ? "external-https-untrusted"
            : "in-process-method-calls",
        structuredMessages: true,
        externalAgentConversation: merchantReady,
        freeFormChat: false,
      },
    },
    deployment: {
      runtime,
      stateStore: providedStore ? "managed-postgres" : "local-json",
      eventTransport: enableEventStream ? "sse" : "polling",
      publicDemo: allowRemoteHost,
    },
    missionCreation: {
      ...MISSION_CREATION_POLICY,
      sourceMode: networkedProviders ? "sponsor-pinned-remote-provider-manifest" : MISSION_CREATION_POLICY.sourceMode,
      currencyRateSet: RATE_SET_ID,
      supportedCurrencies,
      currencyLimits: Object.fromEntries(
        supportedCurrencies.map((currency) => [currency, missionCurrencyLimits(currency)]),
      ),
      adapterCurrencies: {
        local: MISSION_CREATION_POLICY.currencyConfig.supported.map((item) => item.code),
        merchantProvider: supportedCurrencies,
        rainSandbox: ["USD"],
        monadX402Settlement: ["USDC"],
      },
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
      ...(!readiness.resourceConfigured ? ["x402_resource_url"] : []),
      ...(!merchantReady ? ["live_merchant_negotiation"] : []),
      ...(!networkedProviders ? ["network_recovery_provider"] : []),
      ...(!persistentReseeding ? ["persistent_reseeding"] : []),
    ],
    orchestrator: { status: "ready" },
    paymentRails: {
      online: (adapterMode === "rain-sandbox" ? 1 : 0) + (x402Live ? 1 : 0),
      total: 3,
    },
    financialExecution: {
      mode: x402Live
        ? "monad-testnet-x402-plus-local-simulation"
        : adapterMode === "rain-sandbox"
          ? "rain-external-sandbox-simulation"
          : "local-simulation",
      realFunds: false,
      testnetTokensCanMove: x402Live,
      chainWrites: x402Live,
      livePaymentsEnabled: x402Live,
      externalPaymentRequests: adapterMode === "rain-sandbox" || x402Live,
    },
    verifiers: { status: "local quorum" },
    networkAccess: adapterMode === "rain-sandbox" || x402Live || liveMerchantApi || networkedProviders || (
      readiness.rpcConfigured && readiness.facilitatorConfigured
    ),
  };

  const stateFactory = () => createDefaultState(recovery, {
    system,
    negotiation,
    ...(livePreviewOneShot ? { missionLifetimeMs: LIVE_PREVIEW_MISSION_LIFETIME_MS } : {}),
  });
  store = providedStore || new JsonStore(dataFile, stateFactory);
  const previousState = store.get();
  const unresolvedAuthority = previousState.missions?.find((mission) => (
    potentiallyLiveRainSandboxCard(mission.rainCard)
  ));
  if (unresolvedAuthority) {
    const error = new Error("Startup blocked: the prior audit snapshot contains Rain sandbox authority that is unexpired or has an unknown expiry. Reconcile it or wait for its recorded expiry before starting a fresh session.");
    error.code = "RAIN_SANDBOX_AUTHORITY_UNRESOLVED";
    throw error;
  }
  const unresolvedMonadPayment = previousState.missions?.find((mission) => (
    mission.externalOperations?.x402Pending
  ));
  if (unresolvedMonadPayment) {
    if (resetStateOnStart) {
      const error = new Error("Startup blocked: the prior audit snapshot contains an unresolved Monad x402 payment. Reconcile its payment identifier before starting a fresh session.");
      error.code = "X402_RECONCILIATION_REQUIRED";
      throw error;
    }
    if (x402.mode !== "monad-testnet" || typeof x402.restorePendingPayment !== "function") {
      const error = new Error("Startup blocked: stored Monad x402 reconciliation state belongs to another adapter mode.");
      error.code = "PERSISTED_STATE_X402_MODE_MISMATCH";
      throw error;
    }
    x402.restorePendingPayment(unresolvedMonadPayment.externalOperations.x402Pending);
  }
  // Local CLI sessions intentionally start fresh because their demo adapter
  // ledgers are ephemeral. Serverless calls set this false and rehydrate those
  // deterministic ledgers from their durable state snapshot per request.
  if (resetStateOnStart) store.replace(stateFactory());

  function broadcast(message) {
    const payload = `event: ${message.type}\ndata: ${JSON.stringify(message.data)}\n\n`;
    for (const client of clients) client.write(payload);
  }

  const orchestrator = new LazarusOrchestrator({
    store,
    rain,
    monad,
    x402,
    negotiation,
    recovery,
    broadcast,
    persistState,
  });

  async function routeApi(request, response, url) {
    if (x402Seller && await x402Seller.handle(request, response, url)) return;
    if (request.method === "POST") assertSameOriginMutation(request, { requireOrigin: allowRemoteHost });
    if (request.method === "GET" && url.pathname === "/api/health") {
      const safeProbe = async (adapter, fallback, failureCode) => {
        if (typeof adapter.health !== "function") return fallback;
        try {
          return await adapter.health();
        } catch (error) {
          return {
            ok: false,
            mode: adapter.mode || fallback.mode,
            error: { code: error.code || failureCode },
          };
        }
      };
      const probeConfigured = readiness.rpcConfigured && readiness.facilitatorConfigured;
      const [rainHealth, negotiationHealth, recoveryHealth, monadNetwork] = await Promise.all([
        safeProbe(
          rain,
          { ok: true, mode: rain.mode || "local", authenticated: false },
          "RAIN_HEALTH_CHECK_FAILED",
        ),
        safeProbe(
          negotiation,
          { ok: true, ...system.negotiation },
          "MERCHANT_HEALTH_CHECK_FAILED",
        ),
        safeProbe(
          recovery,
          { ok: true, ...system.recovery },
          "RECOVERY_HEALTH_CHECK_FAILED",
        ),
        probeConfigured
          ? runMonadProbe()
          : Promise.resolve({ ok: false, configured: false, caip2Network: readiness.network }),
      ]);
      const ok = rainHealth.ok === true
        && negotiationHealth.ok === true
        && recoveryHealth.ok === true
        && (!probeConfigured || monadNetwork.ok === true);
      return sendJson(response, ok ? 200 : 503, {
        ok,
        name: "Lazarus Mesh",
        mode: system.mode,
        networkAccess: system.networkAccess,
        adapters: {
          rain: rainHealth,
          monad: {
            execution: system.monad.mode,
            writesEnabled: x402Live,
            bountyWritesEnabled: false,
            x402PaymentWritesEnabled: x402Live,
            network: monadNetwork,
            signerConfigured: readiness.signerConfigured,
            contractConfigured: readiness.contractConfigured,
            payToConfigured: readiness.payToConfigured,
          },
          x402: {
            execution: system.x402.mode,
            liveSettlementEnabled: x402Live,
            sellerEnabled: system.x402.sellerEnabled,
            resourceConfigured: readiness.resourceConfigured,
            facilitatorConfigured: readiness.facilitatorConfigured,
          },
          negotiation: negotiationHealth,
          recovery: recoveryHealth,
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
      if (livePreviewOneShot) {
        return sendApiProblem(response, 403, {
          code: "LIVE_PREVIEW_ONE_SHOT",
          message: "The protected payment preview is one-shot; reset is disabled.",
        });
      }
      const state = await orchestrator.reset(stateFactory);
      return sendJson(response, 200, state);
    }

    if (request.method === "POST" && url.pathname === "/api/missions") {
      if (livePreviewOneShot) {
        return sendApiProblem(response, 403, {
          code: "LIVE_PREVIEW_ONE_SHOT",
          message: "The protected payment preview uses one fixed, verified mission.",
        });
      }
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
      const currency = normalizeCurrency(body.currency);
      if (!currency || !system.missionCreation.supportedCurrencies.includes(currency)) {
        return sendApiProblem(response, 422, {
          code: "CURRENCY_NOT_SUPPORTED",
          message: `Choose one currency supported by this runtime: ${system.missionCreation.supportedCurrencies.join(", ")}.`,
          field: "currency",
          details: { supportedCurrencies: system.missionCreation.supportedCurrencies },
        });
      }
      if (adapterMode === "rain-sandbox" && currency !== "USD") {
        return sendApiProblem(response, 422, {
          code: "RAIL_CURRENCY_UNSUPPORTED",
          message: "Rain's hackathon card sandbox authorizes USD only. Use USD for Rain sandbox execution or switch to the local multi-currency demo.",
          field: "currency",
          details: { rail: "rain-sandbox", supportedCurrencies: ["USD"] },
        });
      }
      const currencyLimits = missionCurrencyLimits(currency);
      const rewardMinor = body.rewardMinor === undefined
        ? currencyLimits.defaultRewardMinor
        : body.rewardMinor;
      const totalBudgetMinor = body.totalBudgetMinor === undefined
        ? currencyLimits.defaultBudgetMinor
        : body.totalBudgetMinor;

      if (
        !Number.isSafeInteger(rewardMinor) ||
        rewardMinor < currencyLimits.minimumRewardMinor ||
        rewardMinor > currencyLimits.maximumRewardMinor
      ) {
        return sendApiProblem(response, 422, {
          code: "REWARD_OUT_OF_RANGE",
          message: `Provider reward must be between ${formatMinor(currencyLimits.minimumRewardMinor, currency)} and ${formatMinor(currencyLimits.maximumRewardMinor, currency)}.`,
          field: "rewardMinor",
          details: {
            currency,
            minimumRewardMinor: currencyLimits.minimumRewardMinor,
            maximumRewardMinor: currencyLimits.maximumRewardMinor,
          },
        });
      }

      if (!Number.isSafeInteger(totalBudgetMinor)) {
        return sendApiProblem(response, 422, {
          code: "INVALID_BUDGET_AMOUNT",
          message: `Recovery spend cap must be a valid amount in whole ${currency} minor units.`,
          field: "totalBudgetMinor",
        });
      }

      if (totalBudgetMinor < currencyLimits.minimumBudgetMinor) {
        return sendApiProblem(response, 422, {
          code: "BUDGET_BELOW_REQUIRED_RESERVE",
          message: `Recovery spend cap must be at least ${formatMinor(currencyLimits.minimumBudgetMinor, currency)}: up to ${formatMinor(currencyLimits.archiveReserveMinor, currency)} for the archive quote plus ${formatMinor(currencyLimits.discoveryReserveMinor, currency)} for discovery.`,
          field: "totalBudgetMinor",
          details: {
            currency,
            minimumBudgetMinor: currencyLimits.minimumBudgetMinor,
            archiveReserveMinor: currencyLimits.archiveReserveMinor,
            discoveryReserveMinor: currencyLimits.discoveryReserveMinor,
          },
        });
      }

      if (totalBudgetMinor > currencyLimits.maximumBudgetMinor) {
        return sendApiProblem(response, 422, {
          code: "BUDGET_ABOVE_MAXIMUM",
          message: `Recovery spend cap cannot exceed ${formatMinor(currencyLimits.maximumBudgetMinor, currency)}.`,
          field: "totalBudgetMinor",
          details: { currency, maximumBudgetMinor: currencyLimits.maximumBudgetMinor },
        });
      }

      const requestedRoot = typeof body.contentRoot === "string" ? body.contentRoot.trim().toLowerCase() : "";
      if (requestedRoot && requestedRoot !== creationManifest.contentRoot) {
        return sendApiProblem(response, 422, {
          code: "CONTENT_ROOT_NOT_AVAILABLE",
          message: networkedProviders
            ? "This runtime accepts only the sponsor-pinned remote provider artifact."
            : "This runtime can create missions only for the verified bundled fixture. Configure a network recovery provider before using another content root.",
          field: "contentRoot",
          details: { supportedContentRoot: creationManifest.contentRoot },
        });
      }

      const requestedPieceCount = body.pieceCount ?? body.totalPieces;
      if (requestedPieceCount !== undefined && requestedPieceCount !== creationManifest.totalPieces) {
        return sendApiProblem(response, 422, {
          code: "PIECE_COUNT_NOT_SUPPORTED",
          message: `The verified ${networkedProviders ? "remote" : "bundled"} manifest contains exactly ${creationManifest.totalPieces} pieces.`,
          field: "pieceCount",
          details: { supportedPieceCount: creationManifest.totalPieces },
        });
      }

      if (body.license !== undefined && body.license !== creationManifest.license) {
        return sendApiProblem(response, 422, {
          code: "LICENSE_NOT_SUPPORTED",
          message: `The ${networkedProviders ? "remote" : "bundled"} artifact is verified under ${creationManifest.license}.`,
          field: "license",
          details: { supportedLicense: creationManifest.license },
        });
      }

      const mission = createMission({
        recovery,
        negotiation,
        id: `mission_${randomUUID().replaceAll("-", "").slice(0, 16)}`,
        title: title || "Restore authorized dataset",
        rewardMinor,
        totalBudgetMinor,
        currency,
        currencyRateSet: RATE_SET_ID,
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
      assertApplicationRequest(request, { allowRemoteHost });
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
    system,
    adapters: { rain, monad, x402, negotiation, recovery, x402Seller },
    internal: Object.freeze({ persistPendingX402Payment }),
  };
}

if (require.main === module) {
  const adapterMode = process.env.ADAPTER_MODE || "local";
  const { server, system } = createApplication({ adapterMode, env: process.env });
  server.listen(PORT, HOST, () => {
    process.stdout.write(`Lazarus Mesh (${adapterMode}): http://${HOST}:${PORT}\n`);
    if (system.x402.liveSettlementEnabled) {
      process.stdout.write("Monad x402 testnet payments are enabled with a strict USDC cap; bounty execution remains local.\n");
    } else {
      process.stdout.write(adapterMode === "rain-sandbox"
        ? "Rain sandbox is live; Monad/x402 execution remains local with read-only testnet readiness checks.\n"
        : "All payment and chain execution is local.\n");
    }
  });
}

module.exports = { assertApplicationRequest, createApplication };
