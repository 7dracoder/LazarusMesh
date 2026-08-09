"use strict";

const {
  getAddress,
  getTypesForEIP712Domain,
  serializeTypedData,
  validateTypedData,
  verifyTypedData,
} = require("viem");

const PRIVY_API_BASE_URL = "https://api.privy.io/v1/";
const MONAD_TESTNET_CHAIN_ID = 10143;
const MONAD_TESTNET_USDC = "0x534b2f3A21130d7a60830c2Df862319e593943A3";
const MAX_PRIVY_RESPONSE_BYTES = 8 * 1024;

const EIP_3009_TYPES = Object.freeze([
  Object.freeze({ name: "from", type: "address" }),
  Object.freeze({ name: "to", type: "address" }),
  Object.freeze({ name: "value", type: "uint256" }),
  Object.freeze({ name: "validAfter", type: "uint256" }),
  Object.freeze({ name: "validBefore", type: "uint256" }),
  Object.freeze({ name: "nonce", type: "bytes32" }),
]);

class PrivySignerError extends Error {
  constructor(code, message, { retryable = false, statusCode = 502 } = {}) {
    super(message);
    this.name = "PrivySignerError";
    this.code = code;
    this.retryable = retryable;
    this.statusCode = statusCode;
  }
}

function configurationError(message) {
  return new PrivySignerError("PRIVY_SIGNER_INVALID_CONFIGURATION", message, {
    statusCode: 500,
  });
}

function nonemptyString(value, label) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw configurationError(`${label} is required.`);
  }
  return value.trim();
}

function opaqueIdentifier(value, label) {
  const normalized = nonemptyString(value, label);
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(normalized)) {
    throw configurationError(`${label} is invalid.`);
  }
  return normalized;
}

function positiveInteger(value, label, maximum) {
  const parsed = typeof value === "string" && /^[0-9]+$/.test(value)
    ? Number(value)
    : value;
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > maximum) {
    throw configurationError(`${label} must be a positive integer no greater than ${maximum}.`);
  }
  return parsed;
}

function positiveAtomic(value, label) {
  if ((typeof value !== "string" && typeof value !== "bigint") || !/^[0-9]+$/.test(String(value))) {
    throw configurationError(`${label} must be a positive atomic-unit integer.`);
  }
  const parsed = BigInt(value);
  if (parsed <= 0n || parsed > 1_000_000n) {
    throw configurationError(`${label} must be between 1 and 1000000 test-USDC atomic units.`);
  }
  return parsed;
}

function normalizeHttpsDirectory(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw configurationError("The Privy API URL is invalid.");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw configurationError("The Privy API URL must be a credential-free HTTPS URL.");
  }
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url;
}

function normalizeAddress(value, label) {
  try {
    return getAddress(nonemptyString(value, label));
  } catch (error) {
    if (error instanceof PrivySignerError) throw error;
    throw configurationError(`${label} must be a valid EVM address.`);
  }
}

function policyAddress(value, label) {
  try {
    return getAddress(typeof value === "string" ? value : "");
  } catch {
    throw policyError(`${label} is invalid.`);
  }
}

function sameTypeDefinition(actual, expected) {
  return (
    Array.isArray(actual) &&
    actual.length === expected.length &&
    actual.every((field, index) => (
      field &&
      field.name === expected[index].name &&
      field.type === expected[index].type
    ))
  );
}

function unixSeconds(clock) {
  const date = clock();
  const milliseconds = date instanceof Date ? date.getTime() : Number.NaN;
  if (!Number.isFinite(milliseconds)) {
    throw new PrivySignerError("PRIVY_SIGNER_CLOCK_INVALID", "The signer clock returned an invalid time.", {
      statusCode: 500,
    });
  }
  return BigInt(Math.floor(milliseconds / 1000));
}

function bigintField(value, label) {
  try {
    if (
      (typeof value === "string" && !/^(0|[1-9][0-9]*)$/.test(value)) ||
      (typeof value !== "string" && typeof value !== "number" && typeof value !== "bigint")
    ) {
      throw new Error("invalid");
    }
    const parsed = BigInt(value);
    if (parsed < 0n) throw new Error("negative");
    return parsed;
  } catch {
    throw new PrivySignerError("PRIVY_SIGNER_POLICY_REJECTED", `${label} is invalid.`, {
      statusCode: 400,
    });
  }
}

function policyError(message) {
  return new PrivySignerError("PRIVY_SIGNER_POLICY_REJECTED", message, { statusCode: 403 });
}

function requestErrorForStatus(status) {
  if (status === 401 || status === 403) {
    return new PrivySignerError(
      "PRIVY_AUTH_FAILED",
      "Privy rejected the server-wallet credentials or wallet authorization policy.",
      { statusCode: 502 },
    );
  }
  if (status === 408 || status === 409 || status === 425 || status === 429 || status >= 500) {
    return new PrivySignerError("PRIVY_SIGNING_UNAVAILABLE", "Privy could not sign the payment authorization.", {
      retryable: true,
      statusCode: 503,
    });
  }
  return new PrivySignerError("PRIVY_SIGNING_REJECTED", "Privy rejected the payment authorization.", {
    statusCode: 502,
  });
}

/**
 * A narrowly scoped Privy server-wallet adapter for Monad x402 EIP-3009.
 * Credentials remain in private fields and are sent only to Privy's HTTPS API.
 */
class PrivyServerWalletSigner {
  #appId;
  #appSecret;
  #walletId;
  #apiBaseUrl;
  #fetch;
  #clock;
  #timeoutMs;
  #maxPaymentAtomic;
  #maxAuthorizationSeconds;
  #expectedPayToAddress;

  constructor({
    appId,
    appSecret,
    walletId,
    address,
    expectedPayToAddress,
    maxPaymentAtomic = "10000",
    maxAuthorizationSeconds = 300,
    timeoutMs = 12_000,
    apiBaseUrl = PRIVY_API_BASE_URL,
    fetchImpl = globalThis.fetch,
    clock = () => new Date(),
  } = {}) {
    this.#appId = opaqueIdentifier(appId, "PRIVY_APP_ID");
    this.#appSecret = nonemptyString(appSecret, "PRIVY_APP_SECRET");
    this.#walletId = opaqueIdentifier(walletId, "PRIVY_PAYER_WALLET_ID");
    Object.defineProperty(this, "address", {
      value: normalizeAddress(address, "PRIVY_PAYER_ADDRESS"),
      enumerable: true,
      configurable: false,
      writable: false,
    });
    this.#expectedPayToAddress = normalizeAddress(expectedPayToAddress, "MONAD_PAY_TO_ADDRESS");
    if (this.address.toLowerCase() === this.#expectedPayToAddress.toLowerCase()) {
      throw configurationError("The Privy payer and Monad seller must be different wallets.");
    }
    this.#maxPaymentAtomic = positiveAtomic(maxPaymentAtomic, "X402_MAX_PAYMENT_ATOMIC");
    this.#maxAuthorizationSeconds = positiveInteger(
      maxAuthorizationSeconds,
      "X402_MAX_AUTHORIZATION_SECONDS",
      900,
    );
    this.#timeoutMs = positiveInteger(timeoutMs, "X402_TIMEOUT_MS", 30_000);
    this.#apiBaseUrl = normalizeHttpsDirectory(apiBaseUrl);
    if (typeof fetchImpl !== "function") throw configurationError("A fetch implementation is required.");
    if (typeof clock !== "function") throw configurationError("A clock function is required.");
    this.#fetch = fetchImpl;
    this.#clock = clock;
    Object.freeze(this);
  }

  #assertAllowedTypedData({ domain, types, primaryType, message } = {}) {
    if (!domain || !types || !message || primaryType !== "TransferWithAuthorization") {
      throw policyError("Only x402 TransferWithAuthorization typed data may be signed.");
    }
    if (!sameTypeDefinition(types.TransferWithAuthorization, EIP_3009_TYPES)) {
      throw policyError("The x402 authorization schema is not approved.");
    }
    if (
      domain.name !== "USDC" ||
      domain.version !== "2" ||
      Number(domain.chainId) !== MONAD_TESTNET_CHAIN_ID ||
      policyAddress(domain.verifyingContract, "Typed-data verifying contract").toLowerCase() !==
        MONAD_TESTNET_USDC.toLowerCase()
    ) {
      throw policyError("The typed-data domain is not approved for Monad test-USDC.");
    }
    if (policyAddress(message.from, "Typed-data payer").toLowerCase() !== this.address.toLowerCase()) {
      throw policyError("The typed-data payer does not match the Privy wallet.");
    }
    if (
      policyAddress(message.to, "Typed-data payee").toLowerCase() !==
      this.#expectedPayToAddress.toLowerCase()
    ) {
      throw policyError("The typed-data payee is not approved.");
    }
    const value = bigintField(message.value, "Typed-data payment amount");
    if (value <= 0n || value > this.#maxPaymentAtomic) {
      throw policyError("The typed-data payment exceeds the configured cap.");
    }
    const validAfter = bigintField(message.validAfter, "Typed-data validAfter");
    const validBefore = bigintField(message.validBefore, "Typed-data validBefore");
    const now = unixSeconds(this.#clock);
    if (
      validAfter !== 0n ||
      validBefore < now ||
      validBefore > now + BigInt(this.#maxAuthorizationSeconds + 5)
    ) {
      throw policyError("The typed-data authorization lifetime is not approved.");
    }
    if (typeof message.nonce !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(message.nonce)) {
      throw policyError("The typed-data nonce must be a bytes32 value.");
    }
  }

  async signTypedData(typedData) {
    this.#assertAllowedTypedData(typedData);
    const types = {
      ...typedData.types,
      // Never let caller-supplied domain types omit the chain or token fields
      // that this signer policy approved above.
      EIP712Domain: getTypesForEIP712Domain({ domain: typedData.domain }),
    };
    let serialized;
    try {
      validateTypedData({ ...typedData, types });
      serialized = JSON.parse(serializeTypedData({ ...typedData, types }));
    } catch {
      throw new PrivySignerError("PRIVY_SIGNER_INVALID_TYPED_DATA", "The payment typed data is invalid.", {
        statusCode: 400,
      });
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.#timeoutMs);
    let response;
    try {
      response = await this.#fetch(new URL(`wallets/${this.#walletId}/rpc`, this.#apiBaseUrl), {
        method: "POST",
        redirect: "error",
        signal: controller.signal,
        headers: {
          authorization: `Basic ${Buffer.from(`${this.#appId}:${this.#appSecret}`, "utf8").toString("base64")}`,
          "content-type": "application/json",
          "privy-app-id": this.#appId,
        },
        body: JSON.stringify({
          method: "eth_signTypedData_v4",
          params: {
            typed_data: {
              domain: serialized.domain,
              types: serialized.types,
              message: serialized.message,
              primary_type: serialized.primaryType,
            },
          },
        }),
      });
    } catch (error) {
      throw new PrivySignerError(
        error?.name === "AbortError" ? "PRIVY_SIGNING_TIMEOUT" : "PRIVY_SIGNING_UNAVAILABLE",
        error?.name === "AbortError"
          ? "Privy did not sign before the request deadline."
          : "Privy could not be reached to sign the payment authorization.",
        { retryable: true, statusCode: 503 },
      );
    } finally {
      clearTimeout(timeout);
    }

    if (!response || typeof response.status !== "number") {
      throw new PrivySignerError("PRIVY_INVALID_RESPONSE", "Privy returned an invalid response.");
    }
    if (!response.ok) throw requestErrorForStatus(response.status);
    const contentLength = Number(response.headers?.get?.("content-length"));
    if (Number.isFinite(contentLength) && contentLength > MAX_PRIVY_RESPONSE_BYTES) {
      throw new PrivySignerError("PRIVY_INVALID_RESPONSE", "Privy's signing response was too large.");
    }
    let payload;
    try {
      const raw = await response.text();
      if (Buffer.byteLength(raw, "utf8") > MAX_PRIVY_RESPONSE_BYTES) throw new Error("too large");
      payload = JSON.parse(raw);
    } catch {
      throw new PrivySignerError("PRIVY_INVALID_RESPONSE", "Privy returned an invalid signing response.");
    }
    const signature = payload?.data?.signature;
    if (
      payload?.method !== "eth_signTypedData_v4" ||
      typeof signature !== "string" ||
      !/^0x[0-9a-fA-F]{130}$/.test(signature)
    ) {
      throw new PrivySignerError("PRIVY_INVALID_RESPONSE", "Privy returned an invalid payment signature.");
    }
    let validSignature = false;
    try {
      validSignature = await verifyTypedData({
        ...typedData,
        address: this.address,
        signature,
      });
    } catch {
      validSignature = false;
    }
    if (!validSignature) {
      throw new PrivySignerError(
        "PRIVY_SIGNATURE_MISMATCH",
        "Privy's signature did not match the configured payer wallet.",
      );
    }
    return signature;
  }
}

function createPrivyServerWalletSigner(options) {
  return new PrivyServerWalletSigner(options);
}

module.exports = {
  EIP_3009_TYPES,
  MONAD_TESTNET_CHAIN_ID,
  MONAD_TESTNET_USDC,
  PRIVY_API_BASE_URL,
  PrivyServerWalletSigner,
  PrivySignerError,
  createPrivyServerWalletSigner,
};
