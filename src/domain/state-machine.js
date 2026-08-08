'use strict';

/**
 * The one canonical mission lifecycle used by the local demo.
 *
 * Keeping this list in one place prevents the API, simulator, and UI from
 * quietly inventing different mission states.
 *
 * @type {readonly string[]}
 */
const MISSION_STATUSES = Object.freeze([
  'DEAD',
  'DISCOVERING',
  'FUNDED',
  'RECOVERING',
  'VERIFYING',
  'VERIFIED',
  'RESEEDED',
  'COMPLETED',
]);

const STATUS_INDEX = new Map(
  MISSION_STATUSES.map((status, index) => [status, index]),
);

/**
 * Normalize a status or an object carrying a `status` field.
 *
 * @param {string|{status: string}} value
 * @returns {string|null}
 */
function normalizeStatus(value) {
  const status = typeof value === 'string' ? value : value && value.status;
  if (typeof status !== 'string') return null;
  const normalized = status.trim().toUpperCase();
  return STATUS_INDEX.has(normalized) ? normalized : null;
}

/**
 * Return true only for the next legal forward mission transition.
 * Same-state, skipped, backward, and unknown transitions are rejected.
 *
 * @param {string|{status: string}} from
 * @param {string|{status: string}} to
 * @returns {boolean}
 */
function canTransition(from, to) {
  const current = normalizeStatus(from);
  const next = normalizeStatus(to);
  if (!current || !next) return false;
  return STATUS_INDEX.get(next) === STATUS_INDEX.get(current) + 1;
}

/**
 * Assert that a mission can move from `from` to `to`.
 *
 * @param {string|{status: string}} from
 * @param {string|{status: string}} to
 * @returns {string} normalized target status
 * @throws {Error} with code `INVALID_MISSION_TRANSITION`
 */
function assertTransition(from, to) {
  const current = normalizeStatus(from);
  const next = normalizeStatus(to);

  if (!canTransition(current, next)) {
    const error = new Error(
      `INVALID_MISSION_TRANSITION: ${current || String(from)} -> ${next || String(to)}`,
    );
    error.code = 'INVALID_MISSION_TRANSITION';
    error.from = current;
    error.to = next;
    throw error;
  }

  return next;
}

module.exports = {
  MISSION_STATUSES,
  canTransition,
  assertTransition,
};
