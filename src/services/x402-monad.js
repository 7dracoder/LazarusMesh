"use strict";

const { sha256 } = require("../lib/ids");
const { fromAccountingMinorUp, normalizeCurrency } = require("../domain/currency");
const { x402Client, x402HTTPClient } = require("@x402/core/client");
const { ExactEvmScheme } = require("@x402/evm/exact/client");
const {
  PAYMENT_IDENTIFIER,
  appendPaymentIdentifierToExtensions,
  extractPaymentIdentifier,
  validatePaymentIdentifier,
} = require("@x402/extensions/payment-identifier");
const {
  createPublicClient,
  decodeEventLog,
  getAddress,
  http,
} = require("viem");
const { privateKeyToAccount } = require("viem/accounts");
const { monadTestnet } = require("viem/chains");

const MONAD_TESTNET_CHAIN_ID = 10143;
const MONAD_TESTNET_NETWORK = "eip155:10143";
const MONAD_TESTNET_USDC = "0x534b2f3A21130d7a60830c2Df862319e593943A3";
const MONAD_TESTNET_EXPLORER = "https://testnet.monadscan.com/tx/";
const USDC_DECIMALS = 6;
const USDC_ATOMIC_PER_UNIT = 1_000_000n;
const DEFAULT_DISCOVERY_AMOUNT_ATOMIC = "10000";
const DEFAULT_PROVIDER_ID = "provider_atlas_archive";
const DEFAULT_TIMEOUT_MS = 12_000;
const DEFAULT_PREFLIGHT_TTL_MS = 60_000;
const DEFAULT_RESPONSE_LIMIT_BYTES = 64 * 1024;
const ABSOLUTE_MAX_PAYMENT_ATOMIC = 1_000_000n;
// Receipt block T is state-root verified at T+5. Six inclusive confirmations
// ensure the observer has reached that block.
const DEFAULT_CONFIRMATIONS = 6;

const TRANSFER_EVENT_ABI = Object.freeze([{
  type: "event",
  name: "Transfer",
  anonymous: false,
  inputs: [
    { indexed: true, name: "from", type: "address" },
    { indexed: true, name: "to", type: "address" },
    { indexed: false, name: "value", type: "uint256" },
  ],
}]);

const BALANCE_OF_ABI = Object.freeze([{
  type: "function",
  name: "balanceOf",
  stateMutability: "view",
  inputs: [{ name: "account", type: "address" }],
  outputs: [{ name: "balance", type: "uint256" }],
}]);

class MonadX402Error extends Error {
  constructor(code, message, {
    statusCode = 502,
    retryable = false,
    fundsMoved = false,
    transactionHash = null,
    outcomeUnknown = false,
  } = {}) {
    super(message);
    this.name = "MonadX402Error";
    this.code = code;
    this.statusCode = statusCode;
    this.retryable = retryable;
    this.fundsMoved = fundsMoved;
    this.transactionHash = transactionHash;
    this.outcomeUnknown = outcomeUnknown;
  }
}

function configurationError(message) {
  return new MonadX402Error("X402_INVALID_CONFIGURATION", message, { statusCode: 500 });
}

function assertPositiveInteger(value, label, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw configurationError(`${label} must be a positive integer no greater than ${maximum}.`);
  }
}

function positiveAtomic(value, label) {
  try {
    const amount = BigInt(value);
    if (amount <= 0n) throw new Error("not positive");
    return amount;
  } catch {
    throw configurationError(`${label} must be a positive integer in token atomic units.`);
  }
}

function normalizeAddress(value, label) {
  try {
    return getAddress(value);
  } catch {
    throw configurationError(`${label} must be a valid EVM address.`);
  }
}

function addressEquals(left, right) {
  try {
    return getAddress(left) === getAddress(right);
  } catch {
    return false;
  }
}

function normalizeHttpsUrl(value, label, { directory = false } = {}) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw configurationError(`${label} must be a valid HTTPS URL.`);
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== "" ||
    url.search !== ""
  ) {
    throw configurationError(`${label} must be a credential-free HTTPS URL without query or fragment data.`);
  }
  if (directory && !url.pathname.endsWith("/")) url.pathname += "/";
  return url;
}

function clone(value) {
  return structuredClone(value);
}

function currentTime(clock) {
  const now = clock();
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new MonadX402Error("X402_CLOCK_INVALID", "The x402 adapter clock returned an invalid time.", {
      statusCode: 500,
    });
  }
  return now;
}

function assertIdentifier(value, code, label) {
  if (typeof value !== "string" || !/^[A-Za-z0-9._:-]{1,256}$/.test(value)) {
    throw new MonadX402Error(code, `${label} is invalid.`, { statusCode: 422 });
  }
  return value;
}

function safeBigInt(value) {
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

function safeBlockNumber(value) {
  if (typeof value !== "bigint" || value < 0n) return null;
  return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value.toString();
}

function isRedirect(status) {
  return Number.isInteger(status) && status >= 300 && status < 400;
}

function transactionHash(value) {
  return typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value) ? value : null;
}

function isIsoTimestamp(value) {
  if (typeof value !== "string") return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value;
}

function isBlockNumber(value) {
  return (
    (Number.isSafeInteger(value) && value >= 0) ||
    (typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value))
  );
}

function paymentIdentifier(missionId, contentRoot) {
  return `lazarus_x402_${sha256(`monad-testnet-v1|${missionId}|${contentRoot}`).slice(0, 40)}`;
}

function receiptIdentifier(missionId, contentRoot) {
  return `x402_monad_${sha256(`receipt-v1|${missionId}|${contentRoot}`).slice(0, 24)}`;
}

function usdMinorForUsdcAtomic(amountAtomic) {
  return Number((amountAtomic * 100n + USDC_ATOMIC_PER_UNIT - 1n) / USDC_ATOMIC_PER_UNIT);
}

class MonadX402Adapter {
  constructor({
    availabilityBaseUrl,
    payToAddress,
    privateKey = null,
    signer = null,
    rpcUrl = null,
    publicClient = null,
    fetchImpl = globalThis.fetch,
    clock = () => new Date(),
    expectedAmountAtomic = DEFAULT_DISCOVERY_AMOUNT_ATOMIC,
    maxPaymentAtomic = expectedAmountAtomic,
    maxAuthorizationSeconds = 300,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    preflightTtlMs = DEFAULT_PREFLIGHT_TTL_MS,
    responseLimitBytes = DEFAULT_RESPONSE_LIMIT_BYTES,
    confirmations = DEFAULT_CONFIRMATIONS,
    expectedProviderId = DEFAULT_PROVIDER_ID,
    explorerBaseUrl = MONAD_TESTNET_EXPLORER,
    persistPendingPayment,
  } = {}) {
    this.mode = "monad-testnet";
    this.liveSettlementEnabled = true;
    this.network = MONAD_TESTNET_NETWORK;
    this.chainId = MONAD_TESTNET_CHAIN_ID;
    this.assetAddress = normalizeAddress(MONAD_TESTNET_USDC, "Monad test USDC address");
    this.payToAddress = normalizeAddress(payToAddress, "MONAD_PAY_TO_ADDRESS");
    this.availabilityBaseUrl = normalizeHttpsUrl(
      availabilityBaseUrl,
      "X402_AVAILABILITY_BASE_URL",
      { directory: true },
    );
    this.explorerBaseUrl = normalizeHttpsUrl(explorerBaseUrl, "Monad explorer URL", { directory: true });

    if (signer && privateKey) {
      throw configurationError("Configure either a Monad signer or a private key, not both.");
    }
    if (!signer) {
      if (typeof privateKey !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(privateKey)) {
        throw configurationError("A dedicated Monad testnet signer is required.");
      }
      signer = privateKeyToAccount(privateKey);
    }
    if (
      !signer ||
      typeof signer.signTypedData !== "function" ||
      typeof signer.address !== "string"
    ) {
      throw configurationError("The Monad signer must expose an address and signTypedData().");
    }
    this.signer = signer;
    this.payerAddress = normalizeAddress(signer.address, "Monad signer address");
    if (this.payerAddress.toLowerCase() === this.payToAddress.toLowerCase()) {
      throw configurationError("The payer and x402 seller addresses must be different wallets.");
    }

    this.expectedAmountAtomic = positiveAtomic(expectedAmountAtomic, "expectedAmountAtomic");
    this.maxPaymentAtomic = positiveAtomic(maxPaymentAtomic, "maxPaymentAtomic");
    if (this.expectedAmountAtomic > this.maxPaymentAtomic) {
      throw configurationError("The expected x402 price exceeds the configured payment cap.");
    }
    if (this.maxPaymentAtomic > ABSOLUTE_MAX_PAYMENT_ATOMIC) {
      throw configurationError("The availability-payment cap cannot exceed 1 test USDC.");
    }
    assertPositiveInteger(maxAuthorizationSeconds, "maxAuthorizationSeconds", 900);
    assertPositiveInteger(timeoutMs, "timeoutMs", 30_000);
    assertPositiveInteger(preflightTtlMs, "preflightTtlMs", 5 * 60_000);
    assertPositiveInteger(responseLimitBytes, "responseLimitBytes", 1024 * 1024);
    assertPositiveInteger(confirmations, "confirmations", 32);
    assertIdentifier(expectedProviderId, "X402_INVALID_CONFIGURATION", "Expected provider ID");
    if (typeof fetchImpl !== "function") {
      throw configurationError("A fetch implementation is required.");
    }
    if (typeof persistPendingPayment !== "function") {
      throw configurationError("A durable pending-payment recorder is required before live x402 signing can be enabled.");
    }

    let normalizedRpcUrl = null;
    if (rpcUrl !== null) normalizedRpcUrl = normalizeHttpsUrl(rpcUrl, "MONAD_RPC_URL").href;
    if (!publicClient && !normalizedRpcUrl) {
      throw configurationError("MONAD_RPC_URL is required when no public client is supplied.");
    }
    this.publicClient = publicClient || createPublicClient({
      chain: monadTestnet,
      transport: http(normalizedRpcUrl),
    });
    for (const method of ["getChainId", "readContract", "waitForTransactionReceipt"]) {
      if (typeof this.publicClient?.[method] !== "function") {
        throw configurationError(`The Monad public client must expose ${method}().`);
      }
    }

    this.rpcUrl = normalizedRpcUrl;
    this.fetch = fetchImpl;
    this.clock = clock;
    this.maxAuthorizationSeconds = maxAuthorizationSeconds;
    this.timeoutMs = timeoutMs;
    this.preflightTtlMs = preflightTtlMs;
    this.responseLimitBytes = responseLimitBytes;
    this.confirmations = confirmations;
    this.expectedProviderId = expectedProviderId;
    this.persistPendingPayment = persistPendingPayment;
    this.preflights = new Map();
    this.receipts = new Map();
    this.inFlight = new Map();
    // Once a signed authorization may have reached the seller, a fresh
    // authorization is unsafe until that payment identifier is reconciled.
    // Keep this tombstone across adapter resets in the same process. Public
    // deployment keeps this adapter disabled; a production runtime must also
    // persist this gate before transmitting the signed request.
    this.pendingReconciliation = new Map();
    this.headerParser = new x402HTTPClient(new x402Client());
  }

  reset() {
    this.preflights.clear();
    this.receipts.clear();
    this.inFlight.clear();
    // Deliberately do not clear pendingReconciliation. Resetting UI/demo state
    // cannot prove that a previously transmitted authorization was unused.
  }

  preflightKey(contentRoot, budgetCurrency) {
    return `${budgetCurrency}:${contentRoot}`;
  }

  resourceUrl(contentRoot) {
    return new URL(encodeURIComponent(contentRoot), this.availabilityBaseUrl).href;
  }

  receiptId(missionId, contentRoot) {
    return receiptIdentifier(missionId, contentRoot);
  }

  getReceipt(missionId, contentRoot) {
    const receipt = this.receipts.get(this.receiptId(missionId, contentRoot));
    return receipt ? clone(receipt) : null;
  }

  restorePendingPayment(pending) {
    if (!pending || typeof pending !== "object") {
      throw new MonadX402Error("X402_INVALID_PENDING_PAYMENT", "Stored pending x402 payment is invalid.", {
        statusCode: 500,
      });
    }
    const missionId = assertIdentifier(
      pending.missionId,
      "X402_INVALID_PENDING_PAYMENT",
      "Pending mission ID",
    );
    const contentRoot = assertIdentifier(
      pending.contentRoot,
      "X402_INVALID_PENDING_PAYMENT",
      "Pending content root",
    );
    assertIdentifier(
      pending.principalId,
      "X402_INVALID_PENDING_PAYMENT",
      "Pending principal ID",
    );
    const receiptId = this.receiptId(missionId, contentRoot);
    const currency = normalizeCurrency(pending.currency, "");
    if (
      pending.receiptId !== receiptId ||
      pending.paymentId !== paymentIdentifier(missionId, contentRoot) ||
      pending.mode !== this.mode ||
      pending.network !== this.network ||
      pending.status !== "reconciliation_required" ||
      pending.outcome !== "unknown" ||
      pending.synthetic !== false ||
      pending.externalEndpoint !== true ||
      !currency ||
      pending.currency !== currency ||
      !addressEquals(pending.payer, this.payerAddress) ||
      !addressEquals(pending.payee, this.payToAddress) ||
      !addressEquals(pending.asset, this.assetAddress) ||
      safeBigInt(pending.amountAtomic) !== this.expectedAmountAtomic ||
      !isIsoTimestamp(pending.preparedAt)
    ) {
      throw new MonadX402Error("X402_INVALID_PENDING_PAYMENT", "Stored pending x402 payment failed integrity checks.", {
        statusCode: 500,
      });
    }
    this.pendingReconciliation.set(receiptId, clone(pending));
    return clone(pending);
  }

  restoreReceipt(receipt) {
    if (!receipt || typeof receipt !== "object") {
      throw new MonadX402Error("X402_INVALID_RESTORED_RECEIPT", "Stored x402 receipt is invalid.", {
        statusCode: 500,
      });
    }
    const missionId = assertIdentifier(
      receipt.missionId,
      "X402_INVALID_RESTORED_RECEIPT",
      "Stored mission ID",
    );
    const contentRoot = assertIdentifier(
      receipt.contentRoot,
      "X402_INVALID_RESTORED_RECEIPT",
      "Stored content root",
    );
    assertIdentifier(
      receipt.principalId,
      "X402_INVALID_RESTORED_RECEIPT",
      "Stored principal ID",
    );
    const currency = normalizeCurrency(receipt.currency, "");
    const hash = transactionHash(receipt.transactionHash);
    const expectedBudgetImpactMinor = currency
      ? fromAccountingMinorUp(usdMinorForUsdcAtomic(this.expectedAmountAtomic), currency)
      : null;
    const expectedReceiptId = this.receiptId(missionId, contentRoot);
    const expectedExplorerUrl = hash ? `${this.explorerBaseUrl.href}${hash}` : null;
    const paymentResponse = receipt.paymentResponse;
    if (
      receipt.receiptId !== expectedReceiptId ||
      receipt.paymentId !== paymentIdentifier(missionId, contentRoot) ||
      receipt.mode !== this.mode ||
      receipt.status !== "settled" ||
      receipt.network !== this.network ||
      receipt.chainId !== this.chainId ||
      receipt.confirmed !== true ||
      !Number.isSafeInteger(receipt.confirmations) ||
      receipt.confirmations < this.confirmations ||
      !isBlockNumber(receipt.blockNumber) ||
      !isIsoTimestamp(receipt.timestamp) ||
      receipt.synthetic !== false ||
      receipt.fundsMoved !== true ||
      receipt.externalEndpoint !== true ||
      receipt.chainWrite !== true ||
      !addressEquals(receipt.payer, this.payerAddress) ||
      !addressEquals(receipt.payee, this.payToAddress) ||
      !hash ||
      receipt.explorerUrl !== expectedExplorerUrl ||
      !addressEquals(receipt.settlementAsset?.address, this.assetAddress) ||
      receipt.settlementAsset?.symbol !== "USDC" ||
      receipt.settlementAsset?.decimals !== USDC_DECIMALS ||
      safeBigInt(receipt.settlementAsset?.amountAtomic) !== this.expectedAmountAtomic ||
      !currency ||
      receipt.currency !== currency ||
      receipt.amountMinor !== expectedBudgetImpactMinor ||
      receipt.budgetImpactMinor !== expectedBudgetImpactMinor ||
      !paymentResponse ||
      typeof paymentResponse !== "object" ||
      !Number.isSafeInteger(paymentResponse.candidateProviders) ||
      paymentResponse.candidateProviders < 1 ||
      paymentResponse.candidateProviders > 100 ||
      paymentResponse.recommendedProvider !== this.expectedProviderId ||
      !Number.isSafeInteger(paymentResponse.estimatedRecoverySeconds) ||
      paymentResponse.estimatedRecoverySeconds < 1 ||
      paymentResponse.estimatedRecoverySeconds > 86_400 ||
      !Number.isSafeInteger(paymentResponse.estimatedCostMinor) ||
      paymentResponse.estimatedCostMinor < 0 ||
      paymentResponse.estimatedCostCurrency !== currency ||
      typeof paymentResponse.confidence !== "number" ||
      !Number.isFinite(paymentResponse.confidence) ||
      paymentResponse.confidence < 0 ||
      paymentResponse.confidence > 1
    ) {
      throw new MonadX402Error("X402_INVALID_RESTORED_RECEIPT", "Stored x402 receipt failed integrity checks.", {
        statusCode: 500,
      });
    }
    this.receipts.set(expectedReceiptId, clone(receipt));
    this.pendingReconciliation.delete(expectedReceiptId);
    return clone(receipt);
  }

  restoreReceipts(receipts) {
    if (!Array.isArray(receipts)) {
      throw new MonadX402Error("X402_INVALID_RESTORED_RECEIPT", "Stored x402 receipts must be an array.", {
        statusCode: 500,
      });
    }
    return receipts.map((receipt) => this.restoreReceipt(receipt));
  }

  async fetchOnce(url, { headers = {} } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetch(url, {
        method: "GET",
        headers: {
          Accept: "application/json",
          ...headers,
        },
        redirect: "manual",
        signal: controller.signal,
      });
      if (!response || typeof response.status !== "number" || !response.headers) {
        throw new MonadX402Error("X402_INVALID_RESPONSE", "The x402 resource returned an invalid response.");
      }
      if (isRedirect(response.status)) {
        throw new MonadX402Error("X402_REDIRECT_BLOCKED", "The x402 resource attempted a redirect.");
      }
      return response;
    } catch (error) {
      if (error instanceof MonadX402Error) throw error;
      if (controller.signal.aborted || error?.name === "AbortError") {
        throw new MonadX402Error("X402_UPSTREAM_TIMEOUT", "The x402 resource timed out.", {
          retryable: true,
        });
      }
      throw new MonadX402Error("X402_UPSTREAM_UNREACHABLE", "The x402 resource could not be reached.", {
        retryable: true,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  async assertNetwork() {
    let chainId;
    try {
      chainId = await this.publicClient.getChainId();
    } catch {
      throw new MonadX402Error("MONAD_RPC_UNREACHABLE", "Monad testnet could not be reached.", {
        retryable: true,
      });
    }
    if (chainId !== this.chainId) {
      throw new MonadX402Error("MONAD_CHAIN_ID_MISMATCH", "The configured RPC is not Monad testnet.", {
        statusCode: 503,
      });
    }
  }

  matchingRequirement(requirement) {
    if (!requirement || typeof requirement !== "object") return false;
    if (requirement.scheme !== "exact" || requirement.network !== this.network) return false;
    if (
      !Number.isSafeInteger(requirement.maxTimeoutSeconds) ||
      requirement.maxTimeoutSeconds < 1 ||
      requirement.maxTimeoutSeconds > this.maxAuthorizationSeconds
    ) return false;
    const amount = safeBigInt(requirement.amount);
    if (amount === null || amount !== this.expectedAmountAtomic || amount > this.maxPaymentAtomic) return false;
    try {
      if (getAddress(requirement.asset) !== this.assetAddress) return false;
      if (getAddress(requirement.payTo) !== this.payToAddress) return false;
    } catch {
      return false;
    }
    const extra = requirement.extra;
    if (!extra || typeof extra !== "object") return false;
    if (extra.name !== "USDC" || String(extra.version) !== "2") return false;
    if (extra.assetTransferMethod !== undefined && extra.assetTransferMethod !== "eip3009") return false;
    return true;
  }

  assertPaymentRequired(paymentRequired, expectedResourceUrl) {
    if (
      !paymentRequired ||
      typeof paymentRequired !== "object" ||
      paymentRequired.x402Version !== 2 ||
      !paymentRequired.resource ||
      typeof paymentRequired.resource.url !== "string" ||
      !Array.isArray(paymentRequired.accepts)
    ) {
      throw new MonadX402Error("X402_REQUIREMENT_INVALID", "The seller returned invalid x402 v2 requirements.");
    }
    let declaredResource;
    try {
      declaredResource = new URL(paymentRequired.resource.url, expectedResourceUrl).href;
    } catch {
      throw new MonadX402Error("X402_RESOURCE_MISMATCH", "The seller returned an invalid resource identity.");
    }
    if (declaredResource !== expectedResourceUrl) {
      throw new MonadX402Error("X402_RESOURCE_MISMATCH", "The seller changed the requested resource identity.");
    }
    const requirements = paymentRequired.accepts.filter((item) => this.matchingRequirement(item));
    if (requirements.length !== 1) {
      throw new MonadX402Error(
        "X402_PAYMENT_POLICY_MISMATCH",
        "The seller did not offer exactly one approved Monad test-USDC payment option.",
      );
    }
    const identifierDeclaration = paymentRequired.extensions?.[PAYMENT_IDENTIFIER];
    if (
      !identifierDeclaration ||
      validatePaymentIdentifier(identifierDeclaration).valid !== true ||
      identifierDeclaration.info?.required !== true
    ) {
      throw new MonadX402Error(
        "X402_IDEMPOTENCY_UNSUPPORTED",
        "The seller does not require the x402 payment-identifier extension.",
      );
    }
    return requirements[0];
  }

  async requestAvailability(contentRoot, { budgetCurrency = "USD" } = {}) {
    assertIdentifier(contentRoot, "INVALID_CONTENT_ROOT", "Content root");
    const currency = normalizeCurrency(budgetCurrency);
    if (!currency) {
      throw new MonadX402Error("CURRENCY_NOT_SUPPORTED", "The mission currency is not supported.", {
        statusCode: 422,
      });
    }
    await this.assertNetwork();
    const resourceUrl = this.resourceUrl(contentRoot);
    const response = await this.fetchOnce(resourceUrl);
    if (response.status !== 402) {
      throw new MonadX402Error(
        "X402_PAYMENT_REQUIRED_MISSING",
        "The configured seller did not return HTTP 402 Payment Required.",
      );
    }
    let paymentRequired;
    try {
      paymentRequired = this.headerParser.getPaymentRequiredResponse(
        (name) => response.headers.get(name),
      );
    } catch {
      throw new MonadX402Error("X402_REQUIREMENT_INVALID", "The seller returned an invalid payment header.");
    }
    const selected = this.assertPaymentRequired(paymentRequired, resourceUrl);
    await response.body?.cancel?.().catch(() => undefined);
    this.preflights.set(this.preflightKey(contentRoot, currency), {
      fetchedAt: currentTime(this.clock).getTime(),
      paymentRequired: clone(paymentRequired),
      resourceUrl,
    });
    return {
      status: 402,
      mode: this.mode,
      network: this.network,
      resource: resourceUrl,
      idempotency: "x402-payment-identifier",
      payment: {
        scheme: selected.scheme,
        asset: this.assetAddress,
        assetSymbol: "USDC",
        assetDecimals: USDC_DECIMALS,
        amountAtomic: selected.amount,
        payTo: this.payToAddress,
        maxTimeoutSeconds: selected.maxTimeoutSeconds,
      },
    };
  }

  createPaymentClient({ expectedResourceUrl, operationPaymentId }) {
    const client = new x402Client();
    const schemeOptions = this.rpcUrl ? { rpcUrl: this.rpcUrl } : undefined;
    client.register(this.network, new ExactEvmScheme(this.signer, schemeOptions));
    client.registerPolicy((version, requirements) => {
      if (version !== 2) return [];
      return requirements.filter((requirement) => this.matchingRequirement(requirement));
    });
    client.onBeforePaymentCreation(async ({ paymentRequired, selectedRequirements }) => {
      this.assertPaymentRequired(paymentRequired, expectedResourceUrl);
      if (!this.matchingRequirement(selectedRequirements)) {
        return { abort: true, reason: "Selected payment is outside the approved policy." };
      }
      appendPaymentIdentifierToExtensions(paymentRequired.extensions, operationPaymentId);
      return undefined;
    });
    return {
      client,
      httpClient: new x402HTTPClient(client),
    };
  }

  async assertBalance() {
    let balance;
    try {
      balance = await this.publicClient.readContract({
        address: this.assetAddress,
        abi: BALANCE_OF_ABI,
        functionName: "balanceOf",
        args: [this.payerAddress],
      });
    } catch {
      throw new MonadX402Error("X402_BALANCE_CHECK_FAILED", "The payer's test-USDC balance could not be checked.", {
        retryable: true,
      });
    }
    if (typeof balance !== "bigint") {
      throw new MonadX402Error("X402_BALANCE_CHECK_FAILED", "The test-USDC contract returned an invalid balance.");
    }
    if (balance < this.expectedAmountAtomic) {
      throw new MonadX402Error("X402_INSUFFICIENT_TEST_USDC", "The Monad payer does not have enough test USDC.", {
        statusCode: 409,
      });
    }
  }

  assertSettleResponse(settleResponse) {
    if (!settleResponse || typeof settleResponse !== "object") {
      throw new MonadX402Error("X402_SETTLEMENT_NOT_CONFIRMED", "The seller returned no x402 settlement receipt.", {
        retryable: true,
      });
    }
    if (settleResponse.success !== true) {
      throw new MonadX402Error("X402_SETTLEMENT_FAILED", "The Monad x402 facilitator rejected settlement.");
    }
    if (settleResponse.network !== this.network) {
      throw new MonadX402Error("X402_SETTLEMENT_NETWORK_MISMATCH", "The settlement receipt names the wrong network.");
    }
    if (
      settleResponse.payer !== undefined &&
      !addressEquals(settleResponse.payer, this.payerAddress)
    ) {
      throw new MonadX402Error("X402_SETTLEMENT_PAYER_MISMATCH", "The settlement receipt names the wrong payer.");
    }
    if (
      settleResponse.amount !== undefined &&
      safeBigInt(settleResponse.amount) !== this.expectedAmountAtomic
    ) {
      throw new MonadX402Error("X402_SETTLEMENT_AMOUNT_MISMATCH", "The settlement amount differs from the approved amount.");
    }
    const hash = transactionHash(settleResponse.transaction);
    if (!hash) {
      throw new MonadX402Error("X402_SETTLEMENT_HASH_INVALID", "The settlement receipt has no valid transaction hash.");
    }
    return hash;
  }

  findTransfer(logs) {
    for (const log of Array.isArray(logs) ? logs : []) {
      try {
        if (getAddress(log.address) !== this.assetAddress) continue;
        const decoded = decodeEventLog({
          abi: TRANSFER_EVENT_ABI,
          data: log.data,
          topics: log.topics,
          strict: true,
        });
        if (
          decoded.eventName === "Transfer" &&
          getAddress(decoded.args.from) === this.payerAddress &&
          getAddress(decoded.args.to) === this.payToAddress &&
          decoded.args.value === this.expectedAmountAtomic
        ) return decoded.args;
      } catch {
        // Ignore unrelated or malformed logs and require one exact Transfer below.
      }
    }
    return null;
  }

  async verifyTransaction(hash) {
    let receipt;
    try {
      receipt = await this.publicClient.waitForTransactionReceipt({
        hash,
        confirmations: this.confirmations,
        timeout: this.timeoutMs,
      });
    } catch {
      throw new MonadX402Error(
        "X402_TRANSACTION_CONFIRMATION_FAILED",
        "The Monad transaction could not be independently confirmed.",
        { retryable: true, fundsMoved: true, transactionHash: hash },
      );
    }
    if (
      !receipt ||
      receipt.status !== "success" ||
      (receipt.transactionHash && receipt.transactionHash.toLowerCase() !== hash.toLowerCase()) ||
      !receipt.to ||
      !addressEquals(receipt.to, this.assetAddress) ||
      !this.findTransfer(receipt.logs)
    ) {
      throw new MonadX402Error(
        "X402_TRANSACTION_RECEIPT_INVALID",
        "The Monad receipt does not prove the approved test-USDC transfer.",
        { fundsMoved: true, transactionHash: hash },
      );
    }
    const blockNumber = safeBlockNumber(receipt.blockNumber);
    if (blockNumber === null) {
      throw new MonadX402Error(
        "X402_TRANSACTION_RECEIPT_INVALID",
        "The Monad receipt has an invalid block number.",
        { fundsMoved: true, transactionHash: hash },
      );
    }
    return { blockNumber };
  }

  async readLimitedBody(response, controller, hash) {
    const contentLength = response.headers.get("content-length");
    if (
      contentLength &&
      (!/^[0-9]+$/.test(contentLength) || Number(contentLength) > this.responseLimitBytes)
    ) {
      throw new MonadX402Error("X402_RESOURCE_RESPONSE_TOO_LARGE", "The paid resource response is too large.", {
        fundsMoved: true,
        transactionHash: hash,
      });
    }
    const chunks = [];
    let byteLength = 0;
    const reader = response.body?.getReader?.();
    let abortListener;
    const aborted = new Promise((_, reject) => {
      abortListener = () => reject(new DOMException("The operation was aborted.", "AbortError"));
      if (controller.signal.aborted) abortListener();
      else controller.signal.addEventListener("abort", abortListener, { once: true });
    });
    try {
      if (!reader) return "";
      while (true) {
        const { done, value } = await Promise.race([reader.read(), aborted]);
        if (done) break;
        const chunk = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
        byteLength += chunk.byteLength;
        if (byteLength > this.responseLimitBytes) {
          await reader.cancel().catch(() => undefined);
          throw new MonadX402Error("X402_RESOURCE_RESPONSE_TOO_LARGE", "The paid resource response is too large.", {
            fundsMoved: true,
            transactionHash: hash,
          });
        }
        chunks.push(chunk);
      }
      return Buffer.concat(chunks, byteLength).toString("utf8");
    } catch (error) {
      if (error instanceof MonadX402Error) throw error;
      if (controller.signal.aborted || error?.name === "AbortError") {
        await reader?.cancel().catch(() => undefined);
        throw new MonadX402Error("X402_RESOURCE_RESPONSE_TIMEOUT", "The paid resource response timed out.", {
          fundsMoved: true,
          transactionHash: hash,
        });
      }
      throw new MonadX402Error("X402_RESOURCE_RESPONSE_INVALID", "The paid resource response could not be read.", {
        fundsMoved: true,
        transactionHash: hash,
      });
    } finally {
      if (abortListener) controller.signal.removeEventListener("abort", abortListener);
    }
  }

  parseJson(text, hash) {
    try {
      return JSON.parse(text);
    } catch {
      throw new MonadX402Error("X402_RESOURCE_RESPONSE_INVALID", "The paid resource did not return JSON.", {
        fundsMoved: true,
        transactionHash: hash,
      });
    }
  }

  async beginPaidFetch(url, headers) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
    };
    try {
      const response = await this.fetch(url, {
        method: "GET",
        headers: {
          Accept: "application/json",
          ...headers,
        },
        redirect: "manual",
        signal: controller.signal,
      });
      if (!response || typeof response.status !== "number" || !response.headers) {
        throw new MonadX402Error("X402_INVALID_RESPONSE", "The x402 resource returned an invalid response.");
      }
      if (isRedirect(response.status)) {
        throw new MonadX402Error("X402_REDIRECT_BLOCKED", "The x402 resource attempted a redirect.");
      }
      return { close, controller, response };
    } catch (error) {
      close();
      if (error instanceof MonadX402Error) throw error;
      if (controller.signal.aborted || error?.name === "AbortError") {
        throw new MonadX402Error("X402_UPSTREAM_TIMEOUT", "The x402 resource timed out.");
      }
      throw new MonadX402Error("X402_UPSTREAM_UNREACHABLE", "The x402 resource could not be reached.");
    }
  }

  normalizeAvailability(payload, { contentRoot, budgetCurrency, operationPaymentId, hash }) {
    const availability = payload?.availability || payload?.paymentResponse || payload;
    if (!availability || typeof availability !== "object") {
      throw new MonadX402Error("X402_RESOURCE_RESPONSE_INVALID", "The paid availability response is invalid.", {
        fundsMoved: true,
        transactionHash: hash,
      });
    }
    if (
      availability.contentRoot !== contentRoot ||
      availability.paymentId !== operationPaymentId ||
      !Number.isSafeInteger(availability.candidateProviders) ||
      availability.candidateProviders < 1 ||
      availability.candidateProviders > 100 ||
      availability.recommendedProvider !== this.expectedProviderId ||
      !Number.isSafeInteger(availability.estimatedRecoverySeconds) ||
      availability.estimatedRecoverySeconds < 1 ||
      availability.estimatedRecoverySeconds > 86_400 ||
      !Number.isSafeInteger(availability.estimatedCostMinor) ||
      availability.estimatedCostMinor < 0 ||
      String(availability.estimatedCostCurrency || "USD").toUpperCase() !== "USD" ||
      typeof availability.confidence !== "number" ||
      !Number.isFinite(availability.confidence) ||
      availability.confidence < 0 ||
      availability.confidence > 1
    ) {
      throw new MonadX402Error("X402_RESOURCE_RESPONSE_INVALID", "The paid availability response failed validation.", {
        fundsMoved: true,
        transactionHash: hash,
      });
    }
    return {
      candidateProviders: availability.candidateProviders,
      recommendedProvider: availability.recommendedProvider,
      estimatedRecoverySeconds: availability.estimatedRecoverySeconds,
      estimatedCostMinor: fromAccountingMinorUp(availability.estimatedCostMinor, budgetCurrency),
      estimatedCostCurrency: budgetCurrency,
      confidence: availability.confidence,
    };
  }

  async performSettlement({ missionId, contentRoot, payer, budgetCurrency, receiptId }) {
    const preflight = this.preflights.get(this.preflightKey(contentRoot, budgetCurrency));
    if (!preflight) {
      throw new MonadX402Error(
        "X402_PREFLIGHT_REQUIRED",
        "A fresh verified HTTP 402 response is required before signing.",
        { statusCode: 409 },
      );
    }
    if (currentTime(this.clock).getTime() - preflight.fetchedAt > this.preflightTtlMs) {
      this.preflights.delete(this.preflightKey(contentRoot, budgetCurrency));
      throw new MonadX402Error(
        "X402_PREFLIGHT_EXPIRED",
        "The HTTP 402 payment requirement expired before signing.",
        { statusCode: 409 },
      );
    }

    await this.assertNetwork();
    await this.assertBalance();
    const operationPaymentId = paymentIdentifier(missionId, contentRoot);
    const { httpClient } = this.createPaymentClient({
      expectedResourceUrl: preflight.resourceUrl,
      operationPaymentId,
    });

    const pendingPayment = {
      receiptId,
      paymentId: operationPaymentId,
      missionId,
      contentRoot,
      principalId: payer,
      payer: this.payerAddress,
      payee: this.payToAddress,
      asset: this.assetAddress,
      amountAtomic: this.expectedAmountAtomic.toString(),
      currency: budgetCurrency,
      network: this.network,
      mode: this.mode,
      status: "reconciliation_required",
      outcome: "unknown",
      synthetic: false,
      externalEndpoint: true,
      preparedAt: currentTime(this.clock).toISOString(),
    };
    try {
      // This durable write happens before signature creation. A crash after it
      // can cause a conservative false-positive reconciliation block, but can
      // never silently authorize the same operation twice.
      await this.persistPendingPayment(clone(pendingPayment));
    } catch {
      throw new MonadX402Error(
        "X402_PENDING_PAYMENT_PERSIST_FAILED",
        "The pending x402 operation could not be durably recorded, so no payment was signed.",
        { statusCode: 503, retryable: true },
      );
    }
    this.pendingReconciliation.set(receiptId, pendingPayment);

    let paymentPayload;
    try {
      paymentPayload = await httpClient.createPaymentPayload(clone(preflight.paymentRequired));
    } catch (error) {
      if (error instanceof MonadX402Error) throw error;
      throw new MonadX402Error("X402_PAYMENT_SIGNATURE_FAILED", "The Monad payment authorization could not be signed.");
    }
    if (
      extractPaymentIdentifier(paymentPayload) !== operationPaymentId ||
      !this.matchingRequirement(paymentPayload.accepted)
    ) {
      throw new MonadX402Error("X402_PAYMENT_PAYLOAD_INVALID", "The generated payment payload failed policy validation.");
    }

    const headers = httpClient.encodePaymentSignatureHeader(paymentPayload);
    let pendingResponse;
    try {
      pendingResponse = await this.beginPaidFetch(preflight.resourceUrl, headers);
    } catch (error) {
      if (error instanceof MonadX402Error) {
        throw new MonadX402Error(
          "X402_SETTLEMENT_OUTCOME_UNKNOWN",
          "The paid request did not return a settlement result. Reconcile the payment identifier before retrying.",
          { outcomeUnknown: true },
        );
      }
      throw error;
    }
    const { response } = pendingResponse;
    let hash = null;
    let text;
    try {
      const processed = await httpClient.processPaymentResult(
        paymentPayload,
        (name) => response.headers.get(name),
        response.status,
      );
      if (processed.recovered) {
        throw new MonadX402Error("X402_UNEXPECTED_RECOVERY", "The payment client requested an unsafe automatic retry.");
      }
      hash = this.assertSettleResponse(processed.settleResponse);
      if (response.status < 200 || response.status >= 300) {
        throw new MonadX402Error(
          "X402_RESOURCE_DELIVERY_FAILED",
          "Payment settled, but the seller did not deliver the resource.",
          { fundsMoved: true, transactionHash: hash },
        );
      }
      text = await this.readLimitedBody(response, pendingResponse.controller, hash);
    } catch (error) {
      if (
        error instanceof MonadX402Error &&
        !hash &&
        error.code !== "X402_SETTLEMENT_FAILED"
      ) {
        throw new MonadX402Error(
          "X402_SETTLEMENT_OUTCOME_UNKNOWN",
          "The paid request did not provide a trustworthy settlement result. Reconcile the payment identifier before retrying.",
          { outcomeUnknown: true },
        );
      }
      throw error;
    } finally {
      pendingResponse.close();
    }
    const payload = this.parseJson(text, hash);
    const confirmed = await this.verifyTransaction(hash);
    const paymentResponse = this.normalizeAvailability(payload, {
      contentRoot,
      budgetCurrency,
      operationPaymentId,
      hash,
    });
    const timestamp = currentTime(this.clock).toISOString();
    const usdImpactMinor = usdMinorForUsdcAtomic(this.expectedAmountAtomic);
    const receipt = {
      receiptId,
      missionId,
      contentRoot,
      principalId: payer,
      payer: this.payerAddress,
      payee: this.payToAddress,
      paymentId: operationPaymentId,
      amountMinor: fromAccountingMinorUp(usdImpactMinor, budgetCurrency),
      currency: budgetCurrency,
      budgetImpactMinor: fromAccountingMinorUp(usdImpactMinor, budgetCurrency),
      settlementAsset: {
        symbol: "USDC",
        address: this.assetAddress,
        decimals: USDC_DECIMALS,
        amountAtomic: this.expectedAmountAtomic.toString(),
      },
      network: this.network,
      chainId: this.chainId,
      blockNumber: confirmed.blockNumber,
      confirmations: this.confirmations,
      transactionHash: hash,
      explorerUrl: `${this.explorerBaseUrl.href}${hash}`,
      status: "settled",
      confirmed: true,
      synthetic: false,
      fundsMoved: true,
      chainWrite: true,
      externalEndpoint: true,
      timestamp,
      paymentResponse,
      mode: this.mode,
    };
    this.receipts.set(receiptId, receipt);
    this.pendingReconciliation.delete(receiptId);
    return clone(receipt);
  }

  async settleAvailability({
    missionId,
    contentRoot,
    payer,
    budgetCurrency = "USD",
  }) {
    assertIdentifier(missionId, "INVALID_X402_PAYMENT", "Mission ID");
    assertIdentifier(contentRoot, "INVALID_X402_PAYMENT", "Content root");
    assertIdentifier(payer, "INVALID_X402_PAYMENT", "Principal ID");
    const currency = normalizeCurrency(budgetCurrency);
    if (!currency) {
      throw new MonadX402Error("CURRENCY_NOT_SUPPORTED", "The mission currency is not supported.", {
        statusCode: 422,
      });
    }
    const receiptId = this.receiptId(missionId, contentRoot);
    const restored = this.receipts.get(receiptId);
    if (restored) {
      if (restored.currency !== currency || restored.principalId !== payer) {
        throw new MonadX402Error("X402_RECEIPT_CONTEXT_MISMATCH", "The stored receipt belongs to a different mission context.", {
          statusCode: 409,
        });
      }
      return clone(restored);
    }
    const existingFlight = this.inFlight.get(receiptId);
    if (existingFlight) return clone(await existingFlight);
    const pending = this.pendingReconciliation.get(receiptId);
    if (pending) {
      throw new MonadX402Error(
        "X402_RECONCILIATION_REQUIRED",
        `Payment ${pending.paymentId} has an unresolved prior authorization. Reconcile it before creating another signature.`,
        { statusCode: 409, outcomeUnknown: true },
      );
    }

    const settlement = this.performSettlement({
      missionId,
      contentRoot,
      payer,
      budgetCurrency: currency,
      receiptId,
    });
    this.inFlight.set(receiptId, settlement);
    try {
      return clone(await settlement);
    } finally {
      this.inFlight.delete(receiptId);
    }
  }
}

module.exports = {
  ABSOLUTE_MAX_PAYMENT_ATOMIC,
  DEFAULT_CONFIRMATIONS,
  DEFAULT_DISCOVERY_AMOUNT_ATOMIC,
  MONAD_TESTNET_CHAIN_ID,
  MONAD_TESTNET_EXPLORER,
  MONAD_TESTNET_NETWORK,
  MONAD_TESTNET_USDC,
  MonadX402Adapter,
  MonadX402Error,
  TRANSFER_EVENT_ABI,
  paymentIdentifier,
  receiptIdentifier,
};
