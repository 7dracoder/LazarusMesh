'use strict';

const fs = require('node:fs');

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
    autoFundMinor: positiveInteger(env, 'RAIN_AUTO_FUND_MINOR', 2000),
    timeoutMs: positiveInteger(env, 'RAIN_TIMEOUT_MS', 12_000),
  };
}

function monadReadiness(env = process.env) {
  const chainId = Number(nonempty(env, 'MONAD_CHAIN_ID') || 10143);
  return {
    network: nonempty(env, 'MONAD_NETWORK') || 'eip155:10143',
    chainId: Number.isSafeInteger(chainId) ? chainId : null,
    rpcConfigured: Boolean(nonempty(env, 'MONAD_RPC_URL')),
    signerConfigured: Boolean(nonempty(env, 'MONAD_PRIVATE_KEY')),
    contractConfigured: Boolean(nonempty(env, 'MONAD_BOUNTY_CONTRACT')),
    payToConfigured: Boolean(nonempty(env, 'MONAD_PAY_TO_ADDRESS')),
    usdcConfigured: Boolean(nonempty(env, 'MONAD_USDC_ADDRESS')),
    facilitatorConfigured: Boolean(nonempty(env, 'X402_FACILITATOR_URL')),
  };
}

function monadNetworkConfig(env = process.env) {
  return {
    rpcOrigin: nonempty(env, 'MONAD_RPC_URL'),
    facilitatorOrigin: nonempty(env, 'X402_FACILITATOR_URL'),
    timeoutMs: positiveInteger(env, 'MONAD_PROBE_TIMEOUT_MS', 5_000),
  };
}

module.exports = {
  loadEnvFile,
  monadNetworkConfig,
  monadReadiness,
  rainSandboxConfig,
};
