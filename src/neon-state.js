"use strict";

const { neon } = require("@neondatabase/serverless");

const STATE_KEY = "primary";

class StateConflictError extends Error {
  constructor() {
    super("The mission state changed in another request. Refresh and retry the action.");
    this.name = "StateConflictError";
    this.code = "STATE_WRITE_CONFLICT";
    this.statusCode = 409;
  }
}

class NeonStateStore {
  constructor({ connectionString, key = STATE_KEY } = {}) {
    if (typeof connectionString !== "string" || !connectionString.trim()) {
      throw new Error("DATABASE_URL is required for the Vercel deployment.");
    }
    this.sql = neon(connectionString);
    this.key = key;
    this.initialized = false;
  }

  async ensureSchema() {
    if (this.initialized) return;
    await this.sql`
      CREATE TABLE IF NOT EXISTS lazarus_mesh_state (
        state_key TEXT PRIMARY KEY,
        state JSONB NOT NULL,
        revision BIGINT NOT NULL DEFAULT 1,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;
    this.initialized = true;
  }

  async load(createDefaultState) {
    await this.ensureSchema();
    const existing = await this.sql`
      SELECT state, revision
      FROM lazarus_mesh_state
      WHERE state_key = ${this.key}
      LIMIT 1
    `;
    if (existing.length) {
      return {
        state: existing[0].state,
        revision: Number(existing[0].revision),
      };
    }

    const initialState = createDefaultState();
    await this.sql`
      INSERT INTO lazarus_mesh_state (state_key, state, revision)
      VALUES (${this.key}, ${JSON.stringify(initialState)}::jsonb, 1)
      ON CONFLICT (state_key) DO NOTHING
    `;
    const created = await this.sql`
      SELECT state, revision
      FROM lazarus_mesh_state
      WHERE state_key = ${this.key}
      LIMIT 1
    `;
    if (!created.length) throw new Error("Could not initialize the mission state.");
    return {
      state: created[0].state,
      revision: Number(created[0].revision),
    };
  }

  async save(state, expectedRevision) {
    await this.ensureSchema();
    const updated = await this.sql`
      UPDATE lazarus_mesh_state
      SET state = ${JSON.stringify(state)}::jsonb,
          revision = revision + 1,
          updated_at = NOW()
      WHERE state_key = ${this.key}
        AND revision = ${expectedRevision}
      RETURNING revision
    `;
    if (!updated.length) throw new StateConflictError();
    return Number(updated[0].revision);
  }
}

module.exports = { NeonStateStore, StateConflictError };
