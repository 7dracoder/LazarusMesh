"use strict";

class InternalX402FetchError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "InternalX402FetchError";
    this.code = code;
  }
}

function normalizeBaseUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new InternalX402FetchError("X402_INTERNAL_FETCH_INVALID_CONFIGURATION", "The internal seller URL is invalid.");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new InternalX402FetchError(
      "X402_INTERNAL_FETCH_INVALID_CONFIGURATION",
      "The internal seller URL must be a credential-free HTTPS URL.",
    );
  }
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url;
}

function plainHeaders(input) {
  const result = {};
  if (!input) return result;
  const headers = new Headers(input);
  for (const [name, value] of headers.entries()) result[name.toLowerCase()] = value;
  return result;
}

function abortError() {
  return new DOMException("The operation was aborted.", "AbortError");
}

function awaitWithAbort(operation, signal) {
  if (!signal) return Promise.resolve().then(operation);
  if (signal.aborted) return Promise.reject(abortError());

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      callback(value);
    };
    const onAbort = () => finish(reject, abortError());

    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }

    let pending;
    try {
      pending = operation();
    } catch (error) {
      finish(reject, error);
      return;
    }

    // Always attach both handlers. If the caller aborts first, a later seller
    // rejection is consumed here instead of becoming an unhandled rejection.
    Promise.resolve(pending).then(
      (value) => finish(resolve, value),
      (error) => finish(reject, error),
    );
  });
}

class BufferedFetchResponse {
  constructor() {
    this.statusCode = 200;
    this.headers = new Headers();
    this.chunks = [];
    this.headersSent = false;
  }

  setHeader(name, value) {
    this.headers.set(name, value);
  }

  getHeader(name) {
    return this.headers.get(name);
  }

  writeHead(statusCode, headers = {}) {
    this.statusCode = statusCode;
    for (const [name, value] of Object.entries(headers)) this.headers.set(name, value);
    this.headersSent = true;
    return this;
  }

  end(chunk) {
    if (chunk !== undefined && chunk !== null) {
      this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    }
    this.headersSent = true;
    return this;
  }

  toResponse() {
    return new Response(this.chunks.length ? Buffer.concat(this.chunks) : null, {
      status: this.statusCode,
      headers: this.headers,
    });
  }
}

function createInternalX402SellerFetch({ seller, availabilityBaseUrl } = {}) {
  if (!seller || typeof seller.handle !== "function") {
    throw new InternalX402FetchError(
      "X402_INTERNAL_FETCH_INVALID_CONFIGURATION",
      "The internal x402 seller must expose handle().",
    );
  }
  const baseUrl = normalizeBaseUrl(availabilityBaseUrl);

  return async function internalX402SellerFetch(resource, options = {}) {
    const signal = options.signal;
    if (signal?.aborted) throw abortError();
    let url;
    try {
      url = resource instanceof URL ? new URL(resource.href) : new URL(String(resource));
    } catch {
      throw new InternalX402FetchError("X402_INTERNAL_FETCH_URL_DENIED", "The internal x402 URL is invalid.");
    }
    if (url.origin !== baseUrl.origin || !url.pathname.startsWith(baseUrl.pathname) || url.search || url.hash) {
      throw new InternalX402FetchError(
        "X402_INTERNAL_FETCH_URL_DENIED",
        "The internal x402 transport can call only its protected availability seller.",
      );
    }
    const request = {
      method: String(options.method || "GET").toUpperCase(),
      headers: plainHeaders(options.headers),
    };
    const response = new BufferedFetchResponse();
    const handled = await awaitWithAbort(() => seller.handle(request, response, url), signal);
    if (handled !== true || !response.headersSent) {
      throw new InternalX402FetchError(
        "X402_INTERNAL_FETCH_ROUTE_MISSING",
        "The protected x402 seller did not handle the availability request.",
      );
    }
    return response.toResponse();
  };
}

module.exports = {
  InternalX402FetchError,
  createInternalX402SellerFetch,
};
