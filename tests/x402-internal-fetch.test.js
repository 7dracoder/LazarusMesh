"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createInternalX402SellerFetch } = require("../src/services/x402-internal-fetch");

const RESOURCE_URL = "https://preview.example.vercel.app/api/x402/availability/root_1234567890abcdef";
const BASE_URL = "https://preview.example.vercel.app/api/x402/availability/";

function trackedSignal(controller) {
  let added = 0;
  let removed = 0;
  return {
    signal: {
      get aborted() {
        return controller.signal.aborted;
      },
      addEventListener(type, listener, options) {
        added += 1;
        controller.signal.addEventListener(type, listener, options);
      },
      removeEventListener(type, listener) {
        removed += 1;
        controller.signal.removeEventListener(type, listener);
      },
    },
    counts() {
      return { added, removed };
    },
  };
}

async function within(promise, milliseconds = 250) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("The internal fetch did not abort promptly.")), milliseconds);
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

test("internal x402 transport calls only the protected seller origin and preserves protocol headers", async () => {
  let calls = 0;
  const seller = {
    async handle(request, response, url) {
      calls += 1;
      assert.equal(request.method, "GET");
      assert.equal(request.headers["payment-signature"], "signed-payload");
      assert.equal(url.href, RESOURCE_URL);
      response.writeHead(200, {
        "Content-Type": "application/json",
        "PAYMENT-RESPONSE": "settlement-receipt",
      });
      response.end(JSON.stringify({ ok: true }));
      return true;
    },
  };
  const fetchImpl = createInternalX402SellerFetch({
    seller,
    availabilityBaseUrl: BASE_URL,
  });

  const response = await fetchImpl(
    RESOURCE_URL,
    { headers: { "payment-signature": "signed-payload" } },
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("payment-response"), "settlement-receipt");
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal(calls, 1);

  await assert.rejects(
    () => fetchImpl("https://public.example/api/x402/availability/root_1234567890abcdef"),
    (error) => error.code === "X402_INTERNAL_FETCH_URL_DENIED",
  );
  assert.equal(calls, 1);
});

test("internal x402 transport aborts a pending seller promptly and never returns its late response", async () => {
  let finishSeller;
  const seller = {
    handle(_request, response) {
      return new Promise((resolve) => {
        finishSeller = () => {
          response.writeHead(200, { "Content-Type": "application/json" });
          response.end(JSON.stringify({ late: true }));
          resolve(true);
        };
      });
    },
  };
  const fetchImpl = createInternalX402SellerFetch({ seller, availabilityBaseUrl: BASE_URL });
  const controller = new AbortController();
  const tracked = trackedSignal(controller);
  const pending = fetchImpl(RESOURCE_URL, { signal: tracked.signal });

  assert.equal(typeof finishSeller, "function");
  controller.abort();
  await assert.rejects(
    within(pending),
    (error) => error?.name === "AbortError",
  );
  assert.deepEqual(tracked.counts(), { added: 1, removed: 1 });

  finishSeller();
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(pending, (error) => error?.name === "AbortError");
});

test("internal x402 transport consumes a seller rejection that arrives after abort", async () => {
  let rejectSeller;
  const seller = {
    handle() {
      return new Promise((_, reject) => {
        rejectSeller = reject;
      });
    },
  };
  const fetchImpl = createInternalX402SellerFetch({ seller, availabilityBaseUrl: BASE_URL });
  const controller = new AbortController();
  const pending = fetchImpl(RESOURCE_URL, { signal: controller.signal });

  controller.abort();
  await assert.rejects(within(pending), (error) => error?.name === "AbortError");
  rejectSeller(new Error("late seller failure"));
  await new Promise((resolve) => setImmediate(resolve));
});

test("internal x402 transport rejects a pre-aborted signal without calling the seller", async () => {
  let calls = 0;
  const seller = {
    async handle() {
      calls += 1;
      return true;
    },
  };
  const fetchImpl = createInternalX402SellerFetch({ seller, availabilityBaseUrl: BASE_URL });
  const controller = new AbortController();
  controller.abort();
  const tracked = trackedSignal(controller);

  await assert.rejects(
    fetchImpl(RESOURCE_URL, { signal: tracked.signal }),
    (error) => error?.name === "AbortError",
  );
  assert.equal(calls, 0);
  assert.deepEqual(tracked.counts(), { added: 0, removed: 0 });
});
