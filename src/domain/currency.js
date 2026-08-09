"use strict";

/**
 * Deterministic mission-accounting currency table for the public demo.
 *
 * These are deliberately fixed reference values, not market FX rates. All
 * mission policy amounts use the selected currency's minor units. Rain's
 * sandbox authorization rail remains USD-only, while Monad x402 settlement
 * remains test USDC atomic units when enabled.
 */
const RATE_SET_ID = "lazarus-demo-reference-v1";
const ACCOUNTING_CURRENCY = "USD";

const CURRENCIES = Object.freeze({
  USD: Object.freeze({ code: "USD", label: "US Dollar", minorDigits: 2, minorPerUsd: 100 }),
  EUR: Object.freeze({ code: "EUR", label: "Euro", minorDigits: 2, minorPerUsd: 92 }),
  GBP: Object.freeze({ code: "GBP", label: "British Pound", minorDigits: 2, minorPerUsd: 78 }),
  CAD: Object.freeze({ code: "CAD", label: "Canadian Dollar", minorDigits: 2, minorPerUsd: 137 }),
  AUD: Object.freeze({ code: "AUD", label: "Australian Dollar", minorDigits: 2, minorPerUsd: 152 }),
});

function normalizeCurrency(value, fallback = ACCOUNTING_CURRENCY) {
  const code = String(value ?? fallback).trim().toUpperCase();
  return Object.hasOwn(CURRENCIES, code) ? code : null;
}

function currencyInfo(currency) {
  const code = normalizeCurrency(currency, "");
  return code ? CURRENCIES[code] : null;
}

function assertMinor(value, field = "amountMinor") {
  if (!Number.isSafeInteger(value) || value < 0) {
    const error = new Error(`${field} must be a non-negative safe integer.`);
    error.code = "INVALID_CURRENCY_AMOUNT";
    throw error;
  }
  return value;
}

function safeNumber(value) {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) {
    const error = new Error("Converted amount exceeds the safe integer range.");
    error.code = "CURRENCY_AMOUNT_OVERFLOW";
    throw error;
  }
  return number;
}

function divideRounded(numerator, denominator) {
  return (numerator + (denominator / 2n)) / denominator;
}

function toAccountingMinor(displayMinor, currency) {
  assertMinor(displayMinor, "displayMinor");
  const info = currencyInfo(currency);
  if (!info) {
    const error = new Error("Unsupported mission accounting currency.");
    error.code = "CURRENCY_NOT_SUPPORTED";
    throw error;
  }
  return safeNumber(divideRounded(BigInt(displayMinor) * 100n, BigInt(info.minorPerUsd)));
}

function fromAccountingMinor(accountingMinor, currency) {
  assertMinor(accountingMinor, "accountingMinor");
  const info = currencyInfo(currency);
  if (!info) {
    const error = new Error("Unsupported mission accounting currency.");
    error.code = "CURRENCY_NOT_SUPPORTED";
    throw error;
  }
  return safeNumber(divideRounded(BigInt(accountingMinor) * BigInt(info.minorPerUsd), 100n));
}

/** Convert a USD-cent debit/reservation into mission currency, rounding up. */
function fromAccountingMinorUp(accountingMinor, currency) {
  assertMinor(accountingMinor, "accountingMinor");
  const info = currencyInfo(currency);
  if (!info) {
    const error = new Error("Unsupported mission accounting currency.");
    error.code = "CURRENCY_NOT_SUPPORTED";
    throw error;
  }
  const numerator = BigInt(accountingMinor) * BigInt(info.minorPerUsd);
  return safeNumber((numerator + 99n) / 100n);
}

/** Convert a mission-currency debit into USD cents, rounding up. */
function toAccountingMinorUp(displayMinor, currency) {
  assertMinor(displayMinor, "displayMinor");
  const info = currencyInfo(currency);
  if (!info) {
    const error = new Error("Unsupported mission accounting currency.");
    error.code = "CURRENCY_NOT_SUPPORTED";
    throw error;
  }
  const numerator = BigInt(displayMinor) * 100n;
  const denominator = BigInt(info.minorPerUsd);
  return safeNumber((numerator + denominator - 1n) / denominator);
}

function minimumDisplayMinor(accountingMinimumMinor, currency) {
  assertMinor(accountingMinimumMinor, "accountingMinimumMinor");
  const info = currencyInfo(currency);
  if (!info) {
    const error = new Error("Unsupported mission accounting currency.");
    error.code = "CURRENCY_NOT_SUPPORTED";
    throw error;
  }
  const numerator = BigInt(accountingMinimumMinor) * BigInt(info.minorPerUsd);
  return safeNumber((numerator + 99n) / 100n);
}

function maximumDisplayMinor(accountingMaximumMinor, currency) {
  assertMinor(accountingMaximumMinor, "accountingMaximumMinor");
  const info = currencyInfo(currency);
  if (!info) {
    const error = new Error("Unsupported mission accounting currency.");
    error.code = "CURRENCY_NOT_SUPPORTED";
    throw error;
  }
  return safeNumber((BigInt(accountingMaximumMinor) * BigInt(info.minorPerUsd)) / 100n);
}

function publicCurrencyConfig() {
  return {
    rateSet: RATE_SET_ID,
    referenceCurrency: ACCOUNTING_CURRENCY,
    mode: "demo-fixed-not-market-rate",
    disclaimer: "Fixed demo reference values; not live foreign-exchange rates or a conversion service.",
    supported: Object.values(CURRENCIES).map((currency) => ({ ...currency })),
  };
}

module.exports = {
  ACCOUNTING_CURRENCY,
  CURRENCIES,
  RATE_SET_ID,
  currencyInfo,
  fromAccountingMinor,
  fromAccountingMinorUp,
  maximumDisplayMinor,
  minimumDisplayMinor,
  normalizeCurrency,
  publicCurrencyConfig,
  toAccountingMinor,
  toAccountingMinorUp,
};
