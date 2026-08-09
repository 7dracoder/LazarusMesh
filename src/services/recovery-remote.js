'use strict';

const crypto = require('node:crypto');
const { normalizeCurrency } = require('../domain/currency');
const { validateBaseUrl } = require('./negotiation-remote');

const REMOTE_PROVIDER = Object.freeze({
  providerId: 'provider_lazarus_operator',
  providerName: 'Lazarus Recovery Merchant',
  merchantId: 'merchant_lazarus_operator',
  merchantName: 'Lazarus Recovery Merchant',
});

const HASH_PATTERN = /^[a-f0-9]{64}$/;
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_RESPONSE_LIMIT_BYTES = 1_048_576;
const DEFAULT_MAXIMUM_PIECE_BYTES = 1_048_576;
const DEFAULT_MAXIMUM_TOTAL_BYTES = 32 * 1_048_576;
const MAXIMUM_PIECES = 128;

class RemoteRecoveryError extends Error {
  constructor(code, message, { statusCode = 502 } = {}) {
    super(message);
    this.name = 'RemoteRecoveryError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

class RemoteRecoveryAdapter {
  constructor({
    baseUrl,
    apiToken,
    trustedManifest,
    currency,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    responseLimitBytes = DEFAULT_RESPONSE_LIMIT_BYTES,
    maximumPieceBytes = DEFAULT_MAXIMUM_PIECE_BYTES,
    maximumTotalBytes = DEFAULT_MAXIMUM_TOTAL_BYTES,
    fetchImpl = globalThis.fetch,
  } = {}) {
    this.baseUrl = validateBaseUrl(baseUrl, 'Provider');
    defineSecret(this, 'apiToken', requiredString(apiToken, 'apiToken'));
    this.timeoutMs = positiveInteger(timeoutMs, 'timeoutMs', 30_000);
    this.responseLimitBytes = positiveInteger(
      responseLimitBytes,
      'responseLimitBytes',
      1_048_576,
    );
    this.maximumPieceBytes = positiveInteger(
      maximumPieceBytes,
      'maximumPieceBytes',
      16 * 1_048_576,
    );
    this.maximumTotalBytes = positiveInteger(
      maximumTotalBytes,
      'maximumTotalBytes',
      512 * 1_048_576,
    );
    if (typeof fetchImpl !== 'function') throw configurationError('fetchImpl must be a function.');
    this.fetch = fetchImpl;
    this.currency = validateCurrency(currency);
    this.trustedManifest = normalizeTrustedManifest(trustedManifest, {
      maximumPieceBytes: this.maximumPieceBytes,
      maximumTotalBytes: this.maximumTotalBytes,
    });
    this.publicManifest = toLazarusManifest(this.trustedManifest);
    this.mode = 'remote-provider';
    this.networkedProviders = true;
    this.persistentReseeding = false;
    this.provider = REMOTE_PROVIDER;
    this.merchant = Object.freeze({
      merchantId: REMOTE_PROVIDER.merchantId,
      merchantName: REMOTE_PROVIDER.merchantName,
    });
    this.supportedCurrencies = Object.freeze([this.currency]);
    this.sessions = new Map();
  }

  reset() {
    this.sessions.clear();
  }

  buildManifest(pieceCount) {
    if (pieceCount !== undefined && pieceCount !== this.publicManifest.totalPieces) {
      throw new RemoteRecoveryError(
        'TRUSTED_MANIFEST_PIECE_COUNT_MISMATCH',
        'Requested piece count does not match the pinned provider manifest.',
        { statusCode: 422 },
      );
    }
    return clone(this.publicManifest);
  }

  start(missionId, expectedManifest) {
    missionId = requiredIdentifier(missionId, 'missionId');
    validateExpectedManifest(expectedManifest, this.publicManifest);
    this.sessions.set(missionId, {
      manifestVerified: false,
      manifestPromise: null,
      recovered: new Map(),
      verified: new Set(),
    });
    return this.progress(missionId);
  }

  async verifyPinnedManifest(missionId) {
    const session = this.requireSession(missionId);
    if (session.manifestVerified) return clone(this.publicManifest);
    if (!session.manifestPromise) {
      session.manifestPromise = this.requestJson(
        `/api/artifacts/${encodeURIComponent(this.trustedManifest.merkleRootSha256)}/manifest`,
      ).then((manifest) => {
        const normalized = normalizeTrustedManifest(manifest, {
          maximumPieceBytes: this.maximumPieceBytes,
          maximumTotalBytes: this.maximumTotalBytes,
        });
        if (!manifestEqual(normalized, this.trustedManifest)) {
          throw new RemoteRecoveryError(
            'PROVIDER_MANIFEST_PIN_MISMATCH',
            'Provider manifest does not match the pinned trusted manifest.',
            { statusCode: 422 },
          );
        }
        session.manifestVerified = true;
        return normalized;
      }).finally(() => {
        session.manifestPromise = null;
      });
    }
    await session.manifestPromise;
    return clone(this.publicManifest);
  }

  async health() {
    const manifest = await this.requestJson(
      `/api/artifacts/${encodeURIComponent(this.trustedManifest.merkleRootSha256)}/manifest`,
    );
    const normalized = normalizeTrustedManifest(manifest, {
      maximumPieceBytes: this.maximumPieceBytes,
      maximumTotalBytes: this.maximumTotalBytes,
    });
    if (!manifestEqual(normalized, this.trustedManifest)) {
      throw new RemoteRecoveryError(
        'PROVIDER_MANIFEST_PIN_MISMATCH',
        'Provider manifest does not match the pinned trusted manifest.',
        { statusCode: 422 },
      );
    }
    return {
      ok: true,
      mode: this.mode,
      authenticated: true,
      manifestPinned: true,
      contentRoot: this.publicManifest.contentRoot,
      pieceCount: this.publicManifest.totalPieces,
    };
  }

  async recoverThrough(missionId, targetCount) {
    const session = this.requireSession(missionId);
    if (!Number.isSafeInteger(targetCount) || targetCount < 0) {
      throw new RemoteRecoveryError('RECOVERY_TARGET_INVALID', 'Recovery target must be a non-negative safe integer.', {
        statusCode: 422,
      });
    }
    await this.verifyPinnedManifest(missionId);
    const target = Math.min(targetCount, this.trustedManifest.pieceCount);
    for (let index = 0; index < target; index += 1) {
      if (session.recovered.has(index)) continue;
      const descriptor = this.trustedManifest.pieces[index];
      const bytes = await this.requestBytes(
        `/api/artifacts/${this.trustedManifest.merkleRootSha256}/pieces/${index}`,
        Math.min(this.maximumPieceBytes, descriptor.byteLength),
      );
      if (bytes.length !== descriptor.byteLength) {
        throw new RemoteRecoveryError(
          `PIECE_SIZE_MISMATCH:${index}`,
          `Recovered piece ${index} has the wrong byte length.`,
          { statusCode: 422 },
        );
      }
      session.recovered.set(index, bytes);
    }
    return this.progress(missionId);
  }

  verifyAll(missionId) {
    const session = this.requireSession(missionId);
    if (!session.manifestVerified) {
      throw new RemoteRecoveryError('PROVIDER_MANIFEST_NOT_VERIFIED', 'Provider manifest must be verified before piece verification.', {
        statusCode: 409,
      });
    }
    for (const [index, bytes] of session.recovered) {
      const descriptor = this.trustedManifest.pieces[index];
      if (bytes.length !== descriptor.byteLength || sha256(bytes) !== descriptor.sha256) {
        throw new RemoteRecoveryError(
          `PIECE_HASH_MISMATCH:${index}`,
          `Recovered piece ${index} failed its pinned hash check.`,
          { statusCode: 422 },
        );
      }
      session.verified.add(index);
    }
    return this.progress(missionId);
  }

  reconstruct(missionId) {
    const session = this.requireSession(missionId);
    if (session.verified.size !== this.trustedManifest.pieceCount) {
      throw new RemoteRecoveryError('ARTIFACT_INCOMPLETE', 'The pinned artifact is incomplete.', {
        statusCode: 409,
      });
    }
    const bytes = Buffer.concat(Array.from(
      { length: this.trustedManifest.pieceCount },
      (_, index) => session.recovered.get(index),
    ));
    const contentSha256 = sha256(bytes);
    if (bytes.length !== this.trustedManifest.totalBytes || contentSha256 !== this.trustedManifest.artifactSha256) {
      throw new RemoteRecoveryError('ARTIFACT_HASH_MISMATCH', 'Reconstructed artifact does not match the pinned digest.', {
        statusCode: 422,
      });
    }
    return { bytes: bytes.length, contentSha256, matches: true };
  }

  progress(missionId) {
    const session = this.requireSession(missionId);
    return {
      total: this.trustedManifest.pieceCount,
      recovered: session.recovered.size,
      verified: session.verified.size,
      bitmap: this.trustedManifest.pieces.map((piece) => ({
        index: piece.index,
        state: session.verified.has(piece.index)
          ? 'verified'
          : session.recovered.has(piece.index) ? 'recovered' : 'missing',
        hash: piece.sha256.slice(0, 12),
      })),
    };
  }

  requireSession(missionId) {
    missionId = requiredIdentifier(missionId, 'missionId');
    const session = this.sessions.get(missionId);
    if (!session) {
      throw new RemoteRecoveryError('RECOVERY_SESSION_NOT_FOUND', 'Recovery session was not initialized.', {
        statusCode: 409,
      });
    }
    return session;
  }

  async requestJson(pathname) {
    const bytes = await this.request(pathname, this.responseLimitBytes, 'application/json');
    try {
      const parsed = JSON.parse(bytes.toString('utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('object required');
      return parsed;
    } catch {
      throw new RemoteRecoveryError('PROVIDER_RESPONSE_INVALID', 'Provider returned invalid manifest JSON.');
    }
  }

  requestBytes(pathname, maximum) {
    return this.request(pathname, maximum, 'application/octet-stream');
  }

  async request(pathname, maximum, accept) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      let response;
      try {
        response = await this.fetch(new URL(pathname, this.baseUrl), {
          redirect: 'error',
          signal: controller.signal,
          headers: {
            Accept: accept,
            Authorization: `Bearer ${this.apiToken}`,
          },
        });
      } catch (error) {
        if (controller.signal.aborted || error?.name === 'AbortError') {
          throw new RemoteRecoveryError('PROVIDER_REQUEST_TIMEOUT', 'Provider request timed out.');
        }
        throw new RemoteRecoveryError('PROVIDER_UNREACHABLE', 'Provider endpoint could not be reached.');
      }
      const bytes = await boundedBytes(response, maximum);
      if (!response.ok) {
        throw new RemoteRecoveryError(
          'PROVIDER_REQUEST_FAILED',
          `Provider request failed with status ${response.status}.`,
          { statusCode: response.status >= 500 ? 502 : response.status },
        );
      }
      return bytes;
    } finally {
      clearTimeout(timer);
    }
  }

  toJSON() {
    return {
      mode: this.mode,
      networkedProviders: true,
      persistentReseeding: false,
      provider: this.provider,
      merchant: this.merchant,
      supportedCurrencies: this.supportedCurrencies,
      contentRoot: this.publicManifest.contentRoot,
      pieceCount: this.publicManifest.totalPieces,
    };
  }
}

function normalizeTrustedManifest(manifest, {
  maximumPieceBytes = DEFAULT_MAXIMUM_PIECE_BYTES,
  maximumTotalBytes = DEFAULT_MAXIMUM_TOTAL_BYTES,
} = {}) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw configurationError('trustedManifest must be an object.');
  }
  if (manifest.schema !== 'lazarus-artifact-manifest-v1') {
    throw configurationError('trustedManifest schema is unsupported.');
  }
  const name = boundedString(manifest.name, 'trustedManifest.name', 255);
  const license = boundedString(manifest.license, 'trustedManifest.license', 64);
  const totalBytes = boundedInteger(manifest.totalBytes, 'trustedManifest.totalBytes', 1, maximumTotalBytes);
  const pieceCount = boundedInteger(manifest.pieceCount, 'trustedManifest.pieceCount', 1, MAXIMUM_PIECES);
  const artifactSha256 = hash(manifest.artifactSha256, 'trustedManifest.artifactSha256');
  const contentRootSha256 = hash(manifest.contentRootSha256, 'trustedManifest.contentRootSha256');
  const merkleRootSha256 = hash(manifest.merkleRootSha256, 'trustedManifest.merkleRootSha256');
  if (artifactSha256 !== contentRootSha256) {
    throw configurationError('trustedManifest content digest does not match the artifact digest.');
  }
  if (!Array.isArray(manifest.pieces) || manifest.pieces.length !== pieceCount) {
    throw configurationError('trustedManifest piece list does not match pieceCount.');
  }

  let describedBytes = 0;
  const pieces = manifest.pieces.map((piece, index) => {
    if (!piece || typeof piece !== 'object' || Array.isArray(piece) || piece.index !== index) {
      throw configurationError(`trustedManifest piece ${index} is invalid.`);
    }
    const byteLength = boundedInteger(
      piece.byteLength,
      `trustedManifest.pieces[${index}].byteLength`,
      0,
      maximumPieceBytes,
    );
    describedBytes += byteLength;
    return Object.freeze({
      index,
      sha256: hash(piece.sha256, `trustedManifest.pieces[${index}].sha256`),
      byteLength,
    });
  });
  if (describedBytes !== totalBytes) {
    throw configurationError('trustedManifest piece sizes do not match totalBytes.');
  }
  if (merkleRoot(pieces.map((piece) => piece.sha256)) !== merkleRootSha256) {
    throw configurationError('trustedManifest Merkle root is invalid.');
  }

  return Object.freeze({
    schema: 'lazarus-artifact-manifest-v1',
    name,
    license,
    totalBytes,
    pieceCount,
    artifactSha256,
    contentRootSha256,
    merkleRootSha256,
    pieces: Object.freeze(pieces),
  });
}

function toLazarusManifest(manifest) {
  return Object.freeze({
    name: manifest.name,
    license: manifest.license,
    totalBytes: manifest.totalBytes,
    totalPieces: manifest.pieceCount,
    contentSha256: manifest.artifactSha256,
    contentRoot: manifest.merkleRootSha256,
    pieces: Object.freeze(manifest.pieces.map((piece) => Object.freeze({
      index: piece.index,
      hash: piece.sha256,
      size: piece.byteLength,
    }))),
  });
}

function validateExpectedManifest(expected, trusted) {
  if (!expected || typeof expected !== 'object' || Array.isArray(expected)) {
    throw new RemoteRecoveryError('EXPECTED_MANIFEST_INVALID', 'Expected mission manifest is required.', {
      statusCode: 422,
    });
  }
  const comparable = {
    name: expected.name,
    license: expected.license,
    totalBytes: expected.totalBytes,
    totalPieces: expected.totalPieces,
    contentSha256: expected.contentSha256,
    contentRoot: expected.contentRoot,
    pieces: expected.pieces,
  };
  if (canonicalStringify(comparable) !== canonicalStringify(trusted)) {
    throw new RemoteRecoveryError('EXPECTED_MANIFEST_PIN_MISMATCH', 'Mission manifest does not match the pinned provider manifest.', {
      statusCode: 422,
    });
  }
}

function manifestEqual(left, right) {
  return canonicalStringify(left) === canonicalStringify(right);
}

function canonicalStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalStringify(value[key])}`).join(',')}}`;
}

function clone(value) {
  return structuredClone(value);
}

function validateCurrency(value) {
  const currency = normalizeCurrency(value, '');
  if (!currency) throw configurationError('currency must be USD, EUR, GBP, CAD, or AUD.');
  return currency;
}

function hash(value, name) {
  if (typeof value !== 'string' || !HASH_PATTERN.test(value)) {
    throw configurationError(`${name} must be a lowercase SHA-256 digest.`);
  }
  return value;
}

function boundedString(value, name, maximum) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > maximum) {
    throw configurationError(`${name} is invalid.`);
  }
  return value.trim();
}

function boundedInteger(value, name, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw configurationError(`${name} must be an integer from ${minimum} to ${maximum}.`);
  }
  return value;
}

function positiveInteger(value, name, maximum) {
  return boundedInteger(value, name, 1, maximum);
}

function requiredString(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw configurationError(`${name} is required.`);
  return value.trim();
}

function requiredIdentifier(value, name) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value)) {
    throw new RemoteRecoveryError('RECOVERY_IDENTIFIER_INVALID', `${name} is invalid.`, { statusCode: 422 });
  }
  return value;
}

function configurationError(message) {
  return new RemoteRecoveryError('PROVIDER_INVALID_CONFIGURATION', message, { statusCode: 500 });
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function merkleRoot(hashes) {
  let level = hashes.map((digest) => Buffer.from(digest, 'hex'));
  while (level.length > 1) {
    const next = [];
    for (let index = 0; index < level.length; index += 2) {
      next.push(Buffer.from(sha256(Buffer.concat([level[index], level[index + 1] || level[index]])), 'hex'));
    }
    level = next;
  }
  return level[0]?.toString('hex') || sha256(Buffer.alloc(0));
}

async function boundedBytes(response, maximum) {
  const declared = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > maximum) {
    throw new RemoteRecoveryError('PROVIDER_RESPONSE_TOO_LARGE', 'Provider response exceeded the configured limit.');
  }
  const chunks = [];
  let length = 0;
  for await (const chunk of response.body || []) {
    const bytes = Buffer.from(chunk);
    length += bytes.length;
    if (length > maximum) {
      throw new RemoteRecoveryError('PROVIDER_RESPONSE_TOO_LARGE', 'Provider response exceeded the configured limit.');
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

function defineSecret(target, name, value) {
  Object.defineProperty(target, name, {
    value,
    enumerable: false,
    configurable: false,
    writable: false,
  });
}

module.exports = {
  REMOTE_PROVIDER,
  RemoteRecoveryAdapter,
  RemoteRecoveryError,
  merkleRoot,
  normalizeTrustedManifest,
  toLazarusManifest,
};
