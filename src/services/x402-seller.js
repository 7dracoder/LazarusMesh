"use strict";

const { createHash } = require("node:crypto");
const {
  HTTPFacilitatorClient,
  x402HTTPResourceServer,
  x402ResourceServer,
} = require("@x402/core/server");
const {
  decodePaymentSignatureHeader,
  encodePaymentResponseHeader,
} = require("@x402/core/http");
const { ExactEvmScheme } = require("@x402/evm/exact/server");
const {
  PAYMENT_IDENTIFIER,
  declarePaymentIdentifierExtension,
  extractPaymentIdentifier,
  paymentIdentifierResourceServerExtension,
  validatePaymentIdentifierRequirement,
} = require("@x402/extensions/payment-identifier");
const { getAddress } = require("viem");

const MONAD_TESTNET_NETWORK = "eip155:10143";
const MONAD_TESTNET_USDC = "0x534b2f3A21130d7a60830c2Df862319e593943A3";
const MONAD_X402_FACILITATOR = "https://x402-facilitator.molandak.org";
const DEFAULT_AMOUNT_ATOMIC = "10000";
const DEFAULT_MAX_TIMEOUT_SECONDS = 300;
const DEFAULT_PROVIDER_ID = "provider_atlas_archive";
const AVAILABILITY_PATH_PREFIX = "/api/x402/availability/";

class X402SellerError extends Error {
  constructor(code, message, { statusCode = 500 } = {}) {
    super(message);
    this.name = "X402SellerError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

function requiredPositiveInteger(value, name, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new X402SellerError("X402_SELLER_INVALID_CONFIGURATION", `${name} must be a positive integer.`, {
      statusCode: 500,
    });
  }
  return value;
}

function normalizeAtomic(value) {
  const text = String(value || "");
  if (!/^[1-9][0-9]*$/.test(text) || BigInt(text) > 1_000_000n) {
    throw new X402SellerError(
      "X402_SELLER_INVALID_CONFIGURATION",
      "The x402 seller amount must be between one atomic unit and one test USDC.",
    );
  }
  return text;
}

function normalizeHttpsDirectory(value, name) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new X402SellerError("X402_SELLER_INVALID_CONFIGURATION", `${name} must be a valid HTTPS URL.`);
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !url.hostname
  ) {
    throw new X402SellerError("X402_SELLER_INVALID_CONFIGURATION", `${name} must be a credential-free HTTPS URL.`);
  }
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url;
}

function normalizeContentRoot(value) {
  if (
    typeof value !== "string" ||
    value.length < 16 ||
    value.length > 256 ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)
  ) {
    throw new X402SellerError("X402_CONTENT_ROOT_INVALID", "The availability content root is invalid.", {
      statusCode: 400,
    });
  }
  return value;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function paymentFingerprint(paymentPayload) {
  return createHash("sha256").update(stableJson(paymentPayload)).digest("hex");
}

function headerValue(headers, name) {
  const value = headers?.[String(name).toLowerCase()];
  if (Array.isArray(value)) return value[0];
  return typeof value === "string" ? value : undefined;
}

function requestAdapter(request, canonicalUrl) {
  return {
    getHeader(name) {
      return headerValue(request.headers, name);
    },
    getMethod() {
      return String(request.method || "GET").toUpperCase();
    },
    getPath() {
      return canonicalUrl.pathname;
    },
    getUrl() {
      return canonicalUrl.href;
    },
    getAcceptHeader() {
      return headerValue(request.headers, "accept") || "application/json";
    },
    getUserAgent() {
      return headerValue(request.headers, "user-agent") || "";
    },
    getQueryParams() {
      return {};
    },
    getQueryParam() {
      return undefined;
    },
  };
}

function securityHeaders(contentType = "application/json; charset=utf-8") {
  return {
    "Content-Type": contentType,
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
  };
}

function writeJson(response, statusCode, body, headers = {}) {
  response.writeHead(statusCode, {
    ...securityHeaders(),
    ...headers,
    "Cache-Control": "private, no-store",
  });
  response.end(`${JSON.stringify(body)}\n`);
}

function writeInstructions(response, instructions) {
  const contentType = instructions.headers?.["Content-Type"] || instructions.headers?.["content-type"];
  const headers = {
    ...securityHeaders(contentType || "application/json; charset=utf-8"),
    ...instructions.headers,
    "Cache-Control": "private, no-store",
  };
  const body = instructions.body;
  response.writeHead(instructions.status, headers);
  if (body === undefined || body === null) return response.end();
  if (typeof body === "string" || Buffer.isBuffer(body)) return response.end(body);
  return response.end(`${JSON.stringify(body)}\n`);
}

function publicSettlement(settlement) {
  return {
    success: settlement.success,
    transaction: settlement.transaction,
    network: settlement.network,
    ...(settlement.payer ? { payer: settlement.payer } : {}),
    ...(settlement.amount ? { amount: settlement.amount } : {}),
    ...(settlement.extensions ? { extensions: settlement.extensions } : {}),
  };
}

class MonadX402Seller {
  constructor({
    availabilityBaseUrl,
    payToAddress,
    settlementStore,
    facilitatorUrl = MONAD_X402_FACILITATOR,
    facilitatorClient,
    amountAtomic = DEFAULT_AMOUNT_ATOMIC,
    maxTimeoutSeconds = DEFAULT_MAX_TIMEOUT_SECONDS,
    providerId = DEFAULT_PROVIDER_ID,
    candidateProviders = 1,
    estimatedRecoverySeconds = 45,
    estimatedCostMinor = 1200,
    confidence = 0.94,
    httpResourceServer,
    allowEphemeralStore = false,
  } = {}) {
    this.availabilityBaseUrl = normalizeHttpsDirectory(
      availabilityBaseUrl,
      "X402_AVAILABILITY_BASE_URL",
    );
    if (!this.availabilityBaseUrl.pathname.endsWith(AVAILABILITY_PATH_PREFIX)) {
      throw new X402SellerError(
        "X402_SELLER_INVALID_CONFIGURATION",
        `X402_AVAILABILITY_BASE_URL must end with ${AVAILABILITY_PATH_PREFIX}`,
      );
    }
    try {
      this.payToAddress = getAddress(payToAddress);
    } catch {
      throw new X402SellerError(
        "X402_SELLER_INVALID_CONFIGURATION",
        "MONAD_PAY_TO_ADDRESS must be a valid EVM address.",
      );
    }
    if (
      !settlementStore ||
      typeof settlementStore.get !== "function" ||
      typeof settlementStore.begin !== "function" ||
      typeof settlementStore.complete !== "function" ||
      typeof settlementStore.markUncertain !== "function"
    ) {
      throw new X402SellerError(
        "X402_SELLER_INVALID_CONFIGURATION",
        "A durable x402 settlement store is required.",
      );
    }
    if (settlementStore.durable !== true && allowEphemeralStore !== true) {
      throw new X402SellerError(
        "X402_SELLER_INVALID_CONFIGURATION",
        "The x402 settlement store must be durable; ephemeral storage is test-only.",
      );
    }
    this.settlementStore = settlementStore;
    this.amountAtomic = normalizeAtomic(amountAtomic);
    this.maxTimeoutSeconds = requiredPositiveInteger(maxTimeoutSeconds, "maxTimeoutSeconds", 900);
    this.providerId = normalizeContentRoot(providerId);
    this.candidateProviders = requiredPositiveInteger(candidateProviders, "candidateProviders", 100);
    this.estimatedRecoverySeconds = requiredPositiveInteger(
      estimatedRecoverySeconds,
      "estimatedRecoverySeconds",
      86_400,
    );
    if (!Number.isSafeInteger(estimatedCostMinor) || estimatedCostMinor < 0) {
      throw new X402SellerError("X402_SELLER_INVALID_CONFIGURATION", "estimatedCostMinor is invalid.");
    }
    if (typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      throw new X402SellerError("X402_SELLER_INVALID_CONFIGURATION", "confidence must be between zero and one.");
    }
    this.estimatedCostMinor = estimatedCostMinor;
    this.confidence = confidence;

    if (httpResourceServer) {
      this.httpResourceServer = httpResourceServer;
    } else {
      const normalizedFacilitatorUrl = normalizeHttpsDirectory(facilitatorUrl, "X402_FACILITATOR_URL");
      const client = facilitatorClient || new HTTPFacilitatorClient({
        url: normalizedFacilitatorUrl.href.replace(/\/$/, ""),
      });
      const resourceServer = new x402ResourceServer(client)
        .register(MONAD_TESTNET_NETWORK, new ExactEvmScheme())
        .registerExtension(paymentIdentifierResourceServerExtension);
      this.httpResourceServer = new x402HTTPResourceServer(resourceServer, {
        [`GET ${AVAILABILITY_PATH_PREFIX}:contentRoot`]: {
          accepts: {
            scheme: "exact",
            network: MONAD_TESTNET_NETWORK,
            payTo: this.payToAddress,
            price: {
              asset: MONAD_TESTNET_USDC,
              amount: this.amountAtomic,
              extra: {
                name: "USDC",
                version: "2",
                assetTransferMethod: "eip3009",
              },
            },
            maxTimeoutSeconds: this.maxTimeoutSeconds,
          },
          description: "Lazarus Mesh recovery-provider availability intelligence",
          mimeType: "application/json",
          serviceName: "Lazarus Mesh",
          tags: ["availability", "recovery", "monad-testnet"],
          extensions: {
            [PAYMENT_IDENTIFIER]: declarePaymentIdentifierExtension(true),
          },
          unpaidResponseBody: async () => ({
            contentType: "application/json",
            body: {
              error: "PAYMENT_REQUIRED",
              message: "A capped Monad testnet USDC payment is required for this availability resource.",
            },
          }),
          settlementFailedResponseBody: async (_context, failure) => ({
            contentType: "application/json",
            body: {
              error: "X402_SETTLEMENT_FAILED",
              message: "The facilitator did not confirm settlement.",
              reason: failure.errorReason,
            },
          }),
        },
      });
    }
    if (
      typeof this.httpResourceServer.initialize !== "function" ||
      typeof this.httpResourceServer.processHTTPRequest !== "function" ||
      typeof this.httpResourceServer.processSettlement !== "function"
    ) {
      throw new X402SellerError("X402_SELLER_INVALID_CONFIGURATION", "The x402 HTTP resource server is invalid.");
    }
    this.initializePromise = null;
  }

  resourceUrl(contentRoot) {
    return new URL(encodeURIComponent(normalizeContentRoot(contentRoot)), this.availabilityBaseUrl);
  }

  async initialize() {
    if (!this.initializePromise) {
      this.initializePromise = Promise.resolve(this.httpResourceServer.initialize()).catch((error) => {
        this.initializePromise = null;
        throw error;
      });
    }
    return this.initializePromise;
  }

  match(url) {
    const pathname = url instanceof URL ? url.pathname : String(url || "");
    if (!pathname.startsWith(AVAILABILITY_PATH_PREFIX)) return null;
    const encoded = pathname.slice(AVAILABILITY_PATH_PREFIX.length);
    if (!encoded || encoded.includes("/")) {
      throw new X402SellerError("X402_CONTENT_ROOT_INVALID", "The availability content root is invalid.", {
        statusCode: 400,
      });
    }
    let decoded;
    try {
      decoded = decodeURIComponent(encoded);
    } catch {
      throw new X402SellerError("X402_CONTENT_ROOT_INVALID", "The availability content root is malformed.", {
        statusCode: 400,
      });
    }
    const contentRoot = normalizeContentRoot(decoded);
    if (encodeURIComponent(contentRoot) !== encoded) {
      throw new X402SellerError("X402_CONTENT_ROOT_INVALID", "The availability content root is not canonical.", {
        statusCode: 400,
      });
    }
    return contentRoot;
  }

  availability(contentRoot, paymentId) {
    return {
      availability: {
        contentRoot,
        paymentId,
        candidateProviders: this.candidateProviders,
        recommendedProvider: this.providerId,
        estimatedRecoverySeconds: this.estimatedRecoverySeconds,
        estimatedCostMinor: this.estimatedCostMinor,
        estimatedCostCurrency: "USD",
        confidence: this.confidence,
      },
    };
  }

  writeReplay(response, record) {
    const settlement = record.settlement;
    if (!settlement || settlement.success !== true || !record.responseBody) {
      throw new X402SellerError(
        "X402_SELLER_REPLAY_INVALID",
        "The stored x402 settlement replay record is incomplete.",
      );
    }
    return writeJson(response, 200, record.responseBody, {
      "PAYMENT-RESPONSE": encodePaymentResponseHeader(settlement),
    });
  }

  async handle(request, response, url) {
    let contentRoot;
    try {
      contentRoot = this.match(url);
    } catch (error) {
      if (error instanceof X402SellerError) {
        writeJson(response, error.statusCode, { error: error.code, message: error.message });
        return true;
      }
      throw error;
    }
    if (!contentRoot) return false;
    if (String(request.method || "GET").toUpperCase() !== "GET") {
      writeJson(response, 405, {
        error: "METHOD_NOT_ALLOWED",
        message: "The x402 availability resource supports GET only.",
      }, { Allow: "GET" });
      return true;
    }

    const canonicalUrl = this.resourceUrl(contentRoot);
    const adapter = requestAdapter(request, canonicalUrl);
    const paymentHeader = adapter.getHeader("payment-signature");
    let decodedPayment = null;
    let decodedPaymentId = null;
    let decodedFingerprint = null;
    if (paymentHeader) {
      try {
        decodedPayment = decodePaymentSignatureHeader(paymentHeader);
        decodedPaymentId = extractPaymentIdentifier(decodedPayment);
        if (decodedPaymentId) decodedFingerprint = paymentFingerprint(decodedPayment);
      } catch {
        // The protocol server will return a fresh 402 for malformed payment headers.
      }
    }
    if (decodedPaymentId && decodedFingerprint) {
      const prior = await this.settlementStore.get(decodedPaymentId);
      if (prior && prior.fingerprint !== decodedFingerprint) {
        writeJson(response, 409, {
          error: "X402_PAYMENT_ID_CONFLICT",
          message: "That x402 payment identifier belongs to a different authorization.",
        });
        return true;
      }
      if (prior && prior.contentRoot !== contentRoot) {
        writeJson(response, 409, {
          error: "X402_PAYMENT_ID_CONFLICT",
          message: "That x402 payment identifier belongs to a different resource.",
        });
        return true;
      }
      if (prior?.status === "settled") {
        this.writeReplay(response, prior);
        return true;
      }
      if (prior?.status === "processing" || prior?.status === "uncertain") {
        writeJson(response, 409, {
          error: "X402_RECONCILIATION_REQUIRED",
          message: "This payment identifier has an unresolved settlement outcome.",
        });
        return true;
      }
    }

    await this.initialize();
    const context = {
      adapter,
      path: canonicalUrl.pathname,
      method: "GET",
      ...(paymentHeader ? { paymentHeader } : {}),
    };
    const processed = await this.httpResourceServer.processHTTPRequest(context, { testnet: true });
    if (processed.type === "no-payment-required") {
      throw new X402SellerError("X402_SELLER_ROUTE_MISSING", "The x402 seller route is not protected.");
    }
    if (processed.type === "payment-error") {
      writeInstructions(response, processed.response);
      return true;
    }

    const paymentPayload = processed.paymentPayload;
    const identifierValidation = validatePaymentIdentifierRequirement(paymentPayload, true);
    const paymentId = extractPaymentIdentifier(paymentPayload);
    if (!identifierValidation.valid || !paymentId) {
      await processed.cancellationDispatcher.cancel({ reason: "handler_failed", responseStatus: 400 });
      writeJson(response, 400, {
        error: "X402_PAYMENT_ID_REQUIRED",
        message: "A valid 16-128 character x402 payment identifier is required.",
      });
      return true;
    }
    if (paymentPayload.x402Version !== 2 || paymentPayload.resource?.url !== canonicalUrl.href) {
      await processed.cancellationDispatcher.cancel({ reason: "handler_failed", responseStatus: 409 });
      writeJson(response, 409, {
        error: "X402_RESOURCE_MISMATCH",
        message: "The signed payment payload names a different resource.",
      });
      return true;
    }

    const fingerprint = paymentFingerprint(paymentPayload);
    const reservation = await this.settlementStore.begin({ paymentId, fingerprint, contentRoot });
    if (reservation.kind === "replay") {
      this.writeReplay(response, reservation.record);
      return true;
    }
    if (reservation.kind !== "started") {
      await processed.cancellationDispatcher.cancel({ reason: "handler_failed", responseStatus: 409 });
      writeJson(response, 409, {
        error: reservation.kind === "conflict"
          ? "X402_PAYMENT_ID_CONFLICT"
          : "X402_RECONCILIATION_REQUIRED",
        message: reservation.kind === "conflict"
          ? "That x402 payment identifier belongs to a different authorization."
          : "This payment identifier has an unresolved settlement outcome.",
      });
      return true;
    }

    const responseBody = this.availability(contentRoot, paymentId);
    let settled;
    try {
      const responseText = JSON.stringify(responseBody);
      settled = await this.httpResourceServer.processSettlement(
        paymentPayload,
        processed.paymentRequirements,
        processed.declaredExtensions,
        {
          request: context,
          responseBody: Buffer.from(responseText),
          responseHeaders: { "Content-Type": "application/json" },
        },
      );
    } catch (error) {
      await this.settlementStore.markUncertain({
        paymentId,
        fingerprint,
        errorCode: "X402_FACILITATOR_OUTCOME_UNKNOWN",
      });
      throw error;
    }
    if (!settled.success) {
      await this.settlementStore.markUncertain({
        paymentId,
        fingerprint,
        errorCode: "X402_SETTLEMENT_NOT_CONFIRMED",
      });
      writeInstructions(response, settled.response);
      return true;
    }

    const settlement = publicSettlement(settled);
    try {
      await this.settlementStore.complete({
        paymentId,
        fingerprint,
        responseBody,
        settlement,
      });
    } catch (error) {
      await this.settlementStore.markUncertain({
        paymentId,
        fingerprint,
        errorCode: "X402_SETTLEMENT_PERSIST_FAILED",
      }).catch(() => undefined);
      throw new X402SellerError(
        "X402_SETTLEMENT_PERSIST_FAILED",
        "Settlement succeeded, but its replay record could not be persisted.",
        { statusCode: 503 },
      );
    }
    writeJson(response, 200, responseBody, settled.headers);
    return true;
  }
}

module.exports = {
  AVAILABILITY_PATH_PREFIX,
  DEFAULT_AMOUNT_ATOMIC,
  DEFAULT_MAX_TIMEOUT_SECONDS,
  DEFAULT_PROVIDER_ID,
  MONAD_TESTNET_NETWORK,
  MONAD_TESTNET_USDC,
  MONAD_X402_FACILITATOR,
  MonadX402Seller,
  X402SellerError,
  paymentFingerprint,
};
