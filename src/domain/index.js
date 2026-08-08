'use strict';

const { canonicalHash, canonicalStringify } = require('./canonical');
const {
  DEFAULT_PIECE_SIZE,
  SYNTHETIC_PIECE_COUNT,
  createSyntheticManifest,
  verifyPiece,
} = require('./manifest');
const { POLICY_REASON_CODES, evaluatePolicy } = require('./policy');
const { QUOTE_REASON_CODES, createQuoteDigest, evaluateQuote } = require('./negotiation-policy');
const { PAYMENT_RAILS, selectRail } = require('./rail');
const { DEMO_STEPS, getDemoStep, simulateRecovery } = require('./simulation');
const { MISSION_STATUSES, canTransition, assertTransition } = require('./state-machine');

/**
 * Public, dependency-free Lazarus domain API.
 *
 * Every exported operation is synchronous and safe to use in the local demo,
 * tests, server routes, and deterministic replay workers.
 */
module.exports = {
  evaluatePolicy,
  evaluateQuote,
  canTransition,
  assertTransition,
  canonicalHash,
  createQuoteDigest,
  createSyntheticManifest,
  verifyPiece,
  selectRail,
  DEMO_STEPS,

  // Supporting APIs are exported so consumers do not duplicate constants or
  // reach into implementation files.
  canonicalStringify,
  getDemoStep,
  simulateRecovery,
  MISSION_STATUSES,
  POLICY_REASON_CODES,
  QUOTE_REASON_CODES,
  PAYMENT_RAILS,
  SYNTHETIC_PIECE_COUNT,
  DEFAULT_PIECE_SIZE,
};
