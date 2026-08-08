# Lazarus Mesh production-readiness boundary

Updated: 2026-08-08

## Executive status

Lazarus Mesh is a production-shaped hybrid sandbox, not a production payment or recovery service. The application now reports that boundary directly in its API and UI instead of treating every configured rail as live.

| Component | Executed today | Production boundary |
| --- | --- | --- |
| Rain | Authenticated Rain sandbox calls for collateral simulation, scoped-card issuance, authorization simulation, settlement simulation, reversal, and card lookup | No production card program, card-network checkout, webhook reconciliation, refunds, or remote freeze/close |
| Monad | Local deterministic bounty ledger plus read-only testnet RPC readiness | No signed transaction, deployed registry call, receipt polling, replacement, or reorg handling |
| x402 | Local 402 requirement/receipt plus read-only facilitator capability probe | No payer signature, `PAYMENT-SIGNATURE`, facilitator verification, facilitator settlement, or `PAYMENT-RESPONSE` validation |
| Bargaining | Deterministic, policy-bounded local offers and counteroffers | No authenticated merchant session or merchant-signed binding quote |
| Recovery | Real hashing, piece verification, reconstruction, and root validation over the bundled CC0 fixture | No external provider transfer, durable storage, independent verifier service, or persistent reseeding |

`ADAPTER_MODE=rain-sandbox` therefore means **Rain sandbox writes with local execution everywhere else**. It does not mean production, real-money settlement, or Monad testnet writes.

## Mission-creation contract

The mission form and API share these published limits through `state.system.missionCreation`:

- verified source: bundled 24-piece CC0 fixture;
- minimum recovery-service spend cap: `$12.01`;
- maximum recovery-service spend cap: `$5,000.00`;
- provider reward range: `$1.00` to `$1,000.00`;
- default recovery spend cap: `$20.00`;
- default provider reward: `$5.00`.

The recovery-service cap and provider bounty are separate commitments. Maximum authorized exposure is their sum. The `$12.01` service reserve is `$12.00` for the maximum local archive quote plus `$0.01` for x402-style discovery. The normal deterministic bargain settles the archive quote at `$9.75`, so the demonstrated service spend is `$9.76`.

Mission creation now fails closed when a client submits a different content root, piece count, or license. Earlier builds ignored those fields while still recovering the fixture, which could mislabel the artifact.

## Configuration readiness

The checked local environment currently has:

- complete, syntactically valid Rain sandbox configuration;
- Monad testnet RPC configuration;
- Monad testnet USDC configuration;
- an x402 facilitator origin;
- no Monad signer;
- no deployed bounty-registry address;
- no x402 pay-to address;
- no live merchant-negotiation endpoint;
- no network recovery-provider or persistent reseeding service.

Secrets remain server-side. The local `.env` file is ignored by version control and is restricted to its owner. Because the Rain API credential was shared in chat, rotate it before a production or externally shared deployment. Do not place production signing keys in `.env`; use a managed signer or secret manager.

## Required path to a testnet-live release

1. Add a distinct `testnet-live` mode. Never silently promote `rain-sandbox` to live execution.
2. Move missions, external-operation attempts, idempotency records, receipts, and reconciliation state into a transactional database.
3. Compile, test, audit, deploy, and verify `RecoveryBountyRegistry.sol` on Monad testnet.
4. Use a managed signer/custody boundary. Simulate every transaction, enforce fee and nonce policy, wait for confirmations, and reconcile replacement or reorg events.
5. Implement the x402 v2 buyer flow against an allowlisted resource: validate the 402 requirements, network, token, payee, amount, expiry, and resource; sign the authorization; retry with `PAYMENT-SIGNATURE`; validate `PAYMENT-RESPONSE` and the onchain settlement.
6. Replace the deterministic Atlas merchant with an authenticated negotiation API whose binding quote is signed or authenticated independently of this process.
7. Use a Rain-supported PCI-safe checkout/token handoff and issuer-level controls. Add signed webhooks, replay protection, transaction reconciliation, reversals/refunds, disputes, and a real freeze/close lifecycle.
8. Add authenticated provider streaming, manifest ingestion, durable artifact storage, independent verifier services, persistent reseeding, and ongoing availability evidence.
9. Add user authentication, tenant isolation, RBAC, rate limits, audit-log retention, alerting, and incident runbooks.
10. Run a capped testnet pilot before any mainnet or production-card onboarding.

## Crash-safety requirements

The orchestrator must treat external work as a resumable saga, not a single in-memory function call. Persist an operation record before each external mutation, use a stable idempotency key, store the remote identifier immediately, and reconcile before retrying. Test process termination after every Rain, Monad, x402, merchant, and storage mutation.

Sandbox reset and startup now preserve the remote-authority boundary: an unexpired Rain sandbox card recorded as `active` or `expiry_scheduled` blocks destructive reset/startup state replacement until its recorded expiry.

## Go-live tests

- Solidity unit, invariant, fuzz, fork, and malicious-token tests;
- multi-actor Monad testnet lifecycle and reorg/replacement tests;
- Rain sandbox contract tests plus signed-webhook replay and reordering tests;
- x402 wrong-chain, wrong-token, wrong-payee, overprice, expiry, duplicate-settlement, facilitator-outage, and insufficient-funds tests;
- merchant quote identity, signature, replay, expiry, and term-tampering tests;
- provider corruption, truncation, timeout, partial-failure, and reseeding-availability tests;
- crash/restart tests after every external mutation;
- authentication, tenant-boundary, SSRF, payment-drain, custody, and card-data security reviews.

## Current protocol references

- [Monad network information](https://docs.monad.xyz/developer-essentials/network-information)
- [Monad testnet information](https://docs.monad.xyz/developer-essentials/testnet)
- [Monad x402 guide](https://docs.monad.xyz/guides/x402)
- [x402 v2 client/server flow](https://docs.cdp.coinbase.com/x402/core-concepts/how-it-works)
- [x402 facilitator responsibilities](https://docs.cdp.coinbase.com/x402/core-concepts/facilitator)

Monad mainnet uses chain ID `143`; this project intentionally targets testnet chain ID `10143` until the live-write prerequisites above are complete.
