"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createInternalX402SellerFetch } = require("../src/services/x402-internal-fetch");

test("internal x402 transport calls only the protected seller origin and preserves protocol headers", async () => {
  let calls = 0;
  const seller = {
    async handle(request, response, url) {
      calls += 1;
      assert.equal(request.method, "GET");
      assert.equal(request.headers["payment-signature"], "signed-payload");
      assert.equal(url.href, "https://preview.example.vercel.app/api/x402/availability/root_1234567890abcdef");
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
    availabilityBaseUrl: "https://preview.example.vercel.app/api/x402/availability/",
  });

  const response = await fetchImpl(
    "https://preview.example.vercel.app/api/x402/availability/root_1234567890abcdef",
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
