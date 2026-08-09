"use strict";

const { createApplication } = require("../server");
const { MemoryStore } = require("../src/store");
const { NeonStateStore, StateConflictError } = require("../src/neon-state");
const { rehydrateLocalAdapters } = require("../src/rehydrate-local");

function restoreRewrittenApiUrl(request) {
  const host = typeof request.headers?.host === "string" ? request.headers.host : "localhost";
  const url = new URL(request.url || "/", `https://${host}`);
  const routedPath = url.searchParams.get("__lazarus_path");
  if (routedPath === null) return;

  const segments = routedPath.replace(/^\/+|\/+$/g, "").split("/");
  if (!segments.length || segments.some((segment) => !/^[A-Za-z0-9_-]+$/.test(segment))) {
    const error = new Error("The deployment received an invalid API route.");
    error.code = "INVALID_DEPLOYMENT_ROUTE";
    error.statusCode = 400;
    throw error;
  }

  url.searchParams.delete("__lazarus_path");
  url.searchParams.delete("path");
  const query = url.searchParams.toString();
  request.url = `/api/${segments.join("/")}${query ? `?${query}` : ""}`;
}

function createBufferedResponse(response) {
  const headers = new Map();
  const chunks = [];
  let statusCode = 200;
  let ended = false;
  return {
    get headersSent() {
      return ended;
    },
    get statusCode() {
      return statusCode;
    },
    setHeader(name, value) {
      headers.set(name, value);
    },
    getHeader(name) {
      return headers.get(name);
    },
    writeHead(nextStatusCode, nextHeaders = {}) {
      statusCode = nextStatusCode;
      for (const [name, value] of Object.entries(nextHeaders)) headers.set(name, value);
      return this;
    },
    end(chunk) {
      if (chunk !== undefined && chunk !== null) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      ended = true;
      return this;
    },
    flush() {
      response.writeHead(statusCode, Object.fromEntries(headers));
      response.end(chunks.length ? Buffer.concat(chunks) : undefined);
    },
  };
}

function createRuntime() {
  const adapterMode = process.env.ADAPTER_MODE || "local";
  if (adapterMode !== "local") {
    throw new Error("The Vercel deployment supports only ADAPTER_MODE=local. Do not enable Rain sandbox credentials until its external-operation saga is durable.");
  }

  const store = new MemoryStore(() => ({ missions: [] }));
  const application = createApplication({
    adapterMode,
    env: process.env,
    store,
    resetStateOnStart: false,
    allowRemoteHost: true,
    enableEventStream: false,
    runtime: "vercel",
  });
  return {
    ...application,
    persistence: new NeonStateStore({ connectionString: process.env.DATABASE_URL }),
  };
}

function sendDeploymentProblem(response, error) {
  const statusCode = error.statusCode || 500;
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(`${JSON.stringify({
    error: error.code || "DEPLOYMENT_REQUEST_FAILED",
    message: statusCode >= 500
      ? "The deployment could not complete this request. Check Vercel function logs with the request time."
      : error.message,
  })}\n`);
}

module.exports = async function handler(request, response) {
  try {
    restoreRewrittenApiUrl(request);
    // Keep mutable adapters and mission state request-local. Vercel can run a
    // polling GET alongside a long POST in one warm process; sharing a runtime
    // would let the GET replace the POST's in-flight state.
    const app = createRuntime();
    const snapshot = await app.persistence.load(app.stateFactory);
    app.store.replace(snapshot.state);
    await rehydrateLocalAdapters(app.store.get(), app.adapters);

    const bufferedResponse = createBufferedResponse(response);
    await app.requestHandler(request, bufferedResponse);
    if (request.method === "POST" && bufferedResponse.statusCode < 400) {
      await app.persistence.save(app.store.get(), snapshot.revision);
    }
    bufferedResponse.flush();
  } catch (error) {
    if (error instanceof StateConflictError) return sendDeploymentProblem(response, error);
    return sendDeploymentProblem(response, error);
  }
};
