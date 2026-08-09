"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  CURRENCIES,
  RATE_SET_ID,
  fromAccountingMinorUp,
  maximumDisplayMinor,
  minimumDisplayMinor,
  normalizeCurrency,
  publicCurrencyConfig,
  toAccountingMinorUp,
} = require("../src/domain/currency");

test("mission currency catalog is explicit and excludes settlement assets", () => {
  assert.deepEqual(Object.keys(CURRENCIES), ["USD", "EUR", "GBP", "CAD", "AUD"]);
  assert.equal(normalizeCurrency(" eur "), "EUR");
  for (const unsupported of ["JPY", "INR", "USDC", "MON", "BTC", ""]) {
    assert.equal(normalizeCurrency(unsupported, ""), null);
  }

  const config = publicCurrencyConfig();
  assert.equal(config.rateSet, RATE_SET_ID);
  assert.equal(config.mode, "demo-fixed-not-market-rate");
  assert.match(config.disclaimer, /not live/i);
});

test("fixed demo conversion uses integer rational math and rounds debits up", () => {
  assert.equal(fromAccountingMinorUp(1201, "USD"), 1201);
  assert.equal(fromAccountingMinorUp(1201, "EUR"), 1105);
  assert.equal(fromAccountingMinorUp(1201, "GBP"), 937);
  assert.equal(fromAccountingMinorUp(1201, "CAD"), 1646);
  assert.equal(fromAccountingMinorUp(1201, "AUD"), 1826);

  assert.equal(fromAccountingMinorUp(975, "GBP"), 761);
  assert.equal(fromAccountingMinorUp(1, "CAD"), 2);
  assert.equal(toAccountingMinorUp(761, "GBP"), 976);
});

test("currency-specific mission limits preserve the canonical USD envelope", () => {
  assert.equal(minimumDisplayMinor(1201, "EUR"), 1105);
  assert.equal(maximumDisplayMinor(500_000, "EUR"), 460_000);
  assert.equal(minimumDisplayMinor(100, "CAD"), 137);
  assert.equal(maximumDisplayMinor(100_000, "AUD"), 152_000);
});

test("currency conversion rejects unsupported and unsafe amounts", () => {
  assert.throws(() => fromAccountingMinorUp(100, "USDC"), /Unsupported/);
  assert.throws(() => fromAccountingMinorUp(-1, "USD"), /non-negative/);
  assert.throws(() => fromAccountingMinorUp(Number.MAX_SAFE_INTEGER, "AUD"), (error) => (
    error.code === "CURRENCY_AMOUNT_OVERFLOW"
  ));
});
