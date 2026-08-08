'use strict';

const { MISSION_STATUSES } = require('./state-machine');

function frozenStep(step) {
  return Object.freeze(step);
}

/**
 * Exact ordered recovery scenes used by the offline demo and API replay.
 *
 * @type {readonly object[]}
 */
const DEMO_STEPS = Object.freeze([
  frozenStep({
    index: 0,
    status: 'DEAD',
    progress: 0,
    recoveredPieces: 0,
    totalPieces: 24,
    seeders: 0,
    title: 'Artifact unavailable',
    description: 'The CC0 manifest is known, but the swarm has zero seeders.',
  }),
  frozenStep({
    index: 1,
    status: 'DISCOVERING',
    progress: 12,
    recoveredPieces: 0,
    totalPieces: 24,
    seeders: 0,
    title: 'Agents discovering copies',
    description: 'The orchestrator queries a machine-native locator and an approved archive.',
  }),
  frozenStep({
    index: 2,
    status: 'FUNDED',
    progress: 25,
    recoveredPieces: 0,
    totalPieces: 24,
    seeders: 0,
    title: 'Bounded recovery funded',
    description: 'The bounty is escrowed and purchase authority is constrained by policy.',
  }),
  frozenStep({
    index: 3,
    status: 'RECOVERING',
    progress: 50,
    recoveredPieces: 12,
    totalPieces: 24,
    seeders: 1,
    title: 'Pieces returning',
    description: 'The selected provider restores the artifact one verified piece at a time.',
  }),
  frozenStep({
    index: 4,
    status: 'VERIFYING',
    progress: 75,
    recoveredPieces: 24,
    totalPieces: 24,
    seeders: 1,
    title: 'Verifier quorum checking',
    description: 'Independent verifiers challenge pieces and reconstruct the complete SHA-256 root.',
  }),
  frozenStep({
    index: 5,
    status: 'VERIFIED',
    progress: 86,
    recoveredPieces: 24,
    totalPieces: 24,
    seeders: 1,
    title: 'Artifact cryptographically verified',
    description: 'All 24 piece hashes and the complete artifact commitment match.',
  }),
  frozenStep({
    index: 6,
    status: 'RESEEDED',
    progress: 94,
    recoveredPieces: 24,
    totalPieces: 24,
    seeders: 2,
    title: 'Availability restored',
    description: 'Two complete preservation seeders now hold and serve the artifact.',
  }),
  frozenStep({
    index: 7,
    status: 'COMPLETED',
    progress: 100,
    recoveredPieces: 24,
    totalPieces: 24,
    seeders: 2,
    title: 'Recovery mission complete',
    description: 'The reward is released, receipts are committed, and payment authority retires.',
  }),
]);

if (DEMO_STEPS.some((step, index) => step.status !== MISSION_STATUSES[index])) {
  throw new Error('DEMO_STEPS must match the canonical mission lifecycle');
}

/**
 * Look up an immutable demo step by status.
 *
 * @param {string} status
 * @returns {object|undefined}
 */
function getDemoStep(status) {
  if (typeof status !== 'string') return undefined;
  const normalized = status.trim().toUpperCase();
  return DEMO_STEPS.find((step) => step.status === normalized);
}

/**
 * Yield the exact recovery steps between two statuses, inclusive.
 *
 * @param {{fromStatus?: string, throughStatus?: string}} [options]
 * @returns {Generator<object, void, void>}
 */
function* simulateRecovery(options = {}) {
  const from = options.fromStatus === undefined ? 'DEAD' : String(options.fromStatus).toUpperCase();
  const through = options.throughStatus === undefined
    ? 'COMPLETED'
    : String(options.throughStatus).toUpperCase();
  const start = DEMO_STEPS.findIndex((step) => step.status === from);
  const end = DEMO_STEPS.findIndex((step) => step.status === through);
  if (start === -1 || end === -1 || start > end) {
    const error = new Error(`INVALID_SIMULATION_RANGE: ${from} -> ${through}`);
    error.code = 'INVALID_SIMULATION_RANGE';
    throw error;
  }
  for (let index = start; index <= end; index += 1) {
    yield DEMO_STEPS[index];
  }
}

module.exports = {
  DEMO_STEPS,
  getDemoStep,
  simulateRecovery,
};
