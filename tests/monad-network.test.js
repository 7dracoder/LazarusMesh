"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  EXPECTED_CHAIN_ID,
  EXPECTED_NETWORK,
  probeMonadNetwork,
} = require("../src/services/monad-network");

const RPC_ORIGIN = "https://rpc.example.test";
const FACILITATOR_ORIGIN = "https://facilitator.example.test";
const fixedClock = () => new Date("2026-08-08T12:00:00.000Z");

function jsonResponse(value, init = {}) {
  return new Response(JSON.stringify(value), {
    status: init.status || 200,
    headers: {
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
}

function supportedPayload(overrides = {}) {
  return {
    kinds: [
      {
        x402Version: 2,
        scheme: "exact",
        network: EXPECTED_NETWORK,
        ...overrides,
      },
    ],
  };
}

test("Monad readiness probe returns only public metadata after both checks pass", async () => {
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url, init });
    if (url === `${RPC_ORIGIN}/`) {
      return jsonResponse({
        jsonrpc: "2.0",
        id: "monad-readiness",
        result: `0x${EXPECTED_CHAIN_ID.toString(16)}`,
      });
    }
    if (url === `${FACILITATOR_ORIGIN}/supported`) {
      return jsonResponse(supportedPayload());
    }
    throw new Error("unexpected URL");
  };

  const result = await probeMonadNetwork({
    rpcOrigin: RPC_ORIGIN,
    facilitatorOrigin: FACILITATOR_ORIGIN,
    fetchImpl,
    clock: fixedClock,
  });

  assert.deepEqual(result, {
    ok: true,
    service: "monad-network",
    network: "monad-testnet",
    expectedChainId: 10143,
    caip2Network: "eip155:10143",
    rpcOrigin: RPC_ORIGIN,
    facilitatorOrigin: FACILITATOR_ORIGIN,
    checks: {
      rpc: { ok: true, chainId: 10143 },
      facilitator: {
        ok: true,
        network: "eip155:10143",
        x402Version: 2,
        scheme: "exact",
      },
    },
    checkedAt: "2026-08-08T12:00:00.000Z",
  });

  const rpcRequest = requests.find((request) => request.url === `${RPC_ORIGIN}/`);
  assert.equal(rpcRequest.init.method, "POST");
  assert.equal(rpcRequest.init.redirect, "manual");
  assert.equal(rpcRequest.init.signal instanceof AbortSignal, true);
  assert.deepEqual(JSON.parse(rpcRequest.init.body), {
    jsonrpc: "2.0",
    id: "monad-readiness",
    method: "eth_chainId",
    params: [],
  });

  const facilitatorRequest = requests.find(
    (request) => request.url === `${FACILITATOR_ORIGIN}/supported`,
  );
  assert.equal(facilitatorRequest.init.method, "GET");
  assert.equal(facilitatorRequest.init.body, undefined);
  assert.equal("privateKey" in result, false);
  assert.equal("payload" in result.checks.facilitator, false);
});

test("Monad readiness probe rejects non-HTTPS and non-origin configuration without fetching", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    throw new Error("must not fetch");
  };

  const insecure = await probeMonadNetwork({
    rpcOrigin: "http://rpc.example.test",
    facilitatorOrigin: FACILITATOR_ORIGIN,
    fetchImpl,
    clock: fixedClock,
  });
  assert.equal(insecure.ok, false);
  assert.equal(insecure.checks.rpc.error.code, "INVALID_HTTPS_ORIGIN");

  const pathBearing = await probeMonadNetwork({
    rpcOrigin: RPC_ORIGIN,
    facilitatorOrigin: `${FACILITATOR_ORIGIN}/secret-path`,
    fetchImpl,
    clock: fixedClock,
  });
  assert.equal(pathBearing.ok, false);
  assert.equal(JSON.stringify(pathBearing).includes("secret-path"), false);
  assert.equal(calls, 0);
});

test("Monad readiness probe requires chain ID 10143 and sanitizes RPC bodies", async () => {
  const bodySecret = "upstream-secret-that-must-not-leak";
  const result = await probeMonadNetwork({
    rpcOrigin: RPC_ORIGIN,
    facilitatorOrigin: FACILITATOR_ORIGIN,
    clock: fixedClock,
    fetchImpl: async (url) => {
      if (url === `${RPC_ORIGIN}/`) {
        return jsonResponse({
          jsonrpc: "2.0",
          result: "0x1",
          diagnostic: bodySecret,
        });
      }
      return jsonResponse(supportedPayload());
    },
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.checks.rpc, {
    ok: false,
    error: { code: "CHAIN_ID_MISMATCH", component: "rpc" },
  });
  assert.equal(result.checks.facilitator.ok, true);
  assert.equal(JSON.stringify(result).includes(bodySecret), false);
});

test("Monad readiness probe requires x402 v2 exact support on eip155:10143", async () => {
  const result = await probeMonadNetwork({
    rpcOrigin: RPC_ORIGIN,
    facilitatorOrigin: FACILITATOR_ORIGIN,
    clock: fixedClock,
    fetchImpl: async (url) => {
      if (url === `${RPC_ORIGIN}/`) {
        return jsonResponse({ jsonrpc: "2.0", result: "0x279f" });
      }
      return jsonResponse(supportedPayload({
        x402Version: 1,
        network: "eip155:84532",
      }));
    },
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.checks.facilitator, {
    ok: false,
    error: { code: "X402_V2_EXACT_UNSUPPORTED", component: "facilitator" },
  });
});

test("Monad readiness probe follows only safe same-origin redirects", async () => {
  const calls = [];
  const result = await probeMonadNetwork({
    rpcOrigin: RPC_ORIGIN,
    facilitatorOrigin: FACILITATOR_ORIGIN,
    clock: fixedClock,
    fetchImpl: async (url, init) => {
      calls.push({ url, method: init.method });
      if (url === `${RPC_ORIGIN}/`) {
        return new Response(null, {
          status: 307,
          headers: { Location: "/rpc-v2" },
        });
      }
      if (url === `${RPC_ORIGIN}/rpc-v2`) {
        return jsonResponse({ jsonrpc: "2.0", result: "0x279f" });
      }
      return jsonResponse(supportedPayload());
    },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(
    calls.filter((call) => call.url.startsWith(RPC_ORIGIN)),
    [
      { url: `${RPC_ORIGIN}/`, method: "POST" },
      { url: `${RPC_ORIGIN}/rpc-v2`, method: "POST" },
    ],
  );
});

test("Monad readiness probe blocks cross-origin redirects without leaking the target", async () => {
  let redirectedFetches = 0;
  const redirectTarget = "https://attacker.example/collect?token=secret";
  const result = await probeMonadNetwork({
    rpcOrigin: RPC_ORIGIN,
    facilitatorOrigin: FACILITATOR_ORIGIN,
    clock: fixedClock,
    fetchImpl: async (url) => {
      if (url === `${RPC_ORIGIN}/`) {
        return new Response(null, {
          status: 307,
          headers: { Location: redirectTarget },
        });
      }
      if (url.startsWith("https://attacker.example")) redirectedFetches += 1;
      return jsonResponse(supportedPayload());
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.checks.rpc.error.code, "CROSS_ORIGIN_REDIRECT_BLOCKED");
  assert.equal(redirectedFetches, 0);
  assert.equal(JSON.stringify(result).includes("attacker.example"), false);
  assert.equal(JSON.stringify(result).includes("secret"), false);
});

test("Monad readiness probe aborts timed-out requests and returns sanitized failures", async () => {
  const fetchImpl = async (_url, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener("abort", () => {
      reject(new DOMException("sensitive upstream timeout details", "AbortError"));
    }, { once: true });
  });

  const result = await probeMonadNetwork({
    rpcOrigin: RPC_ORIGIN,
    facilitatorOrigin: FACILITATOR_ORIGIN,
    timeoutMs: 5,
    fetchImpl,
    clock: fixedClock,
  });

  assert.equal(result.ok, false);
  assert.equal(result.checks.rpc.error.code, "UPSTREAM_TIMEOUT");
  assert.equal(result.checks.facilitator.error.code, "UPSTREAM_TIMEOUT");
  assert.equal(JSON.stringify(result).includes("sensitive"), false);
});

test("Monad readiness timeout covers response-body reads", async () => {
  const hangingResponse = {
    status: 200,
    ok: true,
    url: "",
    headers: { get: () => null },
    body: {
      getReader: () => ({
        read: () => new Promise(() => {}),
        cancel: async () => {},
      }),
    },
  };

  const result = await probeMonadNetwork({
    rpcOrigin: RPC_ORIGIN,
    facilitatorOrigin: FACILITATOR_ORIGIN,
    timeoutMs: 5,
    clock: fixedClock,
    fetchImpl: async (url) => (
      url === `${RPC_ORIGIN}/`
        ? hangingResponse
        : jsonResponse(supportedPayload())
    ),
  });

  assert.equal(result.ok, false);
  assert.equal(result.checks.rpc.error.code, "UPSTREAM_TIMEOUT");
  assert.equal(result.checks.facilitator.ok, true);
});
