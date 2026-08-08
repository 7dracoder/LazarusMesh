'use strict';

const { createHash } = require('node:crypto');

/**
 * Produce deterministic JSON for values committed to the local audit trail.
 * Object keys are sorted recursively. BigInts become decimal strings, dates
 * become ISO strings, and byte arrays become base64 strings. Cycles and
 * non-finite numbers are rejected instead of producing an ambiguous hash.
 *
 * @param {*} value
 * @returns {string}
 */
function canonicalStringify(value) {
  const ancestors = new Set();

  function serialize(item, inArray = false) {
    if (item === null) return 'null';

    const type = typeof item;
    if (type === 'string' || type === 'boolean') return JSON.stringify(item);
    if (type === 'number') {
      if (!Number.isFinite(item)) {
        throw new TypeError('Canonical hashes require finite numbers');
      }
      return Object.is(item, -0) ? '0' : JSON.stringify(item);
    }
    if (type === 'bigint') return JSON.stringify(item.toString(10));
    if (type === 'undefined' || type === 'function' || type === 'symbol') {
      return inArray ? 'null' : undefined;
    }

    if (item instanceof Date) {
      if (Number.isNaN(item.getTime())) {
        throw new TypeError('Canonical hashes require valid dates');
      }
      return JSON.stringify(item.toISOString());
    }

    if (Buffer.isBuffer(item) || item instanceof Uint8Array) {
      return JSON.stringify(Buffer.from(item).toString('base64'));
    }

    if (ancestors.has(item)) {
      throw new TypeError('Canonical hashes do not support cyclic values');
    }

    ancestors.add(item);
    let result;
    if (Array.isArray(item)) {
      result = `[${item.map((entry) => serialize(entry, true)).join(',')}]`;
    } else {
      const entries = [];
      for (const key of Object.keys(item).sort()) {
        const serialized = serialize(item[key], false);
        if (serialized !== undefined) {
          entries.push(`${JSON.stringify(key)}:${serialized}`);
        }
      }
      result = `{${entries.join(',')}}`;
    }
    ancestors.delete(item);
    return result;
  }

  const serialized = serialize(value, false);
  if (serialized === undefined) {
    throw new TypeError('Value cannot be represented canonically');
  }
  return serialized;
}

/**
 * Hash a value as canonical JSON with SHA-256.
 *
 * @param {*} value
 * @returns {string} lowercase, 64-character hexadecimal digest
 */
function canonicalHash(value) {
  return createHash('sha256').update(canonicalStringify(value)).digest('hex');
}

module.exports = {
  canonicalStringify,
  canonicalHash,
};
