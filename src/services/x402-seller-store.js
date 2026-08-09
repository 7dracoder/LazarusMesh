"use strict";

const { neon } = require("@neondatabase/serverless");

const STATUS_PROCESSING = "processing";
const STATUS_SETTLED = "settled";
const STATUS_UNCERTAIN = "uncertain";

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function requiredString(value, name) {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${name} is required.`);
  }
  return value.trim();
}

function normalizeRecord(record) {
  if (!record) return null;
  return {
    paymentId: record.payment_id ?? record.paymentId,
    fingerprint: record.fingerprint,
    contentRoot: record.content_root ?? record.contentRoot,
    status: record.status,
    responseBody: clone(record.response_body ?? record.responseBody ?? null),
    settlement: clone(record.settlement ?? null),
    errorCode: record.error_code ?? record.errorCode ?? null,
  };
}

function classifyExisting(record, fingerprint) {
  if (!record) return null;
  if (record.fingerprint !== fingerprint) return { kind: "conflict", record: clone(record) };
  if (record.status === STATUS_SETTLED) return { kind: "replay", record: clone(record) };
  if (record.status === STATUS_UNCERTAIN) return { kind: "uncertain", record: clone(record) };
  return { kind: "in-progress", record: clone(record) };
}

class MemoryX402SettlementStore {
  constructor() {
    this.durable = false;
    this.records = new Map();
  }

  async get(paymentId) {
    return clone(this.records.get(requiredString(paymentId, "paymentId")) || null);
  }

  async begin({ paymentId, fingerprint, contentRoot }) {
    paymentId = requiredString(paymentId, "paymentId");
    fingerprint = requiredString(fingerprint, "fingerprint");
    contentRoot = requiredString(contentRoot, "contentRoot");
    const existing = this.records.get(paymentId);
    if (existing) return classifyExisting(existing, fingerprint);
    this.records.set(paymentId, {
      paymentId,
      fingerprint,
      contentRoot,
      status: STATUS_PROCESSING,
      responseBody: null,
      settlement: null,
      errorCode: null,
    });
    return { kind: "started" };
  }

  async complete({ paymentId, fingerprint, responseBody, settlement }) {
    paymentId = requiredString(paymentId, "paymentId");
    fingerprint = requiredString(fingerprint, "fingerprint");
    const existing = this.records.get(paymentId);
    if (!existing || existing.fingerprint !== fingerprint || existing.status !== STATUS_PROCESSING) {
      throw new Error("The x402 settlement reservation could not be completed.");
    }
    existing.status = STATUS_SETTLED;
    existing.responseBody = clone(responseBody);
    existing.settlement = clone(settlement);
    existing.errorCode = null;
    return clone(existing);
  }

  async markUncertain({ paymentId, fingerprint, errorCode = "X402_SETTLEMENT_UNCERTAIN" }) {
    paymentId = requiredString(paymentId, "paymentId");
    fingerprint = requiredString(fingerprint, "fingerprint");
    const existing = this.records.get(paymentId);
    if (!existing || existing.fingerprint !== fingerprint) return null;
    if (existing.status !== STATUS_SETTLED) {
      existing.status = STATUS_UNCERTAIN;
      existing.errorCode = requiredString(errorCode, "errorCode");
    }
    return clone(existing);
  }
}

class NeonX402SettlementStore {
  constructor({ connectionString } = {}) {
    if (typeof connectionString !== "string" || !connectionString.trim()) {
      throw new Error("DATABASE_URL is required for durable x402 seller idempotency.");
    }
    this.durable = true;
    this.sql = neon(connectionString);
    this.initialized = false;
  }

  async ensureSchema() {
    if (this.initialized) return;
    await this.sql`
      CREATE TABLE IF NOT EXISTS lazarus_mesh_x402_settlements (
        payment_id TEXT PRIMARY KEY,
        fingerprint TEXT NOT NULL,
        content_root TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('processing', 'settled', 'uncertain')),
        response_body JSONB,
        settlement JSONB,
        error_code TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;
    this.initialized = true;
  }

  async get(paymentId) {
    paymentId = requiredString(paymentId, "paymentId");
    await this.ensureSchema();
    const rows = await this.sql`
      SELECT payment_id, fingerprint, content_root, status, response_body, settlement, error_code
      FROM lazarus_mesh_x402_settlements
      WHERE payment_id = ${paymentId}
      LIMIT 1
    `;
    return normalizeRecord(rows[0]);
  }

  async begin({ paymentId, fingerprint, contentRoot }) {
    paymentId = requiredString(paymentId, "paymentId");
    fingerprint = requiredString(fingerprint, "fingerprint");
    contentRoot = requiredString(contentRoot, "contentRoot");
    await this.ensureSchema();
    const inserted = await this.sql`
      INSERT INTO lazarus_mesh_x402_settlements (
        payment_id, fingerprint, content_root, status
      )
      VALUES (${paymentId}, ${fingerprint}, ${contentRoot}, ${STATUS_PROCESSING})
      ON CONFLICT (payment_id) DO NOTHING
      RETURNING payment_id
    `;
    if (inserted.length) return { kind: "started" };
    return classifyExisting(await this.get(paymentId), fingerprint);
  }

  async complete({ paymentId, fingerprint, responseBody, settlement }) {
    paymentId = requiredString(paymentId, "paymentId");
    fingerprint = requiredString(fingerprint, "fingerprint");
    await this.ensureSchema();
    const rows = await this.sql`
      UPDATE lazarus_mesh_x402_settlements
      SET status = ${STATUS_SETTLED},
          response_body = ${JSON.stringify(responseBody)}::jsonb,
          settlement = ${JSON.stringify(settlement)}::jsonb,
          error_code = NULL,
          updated_at = NOW()
      WHERE payment_id = ${paymentId}
        AND fingerprint = ${fingerprint}
        AND status = ${STATUS_PROCESSING}
      RETURNING payment_id, fingerprint, content_root, status, response_body, settlement, error_code
    `;
    if (!rows.length) throw new Error("The x402 settlement reservation could not be completed.");
    return normalizeRecord(rows[0]);
  }

  async markUncertain({ paymentId, fingerprint, errorCode = "X402_SETTLEMENT_UNCERTAIN" }) {
    paymentId = requiredString(paymentId, "paymentId");
    fingerprint = requiredString(fingerprint, "fingerprint");
    errorCode = requiredString(errorCode, "errorCode");
    await this.ensureSchema();
    const rows = await this.sql`
      UPDATE lazarus_mesh_x402_settlements
      SET status = ${STATUS_UNCERTAIN},
          error_code = ${errorCode},
          updated_at = NOW()
      WHERE payment_id = ${paymentId}
        AND fingerprint = ${fingerprint}
        AND status <> ${STATUS_SETTLED}
      RETURNING payment_id, fingerprint, content_root, status, response_body, settlement, error_code
    `;
    return normalizeRecord(rows[0]);
  }
}

module.exports = {
  MemoryX402SettlementStore,
  NeonX402SettlementStore,
  STATUS_PROCESSING,
  STATUS_SETTLED,
  STATUS_UNCERTAIN,
};
