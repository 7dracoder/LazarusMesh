'use strict';

const fs = require('node:fs');
const { createPrivyServerWalletSigner } = require('./services/privy-signer');
const { normalizeCurrency } = require('./domain/currency');
const { normalizeTrustedManifest } = require('./services/recovery-remote');

const MERCHANT_REMOTE_REQUIRED = Object.freeze([
  'MERCHANT_BASE_URL',
  'MERCHANT_API_TOKEN',
  'MERCHANT_EXPECTED_KEY_ID',
  'MERCHANT_CURRENCY',
  'MERCHANT_TRUSTED_MANIFEST_JSON',
]);

const MERCHANT_REMOTE_OPTIONAL = Object.freeze([
  'MERCHANT_TIMEOUT_MS',
  'MERCHANT_RESPONSE_LIMIT_BYTES',
  'MERCHANT_MAXIMUM_PIECE_BYTES',
  'MERCHANT_MAXIMUM_TOTAL_BYTES',
]);

function unquote(value) {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
  }
  return value;
}

/** Load a simple local .env file without overriding process-level secrets. */
function loadEnvFile(filePath, env = process.env) {
  let contents;
  try {
    contents = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }

  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const equals = line.indexOf('=');
    if (equals < 1) continue;
    const name = line.slice(0, equals).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) continue;
    if (env[name] !== undefined) continue;
    env[name] = unquote(line.slice(equals + 1).trim());
  }
  return true;
}

function nonempty(env, name) {
  const value = env[name];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function positiveInteger(env, name, fallback) {
  const raw = nonempty(env, name);
  if (raw === null) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative safe integer.`);
  }
  return value;
}

function rainSandboxConfig(env = process.env) {
  return {
    baseUrl: nonempty(env, 'RAIN_API_BASE_URL'),
    apiKey: nonempty(env, 'RAIN_API_KEY'),
    userId: nonempty(env, 'RAIN_USER_ID'),
    teamId: nonempty(env, 'RAIN_TEAM_ID'),
    contractId: nonempty(env, 'RAIN_CONTRACT_ID'),
    autoFundMinor: positiveInteger(env, 'RAIN_AUTO_FUND_MINOR', 0),
    timeoutMs: positiveInteger(env, 'RAIN_TIMEOUT_MS', 12_000),
  };
}

function merchantRemoteConfig(env = process.env) {
  const mode = nonempty(env, 'MERCHANT_MODE') || 'local';
  if (!['local', 'remote'].includes(mode)) {
    throw new Error('MERCHANT_MODE must be exactly local or remote.');
  }
  const configuredNames = [...MERCHANT_REMOTE_REQUIRED, ...MERCHANT_REMOTE_OPTIONAL]
    .filter((name) => nonempty(env, name));
  if (mode === 'local') {
    if (configuredNames.length) {
      throw new Error('Remote merchant settings require MERCHANT_MODE=remote.');
    }
    return null;
  }

  const missing = MERCHANT_REMOTE_REQUIRED.filter((name) => !nonempty(env, name));
  if (missing.length) {
    throw new Error(`Remote merchant configuration is incomplete; missing ${missing.join(', ')}.`);
  }
  const baseUrl = normalizeRemoteMerchantUrl(nonempty(env, 'MERCHANT_BASE_URL'));
  const expectedKeyId = nonempty(env, 'MERCHANT_EXPECTED_KEY_ID');
  if (!/^merchant_ed25519_[a-f0-9]{64}$/.test(expectedKeyId)) {
    throw new Error('MERCHANT_EXPECTED_KEY_ID must be a pinned Ed25519 fingerprint.');
  }
  const currency = normalizeCurrency(nonempty(env, 'MERCHANT_CURRENCY'), '');
  if (!currency) throw new Error('MERCHANT_CURRENCY must be USD, EUR, GBP, CAD, or AUD.');

  const timeoutMs = merchantPositiveInteger(env, 'MERCHANT_TIMEOUT_MS', 5_000, 30_000);
  const responseLimitBytes = merchantPositiveInteger(
    env,
    'MERCHANT_RESPONSE_LIMIT_BYTES',
    1_048_576,
    1_048_576,
  );
  const maximumPieceBytes = merchantPositiveInteger(
    env,
    'MERCHANT_MAXIMUM_PIECE_BYTES',
    1_048_576,
    16 * 1_048_576,
  );
  const maximumTotalBytes = merchantPositiveInteger(
    env,
    'MERCHANT_MAXIMUM_TOTAL_BYTES',
    32 * 1_048_576,
    512 * 1_048_576,
  );

  const manifestJson = nonempty(env, 'MERCHANT_TRUSTED_MANIFEST_JSON');
  if (Buffer.byteLength(manifestJson, 'utf8') > responseLimitBytes) {
    throw new Error('MERCHANT_TRUSTED_MANIFEST_JSON exceeds MERCHANT_RESPONSE_LIMIT_BYTES.');
  }
  let manifest;
  try {
    manifest = JSON.parse(manifestJson);
  } catch {
    throw new Error('MERCHANT_TRUSTED_MANIFEST_JSON must contain valid JSON.');
  }
  const trustedManifest = normalizeTrustedManifest(manifest, {
    maximumPieceBytes,
    maximumTotalBytes,
  });

  return Object.freeze({
    mode: 'remote',
    baseUrl,
    apiToken: nonempty(env, 'MERCHANT_API_TOKEN'),
    expectedKeyId,
    currency,
    trustedManifest,
    contentRoot: trustedManifest.merkleRootSha256,
    timeoutMs,
    responseLimitBytes,
    maximumPieceBytes,
    maximumTotalBytes,
  });
}

function merchantPositiveInteger(env, name, fallback, maximum) {
  const raw = nonempty(env, name);
  if (raw === null) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${name} must be a positive integer no greater than ${maximum}.`);
  }
  return value;
}

function normalizeRemoteMerchantUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('MERCHANT_BASE_URL must be a valid URL.');
  }
  const loopback = ['127.0.0.1', 'localhost', '::1'].includes(url.hostname.toLowerCase());
  if (url.protocol !== 'https:' && !(loopback && url.protocol === 'http:')) {
    throw new Error('MERCHANT_BASE_URL must use HTTPS except on loopback.');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('MERCHANT_BASE_URL must not contain credentials, query, or fragment.');
  }
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/`;
  return url.href;
}

function monadReadiness(env = process.env) {
  const chainId = Number(nonempty(env, 'MONAD_CHAIN_ID') || 10143);
  const privySignerConfigured = [
    'PRIVY_APP_ID',
    'PRIVY_APP_SECRET',
    'PRIVY_PAYER_WALLET_ID',
    'PRIVY_PAYER_ADDRESS',
  ].every((name) => Boolean(nonempty(env, name)));
  return {
    network: nonempty(env, 'MONAD_NETWORK') || 'eip155:10143',
    chainId: Number.isSafeInteger(chainId) ? chainId : null,
    rpcConfigured: Boolean(nonempty(env, 'MONAD_RPC_URL')),
    signerConfigured: Boolean(nonempty(env, 'MONAD_PRIVATE_KEY')) || privySignerConfigured,
    contractConfigured: Boolean(nonempty(env, 'MONAD_BOUNTY_CONTRACT')),
    payToConfigured: Boolean(nonempty(env, 'MONAD_PAY_TO_ADDRESS')),
    usdcConfigured: Boolean(nonempty(env, 'MONAD_USDC_ADDRESS')),
    facilitatorConfigured: Boolean(nonempty(env, 'X402_FACILITATOR_URL')),
    resourceConfigured: Boolean(nonempty(env, 'X402_AVAILABILITY_BASE_URL')),
  };
}

function monadNetworkConfig(env = process.env) {
  return {
    rpcOrigin: nonempty(env, 'MONAD_RPC_URL'),
    facilitatorOrigin: nonempty(env, 'X402_FACILITATOR_URL'),
    timeoutMs: positiveInteger(env, 'MONAD_PROBE_TIMEOUT_MS', 5_000),
  };
}

function monadX402Config(env = process.env) {
  const expectedAmountAtomic = nonempty(env, 'X402_EXPECTED_AMOUNT_ATOMIC') || '10000';
  const maxPaymentAtomic = nonempty(env, 'X402_MAX_PAYMENT_ATOMIC') || expectedAmountAtomic;
  const maxAuthorizationSeconds = positiveInteger(env, 'X402_MAX_AUTHORIZATION_SECONDS', 300);
  const timeoutMs = positiveInteger(env, 'X402_TIMEOUT_MS', 12_000);
  const privateKey = nonempty(env, 'MONAD_PRIVATE_KEY');
  const privyNames = [
    'PRIVY_APP_ID',
    'PRIVY_APP_SECRET',
    'PRIVY_PAYER_WALLET_ID',
    'PRIVY_PAYER_ADDRESS',
  ];
  const providedPrivyNames = privyNames.filter((name) => nonempty(env, name));
  if (providedPrivyNames.length > 0 && providedPrivyNames.length !== privyNames.length) {
    const missing = privyNames.filter((name) => !nonempty(env, name));
    throw new Error(`Privy payer signer configuration is incomplete; missing ${missing.join(', ')}.`);
  }
  const payToAddress = nonempty(env, 'MONAD_PAY_TO_ADDRESS');
  const signer = providedPrivyNames.length === privyNames.length
    ? createPrivyServerWalletSigner({
      appId: nonempty(env, 'PRIVY_APP_ID'),
      appSecret: nonempty(env, 'PRIVY_APP_SECRET'),
      walletId: nonempty(env, 'PRIVY_PAYER_WALLET_ID'),
      address: nonempty(env, 'PRIVY_PAYER_ADDRESS'),
      expectedPayToAddress: payToAddress,
      maxPaymentAtomic,
      maxAuthorizationSeconds,
      timeoutMs,
    })
    : null;
  return {
    availabilityBaseUrl: nonempty(env, 'X402_AVAILABILITY_BASE_URL'),
    payToAddress,
    privateKey,
    signer,
    rpcUrl: nonempty(env, 'MONAD_RPC_URL'),
    expectedAmountAtomic,
    maxPaymentAtomic,
    maxAuthorizationSeconds,
    timeoutMs,
    preflightTtlMs: positiveInteger(env, 'X402_PREFLIGHT_TTL_MS', 60_000),
    responseLimitBytes: positiveInteger(env, 'X402_RESPONSE_LIMIT_BYTES', 65_536),
    confirmations: positiveInteger(env, 'MONAD_X402_CONFIRMATIONS', 6),
    expectedProviderId: nonempty(env, 'X402_EXPECTED_PROVIDER_ID') || 'provider_atlas_archive',
    paymentNamespace: nonempty(env, 'X402_PAYMENT_NAMESPACE') || 'default',
  };
}

module.exports = {
  loadEnvFile,
  merchantRemoteConfig,
  monadNetworkConfig,
  monadReadiness,
  monadX402Config,
  rainSandboxConfig,
};
