const fs = require("node:fs");
const path = require("node:path");
const { sha256 } = require("../lib/ids");

function splitBuffer(buffer, count) {
  const pieces = [];
  const size = Math.ceil(buffer.length / count);
  for (let index = 0; index < count; index += 1) {
    const start = index * size;
    const end = Math.min(start + size, buffer.length);
    const bytes = start < buffer.length ? buffer.subarray(start, end) : Buffer.alloc(0);
    pieces.push({ index, bytes, hash: sha256(bytes), size: bytes.length });
  }
  return pieces;
}

function merkleRoot(pieceHashes) {
  if (!pieceHashes.length) return sha256(Buffer.alloc(0));
  let level = pieceHashes.map((hash) => Buffer.from(hash, "hex"));
  while (level.length > 1) {
    const next = [];
    for (let index = 0; index < level.length; index += 2) {
      const left = level[index];
      const right = level[index + 1] || left;
      next.push(Buffer.from(sha256(Buffer.concat([left, right])), "hex"));
    }
    level = next;
  }
  return level[0].toString("hex");
}

class LocalRecoveryAdapter {
  constructor({ fixturePath } = {}) {
    this.mode = "local";
    this.networkedProviders = false;
    this.fixturePath = fixturePath || path.join(
      __dirname,
      "..",
      "..",
      "fixtures",
      "cc0-rainfall-dataset",
      "rainfall-sample.json",
    );
    this.sessions = new Map();
  }

  reset() {
    this.sessions.clear();
  }

  buildManifest(pieceCount = 24) {
    const source = fs.readFileSync(this.fixturePath);
    const pieces = splitBuffer(source, pieceCount);
    return {
      name: path.basename(this.fixturePath),
      license: "CC0-1.0",
      totalBytes: source.length,
      totalPieces: pieces.length,
      contentSha256: sha256(source),
      contentRoot: merkleRoot(pieces.map((piece) => piece.hash)),
      pieces: pieces.map(({ index, hash, size }) => ({ index, hash, size })),
      _source: source,
      _pieceBytes: pieces.map((piece) => piece.bytes),
    };
  }

  start(missionId, manifest) {
    manifest = normalizeManifest(manifest);
    this.sessions.set(missionId, {
      manifest,
      recovered: new Map(),
      verified: new Set(),
    });
  }

  recoverThrough(missionId, targetCount) {
    const session = this.requireSession(missionId);
    const maximum = Math.min(targetCount, session.manifest.totalPieces);
    for (let index = 0; index < maximum; index += 1) {
      session.recovered.set(index, session.manifest._pieceBytes[index]);
    }
    return this.progress(missionId);
  }

  verifyAll(missionId) {
    const session = this.requireSession(missionId);
    for (const [index, bytes] of session.recovered) {
      const expected = session.manifest.pieces[index].hash;
      if (sha256(bytes) !== expected) throw new Error(`PIECE_HASH_MISMATCH:${index}`);
      session.verified.add(index);
    }
    return this.progress(missionId);
  }

  reconstruct(missionId) {
    const session = this.requireSession(missionId);
    if (session.verified.size !== session.manifest.totalPieces) throw new Error("ARTIFACT_INCOMPLETE");
    const reconstructed = Buffer.concat(
      Array.from({ length: session.manifest.totalPieces }, (_, index) => session.recovered.get(index)),
    );
    const contentSha256 = sha256(reconstructed);
    return {
      bytes: reconstructed.length,
      contentSha256,
      matches: contentSha256 === session.manifest.contentSha256,
    };
  }

  progress(missionId) {
    const session = this.requireSession(missionId);
    return {
      total: session.manifest.totalPieces,
      recovered: session.recovered.size,
      verified: session.verified.size,
      bitmap: session.manifest.pieces.map((piece) => ({
        index: piece.index,
        state: session.verified.has(piece.index)
          ? "verified"
          : session.recovered.has(piece.index)
            ? "recovered"
            : "missing",
        hash: piece.hash.slice(0, 12),
      })),
    };
  }

  requireSession(missionId) {
    const session = this.sessions.get(missionId);
    if (!session) throw new Error("RECOVERY_SESSION_NOT_FOUND");
    return session;
  }
}

function normalizeManifest(manifest) {
  if (!manifest || typeof manifest !== "object") throw new TypeError("Manifest is required.");
  let normalized;

  if (Number.isSafeInteger(manifest.totalPieces) && Array.isArray(manifest._pieceBytes)) {
    normalized = {
      name: manifest.name,
      license: manifest.license,
      totalBytes: manifest.totalBytes,
      totalPieces: manifest.totalPieces,
      contentSha256: manifest.contentSha256,
      contentRoot: manifest.contentRoot,
      pieces: Array.isArray(manifest.pieces)
        ? manifest.pieces.map((piece) => ({ ...piece }))
        : [],
      _pieceBytes: manifest._pieceBytes.map((bytes) => Buffer.from(bytes)),
    };
  } else if (Number.isSafeInteger(manifest.pieceCount) && Array.isArray(manifest.pieces)) {
    const pieceBytes = manifest.pieces.map((piece) => {
      if (typeof piece.fixtureBase64 !== "string" || !isBase64(piece.fixtureBase64)) {
        throw new TypeError("Offline manifest piece data must be valid base64.");
      }
      return Buffer.from(piece.fixtureBase64, "base64");
    });
    normalized = {
      name: manifest.name,
      license: manifest.license,
      totalBytes: manifest.totalBytes,
      totalPieces: manifest.pieceCount,
      contentSha256: manifest.artifactSha256 || manifest.contentRootSha256,
      contentRoot: manifest.merkleRootSha256 || manifest.contentRootSha256,
      pieces: manifest.pieces.map((piece) => ({
        index: piece.index,
        hash: piece.sha256,
        size: piece.byteLength,
      })),
      _pieceBytes: pieceBytes,
    };
  } else {
    throw new TypeError("Unsupported manifest schema.");
  }

  if (normalized.totalPieces <= 0) throw new TypeError("Manifest piece count must be positive.");
  if (
    normalized.pieces.length !== normalized.totalPieces ||
    normalized._pieceBytes.length !== normalized.totalPieces
  ) {
    throw new TypeError("Manifest piece count does not match its piece arrays.");
  }
  if (!Number.isSafeInteger(normalized.totalBytes) || normalized.totalBytes < 0) {
    throw new TypeError("Manifest total byte count is invalid.");
  }

  let byteCount = 0;
  const pieceHashes = [];
  for (let index = 0; index < normalized.totalPieces; index += 1) {
    const descriptor = normalized.pieces[index];
    const bytes = normalized._pieceBytes[index];
    if (
      !descriptor || descriptor.index !== index ||
      !Number.isSafeInteger(descriptor.size) || descriptor.size < 0 ||
      !Buffer.isBuffer(bytes) || bytes.length !== descriptor.size
    ) {
      throw new TypeError(`Manifest piece ${index} metadata is inconsistent.`);
    }
    const expectedHash = normalizeDigest(descriptor.hash, `piece ${index} hash`);
    if (sha256(bytes) !== expectedHash) throw new TypeError(`Manifest piece ${index} hash does not match its bytes.`);
    descriptor.hash = expectedHash;
    byteCount += bytes.length;
    if (!Number.isSafeInteger(byteCount)) throw new TypeError("Manifest byte count exceeds safe integer range.");
    pieceHashes.push(expectedHash);
  }

  if (byteCount !== normalized.totalBytes) throw new TypeError("Manifest total byte count does not match its pieces.");
  normalized.contentSha256 = normalizeDigest(normalized.contentSha256, "artifact hash");
  normalized.contentRoot = normalizeDigest(normalized.contentRoot, "Merkle root");
  normalized._source = Buffer.concat(normalized._pieceBytes);
  if (sha256(normalized._source) !== normalized.contentSha256) {
    throw new TypeError("Manifest artifact hash does not match its pieces.");
  }
  if (merkleRoot(pieceHashes) !== normalized.contentRoot) {
    throw new TypeError("Manifest Merkle root does not match its pieces.");
  }
  return normalized;
}

function normalizeDigest(value, label) {
  if (typeof value !== "string" || !/^[0-9a-fA-F]{64}$/.test(value)) {
    throw new TypeError(`Manifest ${label} must be a 32-byte hexadecimal digest.`);
  }
  return value.toLowerCase();
}

function isBase64(value) {
  return value === "" || (
    value.length % 4 === 0 &&
    /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  );
}

module.exports = { LocalRecoveryAdapter, splitBuffer, merkleRoot, normalizeManifest };
