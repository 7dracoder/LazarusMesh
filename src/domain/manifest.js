'use strict';

const { createHash, timingSafeEqual } = require('node:crypto');
const { canonicalHash } = require('./canonical');

const SYNTHETIC_PIECE_COUNT = 24;
const DEFAULT_PIECE_SIZE = 64 * 1024;

function sha256(data) {
  return createHash('sha256').update(data).digest();
}

function sha256Hex(data) {
  return sha256(data).toString('hex');
}

function makePiece(index, size) {
  const station = `LM-${String(index + 1).padStart(3, '0')}`;
  const sample = JSON.stringify({
    station,
    day: `2026-07-${String(index + 1).padStart(2, '0')}`,
    rainfallMm: Number(((index * 17 + 11) % 73 / 2).toFixed(1)),
    temperatureC: Number((18 + ((index * 13) % 19) / 2).toFixed(1)),
    license: 'CC0-1.0',
  }) + '\n';
  const source = Buffer.from(sample, 'utf8');
  const piece = Buffer.alloc(size);
  for (let offset = 0; offset < piece.length; offset += source.length) {
    source.copy(piece, offset, 0, Math.min(source.length, piece.length - offset));
  }
  return piece;
}

function merkleRoot(pieceDigests) {
  let level = pieceDigests.map((digest) => Buffer.from(digest));
  while (level.length > 1) {
    const next = [];
    for (let index = 0; index < level.length; index += 2) {
      const left = level[index];
      const right = level[index + 1] || left;
      next.push(sha256(Buffer.concat([left, right])));
    }
    level = next;
  }
  return level[0].toString('hex');
}

/**
 * Create the deterministic 24-piece dataset used by the offline demo.
 * `fixtureBase64` is intentionally included so a complete recovery can run
 * without a network; production manifests would contain hashes only.
 *
 * @param {{pieceSize?: number, name?: string}} [options]
 * @returns {{schemaVersion: string, id: string, name: string, title: string,
 *   license: string, mediaType: string, pieceCount: number, pieceSize: number,
 *   totalBytes: number, artifactSha256: string, contentRootSha256: string,
 *   merkleRootSha256: string, manifestHashSha256: string,
 *   pieces: Array<{index: number, byteLength: number, sha256: string,
 *   fixtureBase64: string}>}}
 */
function createSyntheticManifest(options = {}) {
  const pieceSize = options.pieceSize === undefined
    ? DEFAULT_PIECE_SIZE
    : options.pieceSize;
  if (!Number.isSafeInteger(pieceSize) || pieceSize <= 0) {
    throw new TypeError('pieceSize must be a positive safe integer');
  }

  const name = options.name === undefined
    ? 'rainfall-model-training-sample-v1.ndjson'
    : String(options.name).trim();
  if (!name) throw new TypeError('name must not be empty');

  const rawPieces = Array.from(
    { length: SYNTHETIC_PIECE_COUNT },
    (_, index) => makePiece(index, pieceSize),
  );
  const pieceDigests = rawPieces.map((piece) => sha256(piece));
  const artifact = Buffer.concat(rawPieces);
  const artifactSha256 = sha256Hex(artifact);

  const pieces = rawPieces.map((piece, index) => ({
    index,
    byteLength: piece.length,
    sha256: pieceDigests[index].toString('hex'),
    fixtureBase64: piece.toString('base64'),
  }));

  const metadata = {
    schemaVersion: 'lazarus-manifest/v1',
    id: 'cc0-rainfall-model-training-sample-v1',
    name,
    title: 'CC0 Rainfall Model Training Sample v1',
    license: 'CC0-1.0',
    mediaType: 'application/x-ndjson',
    pieceCount: SYNTHETIC_PIECE_COUNT,
    pieceSize,
    totalBytes: artifact.length,
    artifactSha256,
    contentRootSha256: artifactSha256,
    merkleRootSha256: merkleRoot(pieceDigests),
    pieces: pieces.map(({ index, byteLength, sha256: digest }) => ({
      index,
      byteLength,
      sha256: digest,
    })),
  };

  return {
    ...metadata,
    manifestHashSha256: canonicalHash(metadata),
    pieces,
  };
}

function bytesFrom(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (typeof value === 'string') return Buffer.from(value, 'utf8');
  throw new TypeError('piece data must be a Buffer, Uint8Array, or string');
}

/**
 * Verify one piece against a manifest. It also supports
 * `verifyPiece(pieceDescriptor, data)` for worker code that already selected a
 * descriptor.
 *
 * @param {object} manifestOrDescriptor
 * @param {number|Buffer|Uint8Array|string} indexOrData
 * @param {Buffer|Uint8Array|string} [maybeData]
 * @returns {boolean}
 */
function verifyPiece(manifestOrDescriptor, indexOrData, maybeData) {
  let descriptor;
  let data;

  if (manifestOrDescriptor && Array.isArray(manifestOrDescriptor.pieces)) {
    if (!Number.isSafeInteger(indexOrData) || indexOrData < 0) return false;
    descriptor = manifestOrDescriptor.pieces[indexOrData];
    data = maybeData;
  } else {
    descriptor = manifestOrDescriptor;
    data = indexOrData;
  }

  if (!descriptor || typeof descriptor.sha256 !== 'string' || data === undefined) {
    return false;
  }

  let expected;
  try {
    expected = Buffer.from(descriptor.sha256, 'hex');
    if (expected.length !== 32 || descriptor.sha256.length !== 64) return false;
    const actual = sha256(bytesFrom(data));
    return timingSafeEqual(actual, expected);
  } catch (error) {
    if (error instanceof TypeError) return false;
    throw error;
  }
}

module.exports = {
  SYNTHETIC_PIECE_COUNT,
  DEFAULT_PIECE_SIZE,
  createSyntheticManifest,
  verifyPiece,
};
