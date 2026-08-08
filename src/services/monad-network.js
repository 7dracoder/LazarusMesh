"use strict";

const EXPECTED_CHAIN_ID = 10143;
const EXPECTED_NETWORK = "eip155:10143";
const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_REDIRECTS = 3;

class MonadProbeError extends Error {
  constructor(code, component) {
    super(code);
    this.name = "MonadProbeError";
    this.code = code;
    this.component = component;
  }
}

function validateHttpsOrigin(value, component) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new MonadProbeError("INVALID_HTTPS_ORIGIN", component);
  }

  let url;
  try {
    url = new URL(value);
  } catch {
    throw new MonadProbeError("INVALID_HTTPS_ORIGIN", component);
  }

  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    url.pathname !== "/"
  ) {
    throw new MonadProbeError("INVALID_HTTPS_ORIGIN", component);
  }

  return url.origin;
}

function isRedirect(response) {
  return response.status >= 300 && response.status < 400;
}

function publicError(error, fallbackComponent) {
  if (error instanceof MonadProbeError) {
    return { code: error.code, component: error.component };
  }
  return { code: "MONAD_PROBE_FAILED", component: fallbackComponent };
}

async function fetchWithRedirectGuard({
  fetchImpl,
  url,
  init,
  component,
  signal,
}) {
  const initialUrl = new URL(url);
  let currentUrl = initialUrl;

  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
    let response;
    try {
      response = await fetchImpl(currentUrl.href, {
        ...init,
        redirect: "manual",
        signal,
      });
    } catch (error) {
      if (signal.aborted || error?.name === "AbortError") {
        throw new MonadProbeError("UPSTREAM_TIMEOUT", component);
      }
      throw new MonadProbeError("UPSTREAM_UNREACHABLE", component);
    }

    if (!response || typeof response.status !== "number") {
      throw new MonadProbeError("INVALID_UPSTREAM_RESPONSE", component);
    }

    if (!isRedirect(response)) {
      if (response.url) {
        let responseUrl;
        try {
          responseUrl = new URL(response.url);
        } catch {
          throw new MonadProbeError("INVALID_UPSTREAM_RESPONSE", component);
        }
        if (
          responseUrl.origin !== initialUrl.origin ||
          responseUrl.username !== "" ||
          responseUrl.password !== ""
        ) {
          throw new MonadProbeError("CROSS_ORIGIN_REDIRECT_BLOCKED", component);
        }
      }
      return response;
    }

    if (redirectCount === MAX_REDIRECTS) {
      throw new MonadProbeError("TOO_MANY_REDIRECTS", component);
    }

    const location = response.headers?.get?.("location");
    if (!location) throw new MonadProbeError("INVALID_REDIRECT", component);

    let nextUrl;
    try {
      nextUrl = new URL(location, currentUrl);
    } catch {
      throw new MonadProbeError("INVALID_REDIRECT", component);
    }
    if (
      nextUrl.origin !== initialUrl.origin ||
      nextUrl.username !== "" ||
      nextUrl.password !== ""
    ) {
      throw new MonadProbeError("CROSS_ORIGIN_REDIRECT_BLOCKED", component);
    }
    if (
      !["GET", "HEAD"].includes(String(init.method || "GET").toUpperCase()) &&
      ![307, 308].includes(response.status)
    ) {
      throw new MonadProbeError("UNSAFE_REDIRECT_BLOCKED", component);
    }
    currentUrl = nextUrl;
  }

  throw new MonadProbeError("TOO_MANY_REDIRECTS", component);
}

async function runWithTimeout({ timeoutMs, component, operation }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const aborted = new Promise((_, reject) => {
    controller.signal.addEventListener("abort", () => {
      reject(new MonadProbeError("UPSTREAM_TIMEOUT", component));
    }, { once: true });
  });

  try {
    return await Promise.race([operation(controller.signal), aborted]);
  } catch (error) {
    if (controller.signal.aborted) {
      throw new MonadProbeError("UPSTREAM_TIMEOUT", component);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function readLimitedJson(response, component) {
  const contentLength = response.headers?.get?.("content-length");
  if (contentLength && Number(contentLength) > MAX_RESPONSE_BYTES) {
    throw new MonadProbeError("UPSTREAM_RESPONSE_TOO_LARGE", component);
  }

  let text;
  if (response.body && typeof response.body.getReader === "function") {
    const reader = response.body.getReader();
    const chunks = [];
    let byteLength = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        byteLength += value.byteLength;
        if (byteLength > MAX_RESPONSE_BYTES) {
          await reader.cancel().catch(() => {});
          throw new MonadProbeError("UPSTREAM_RESPONSE_TOO_LARGE", component);
        }
        chunks.push(Buffer.from(value));
      }
    } catch (error) {
      if (error instanceof MonadProbeError) throw error;
      throw new MonadProbeError("INVALID_UPSTREAM_RESPONSE", component);
    }
    text = Buffer.concat(chunks).toString("utf8");
  } else if (typeof response.text === "function") {
    try {
      text = await response.text();
    } catch {
      throw new MonadProbeError("INVALID_UPSTREAM_RESPONSE", component);
    }
    if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) {
      throw new MonadProbeError("UPSTREAM_RESPONSE_TOO_LARGE", component);
    }
  } else {
    throw new MonadProbeError("INVALID_UPSTREAM_RESPONSE", component);
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new MonadProbeError("INVALID_UPSTREAM_RESPONSE", component);
  }
}

async function checkRpc({ fetchImpl, rpcOrigin, timeoutMs }) {
  const component = "rpc";
  return runWithTimeout({
    timeoutMs,
    component,
    operation: async (signal) => {
      const response = await fetchWithRedirectGuard({
        fetchImpl,
        url: `${rpcOrigin}/`,
        component,
        signal,
        init: {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: "monad-readiness",
            method: "eth_chainId",
            params: [],
          }),
        },
      });
      if (!response.ok) throw new MonadProbeError("UPSTREAM_HTTP_ERROR", component);

      const payload = await readLimitedJson(response, component);
      if (
        !payload ||
        payload.jsonrpc !== "2.0" ||
        typeof payload.result !== "string" ||
        !/^0x[0-9a-fA-F]+$/.test(payload.result)
      ) {
        throw new MonadProbeError("INVALID_CHAIN_ID_RESPONSE", component);
      }

      let chainId;
      try {
        chainId = Number(BigInt(payload.result));
      } catch {
        throw new MonadProbeError("INVALID_CHAIN_ID_RESPONSE", component);
      }
      if (!Number.isSafeInteger(chainId)) {
        throw new MonadProbeError("INVALID_CHAIN_ID_RESPONSE", component);
      }
      if (chainId !== EXPECTED_CHAIN_ID) {
        throw new MonadProbeError("CHAIN_ID_MISMATCH", component);
      }

      return { ok: true, chainId };
    },
  });
}

function hasRequiredX402Support(payload) {
  if (!payload || !Array.isArray(payload.kinds)) return false;
  return payload.kinds.some((kind) => {
    if (!kind || typeof kind !== "object") return false;
    const version = Number(kind.x402Version ?? kind.version);
    const exactScheme = kind.scheme === "exact" || kind.scheme === "v2-eip155-exact";
    return version === 2 && exactScheme && kind.network === EXPECTED_NETWORK;
  });
}

async function checkFacilitator({ fetchImpl, facilitatorOrigin, timeoutMs }) {
  const component = "facilitator";
  return runWithTimeout({
    timeoutMs,
    component,
    operation: async (signal) => {
      const response = await fetchWithRedirectGuard({
        fetchImpl,
        url: `${facilitatorOrigin}/supported`,
        component,
        signal,
        init: {
          method: "GET",
          headers: { Accept: "application/json" },
        },
      });
      if (!response.ok) throw new MonadProbeError("UPSTREAM_HTTP_ERROR", component);

      const payload = await readLimitedJson(response, component);
      if (!hasRequiredX402Support(payload)) {
        throw new MonadProbeError("X402_V2_EXACT_UNSUPPORTED", component);
      }

      return {
        ok: true,
        network: EXPECTED_NETWORK,
        x402Version: 2,
        scheme: "exact",
      };
    },
  });
}

function invalidConfigurationResult({ error, checkedAt }) {
  const failure = publicError(error, "configuration");
  const notChecked = (component) => ({
    ok: false,
    error: { code: "NOT_CHECKED", component },
  });
  let rpc = notChecked("rpc");
  let facilitator = notChecked("facilitator");
  if (failure.component === "rpc") rpc = { ok: false, error: failure };
  else if (failure.component === "facilitator") facilitator = { ok: false, error: failure };
  else {
    rpc = { ok: false, error: failure };
    facilitator = { ok: false, error: failure };
  }

  return {
    ok: false,
    service: "monad-network",
    network: "monad-testnet",
    expectedChainId: EXPECTED_CHAIN_ID,
    caip2Network: EXPECTED_NETWORK,
    checks: {
      rpc,
      facilitator,
    },
    checkedAt,
  };
}

async function probeMonadNetwork({
  rpcOrigin,
  facilitatorOrigin,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetchImpl = globalThis.fetch,
  clock = () => new Date(),
} = {}) {
  const checkedAt = clock().toISOString();
  let normalizedRpcOrigin;
  let normalizedFacilitatorOrigin;

  try {
    normalizedRpcOrigin = validateHttpsOrigin(rpcOrigin, "rpc");
    normalizedFacilitatorOrigin = validateHttpsOrigin(facilitatorOrigin, "facilitator");
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
      throw new MonadProbeError("INVALID_TIMEOUT", "configuration");
    }
    if (typeof fetchImpl !== "function") {
      throw new MonadProbeError("FETCH_UNAVAILABLE", "configuration");
    }
  } catch (error) {
    return invalidConfigurationResult({ error, checkedAt });
  }

  const [rpcResult, facilitatorResult] = await Promise.allSettled([
    checkRpc({ fetchImpl, rpcOrigin: normalizedRpcOrigin, timeoutMs }),
    checkFacilitator({
      fetchImpl,
      facilitatorOrigin: normalizedFacilitatorOrigin,
      timeoutMs,
    }),
  ]);

  const rpcCheck = rpcResult.status === "fulfilled"
    ? rpcResult.value
    : { ok: false, error: publicError(rpcResult.reason, "rpc") };
  const facilitatorCheck = facilitatorResult.status === "fulfilled"
    ? facilitatorResult.value
    : { ok: false, error: publicError(facilitatorResult.reason, "facilitator") };

  return {
    ok: rpcCheck.ok && facilitatorCheck.ok,
    service: "monad-network",
    network: "monad-testnet",
    expectedChainId: EXPECTED_CHAIN_ID,
    caip2Network: EXPECTED_NETWORK,
    rpcOrigin: normalizedRpcOrigin,
    facilitatorOrigin: normalizedFacilitatorOrigin,
    checks: {
      rpc: rpcCheck,
      facilitator: facilitatorCheck,
    },
    checkedAt,
  };
}

module.exports = {
  EXPECTED_CHAIN_ID,
  EXPECTED_NETWORK,
  probeMonadNetwork,
};
