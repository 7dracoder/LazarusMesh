# API and Testnet Integration Guide

This document describes the code that exists now. It is not a future architecture sketch.

The application currently has one real external execution boundary: the Rain sandbox adapter. Merchant negotiation, Monad bounty accounting, x402 settlement, and recovery-provider discovery remain local implementations. When Monad RPC and facilitator origins are configured, `/api/health` also performs read-only network readiness checks; those checks do not sign, submit, verify, or settle a payment.

## Current capability matrix

| Component | `ADAPTER_MODE=local` | `ADAPTER_MODE=rain-sandbox` | What is not live |
| --- | --- | --- | --- |
| Rain | `LocalRainAdapter` | `RainSandboxAdapter` calls Rain sandbox endpoints | No production card program, webhook ingestion, or remote card cancellation |
| Merchant negotiation | `LocalNegotiationAdapter` | Same local adapter | No request is sent to a real merchant or marketplace |
| Monad bounty execution | `LocalMonadAdapter` | Same local ledger | No contract deployment, signing, transaction submission, receipt polling, or reorg handling |
| Monad readiness | Optional read-only probe | Optional read-only probe | Probe success does not enable writes |
| x402 | `LocalX402Adapter` | Same local handshake | No wallet signature and no facilitator `/verify` or `/settle` call |
| Recovery | Real byte splitting, hashing, reconstruction, and verification against the local fixture | Same local recovery | No external DHT, IPFS, archive vendor, or verifier network |

There is no `monad-testnet` or `full-live` adapter mode. Supplying Monad-related environment variables does not change the execution adapters.

## Modes, configuration, and health

### Supported modes

`server.js` accepts exactly two modes:

- `local`: all execution adapters are local. If both Monad probe origins are configured, a call to `/api/health` may still perform read-only network requests.
- `rain-sandbox`: Rain card operations use the sandbox; negotiation, Monad writes, x402 settlement, and recovery remain local. Public state calls this `hybrid-sandbox`.

An unknown mode fails at startup. Rain sandbox configuration errors also fail at startup; there is no silent fallback to the local Rain adapter.

The server binds to `127.0.0.1`. Every request must carry a loopback `Host`, and POST requests reject cross-site or mismatched-origin browser requests. This server has no user authentication and must not be exposed directly to a public network.

### Environment variables actually read

Never put real values in source control, browser code, API responses, screenshots, model input, or documentation.

| Variable | Current use |
| --- | --- |
| `PORT` | Loopback HTTP port; defaults to `4173` |
| `ADAPTER_MODE` | `local` or `rain-sandbox` |
| `RAIN_API_BASE_URL` | Required HTTPS Rain sandbox base URL in `rain-sandbox` mode |
| `RAIN_API_KEY` | Required server-side Rain API key |
| `RAIN_USER_ID` | Required Rain UUID used for scoped-card issuance and health queries |
| `RAIN_TEAM_ID` | Optional Rain UUID added to the transaction health query |
| `RAIN_CONTRACT_ID` | Required Rain funding-contract UUID used by the sandbox collateral simulation |
| `RAIN_AUTO_FUND_MINOR` | Sandbox collateral amount in minor units; defaults to `2000`; `0` disables auto-funding |
| `RAIN_TIMEOUT_MS` | Rain request timeout; defaults to 12 seconds and is clamped to 1-30 seconds |
| `MONAD_NETWORK` | Display/readiness label; defaults to `eip155:10143`; does not choose the execution chain |
| `MONAD_CHAIN_ID` | Display/readiness value; defaults to `10143`; the network probe independently requires `10143` |
| `MONAD_RPC_URL` | Pure HTTPS origin for the read-only `eth_chainId` probe |
| `X402_FACILITATOR_URL` | Pure HTTPS origin for the read-only facilitator `/supported` probe |
| `MONAD_PROBE_TIMEOUT_MS` | Per-probe timeout; defaults to 5 seconds |
| `MONAD_PRIVATE_KEY` | Presence is reported by health only; it is never read for signing |
| `MONAD_BOUNTY_CONTRACT` | Presence is reported by health only; no contract call uses it |
| `MONAD_PAY_TO_ADDRESS` | Presence is reported by health only; the local x402 receipt does not use it |
| `MONAD_USDC_ADDRESS` | Parsed as readiness metadata but not used by the current server or adapters |

`RAIN_WEBHOOK_SECRET` may appear in older examples, but the current server does not read it and exposes no Rain webhook route.

Rain identifiers and Monad identifiers are not interchangeable. In particular, `RAIN_CONTRACT_ID` identifies the Rain sandbox funding contract; it is not the deployed address for `RecoveryBountyRegistry.sol`. A value described as "collateral" still must be a valid Rain UUID before the adapter will make any request.

### `GET /api/health`

Health returns the selected mode and safe status metadata, never configured secret values.

- Local Rain reports `ok: true`, `authenticated: false` without a network request.
- Rain sandbox health sends `GET /issuing/transactions?userId=...&limit=1` and includes `teamId` when configured. Failure makes health return HTTP `503`.
- The Monad probe runs only when both `MONAD_RPC_URL` and `X402_FACILITATOR_URL` are present. If either is absent, health reports the network probe as unconfigured and does not fail overall health solely for that absence.
- If both probe origins are configured, either probe failing makes health return HTTP `503`.
- Health always reports Monad execution as `local-ledger` with `writesEnabled: false`, and x402 execution as `local-handshake` with `liveSettlementEnabled: false`.
- `signerConfigured`, `contractConfigured`, and `payToConfigured` are presence flags, not proof that a key, deployment, or payee is valid.

The top-level `networkAccess` field means only that this process may contact Rain or both readiness origins. It must not be interpreted as "all integrations are live."

## Rain sandbox adapter

Implementation boundary: `src/services/rain-sandbox.js`. The builder resource links to the [Rain sandbox API documentation](https://rain-sandbox-trial.mintlify.site/) and its [session ID key guide](https://rain-sandbox-trial.mintlify.site/docs/resource-sessionid-keys); access may be restricted by Rain.

### Endpoint mapping

Every Rain request sends `Accept: application/json` and `Api-Key` from server memory. JSON writes also send `Content-Type: application/json`. Mutating calls use deterministic 64-character SHA-256 `Idempotency-Key` values.

| Adapter operation | Rain sandbox request | Request mapping and result |
| --- | --- | --- |
| `health()` | `GET /issuing/transactions` | Queries one transaction for `userId`, optionally scoped by `teamId`; no retry |
| `fundCollateral()` | `POST /simulate/collateral/fund` | Sends `contractId`, `currency: "rusd"`, and integer `amount`; cached so automatic funding is shared by card creation attempts |
| `createScopedCard()` | `POST /issuing/users/:userId/cards/scoped` | Sends `amountInUSDCents`, ISO `expiresAt`, and four-digit `allowedMccs`; also sends an encrypted `sessionid` header |
| `authorizePurchase()` | `POST /simulate/transactions/authorize` | Sends `cardId`, integer `amount`, currency, merchant name, and MCC after local policy checks |
| Automatic settlement | `POST /simulate/transactions/:transactionId/settle` | Runs after an allowed authorization unless `settle: false`; sends the exact accepted amount explicitly because the current beta validator rejects the quickstart's empty-body form |
| Negative-control reversal | `POST /simulate/transactions/:transactionId/reverse` | Used only if the deliberate merchant/MCC control exercise is unexpectedly authorized remotely |
| `getCard()` | `GET /issuing/cards/:cardId` | Refreshes only the cached remote status before returning the locally bounded card view |
| `retireCard()` | No Rain request | Disables local authority and records `state: "expiry_scheduled"`; the remote sandbox card remains bounded by its original expiry |

The sandbox API used by this project exposes no card cancel/freeze endpoint. Mission completion therefore does not claim that the remote card was cancelled. Reset and destructive startup replacement are blocked while a recorded Rain sandbox card is unexpired and either `active` or `expiry_scheduled`; local use is disabled at completion, but the recorded remote expiry is still allowed to finish the card's lifetime.

### Enforcement boundary

Rain receives the amount ceiling, expiry, and allowed MCCs when the card is created. The application additionally enforces:

- exact accepted-quote amount;
- merchant ID;
- one-transaction count;
- mission/task purpose;
- quote identity and expiry;
- total mission budget and approval policy.

A wrong merchant is normally rejected locally without a Rain authorization call. The demo can deliberately send a wrong-MCC transaction to the sandbox to prove the remote control; if Rain unexpectedly authorizes that negative control, the adapter immediately calls the reversal simulation and reports the mismatch.

### Security and data handling

- API credentials stay server-side.
- Configuration requires HTTPS, relative request paths, and valid UUIDs for the Rain user, optional team, and funding contract.
- Redirects are handled manually, limited to three, and blocked when they leave the configured origin.
- Requests use `AbortController`; network errors, HTTP `429`, and `5xx` responses receive at most two bounded retries by default.
- Idempotency keys commit to operation-specific stable inputs such as contract and amount, mission and quote, or transaction and settlement amount.
- The scoped-card session secret is randomly generated, encrypted with the pinned sandbox public key, and zeroed after construction.
- Rain responses may contain `encryptedPan` and `encryptedCvc`. The adapter intentionally never copies, returns, caches, logs, persists, broadcasts, or sends those fields to the browser. Only card ID, last four, status, and policy metadata are retained.
- There is no webhook endpoint, signature verification, reconciliation worker, refund workflow, or production card lifecycle in this repository.

## Merchant bargaining and binding quotes

Yes, the application bargains with a merchant, but it does so locally. Rain does not negotiate, and x402 discovery does not negotiate. The sequence is:

1. The local x402 adapter returns availability intelligence that recommends Atlas Archive Node.
2. `LocalNegotiationAdapter.getOffers()` opens an idempotent session for that mission and content root.
3. Atlas starts at $12.00. The buyer first offers $9.00; the deterministic seller counters at $10.50.
4. The buyer's second offer is $9.75, Atlas's configured floor, so the seller returns a binding quote.
5. The quote is reloaded and validated fail-closed before card creation, and validated again immediately before payment.
6. The accepted quote scopes the Rain card and purchase. Once settlement succeeds, negotiation becomes `consumed`.

The local merchant accepts only one-time `archival_egress` with `autoRenewal`, `dataSharing`, and `exclusivity` all false. The default policy allows at most three rounds. The accepted $9.75 quote is valid for 15 minutes and records $2.25 / 18.75% savings from the initial ask.

### Negotiation adapter contract

The replaceable adapter surface is:

```text
getOffers({ missionId, contentRoot, providerId, requirements, idempotencyKey })
sendCounterOffer({ sessionId, offerId, amountMinor, terms, idempotencyKey })
getBindingQuote({ sessionId, quoteId })
getSession(sessionId)
```

A binding quote contains these committed fields:

```text
quoteId, sessionId,
merchantId, merchantName, providerId, mcc,
contentRoot, purpose,
amountMinor, currency, terms,
binding, issuedAt, expiresAt
```

`quoteDigest` is SHA-256 over canonical JSON containing exactly those fields. It detects local mutation and key-order differences; it is not a merchant digital signature or proof that a remote merchant made the offer.

`evaluateQuote()` rejects a non-binding, expired, malformed, tampered, wrong-session, wrong-merchant, wrong-MCC, wrong-resource, wrong-purpose, wrong-currency, over-ceiling, over-budget, over-round, or out-of-terms quote. It can also require human approval above the configured threshold. A valid quote must still pass the separate payment-policy evaluation before a card is created and before a transaction is attempted.

A future merchant adapter should preserve this surface and return a merchant-authenticated quote with the same binding fields. Rain should remain downstream: negotiate first, validate the quote, then create the narrowly scoped payment credential.

## Monad: local ledger versus network readiness

Monad testnet uses chain ID `10143`; see the official [Monad testnet network information](https://docs.monad.xyz/developer-essentials/testnet) and [JSON-RPC reference](https://docs.monad.xyz/reference/json-rpc/api).

### Local execution ledger

`src/services/monad-local.js` owns the execution used by every application mode. It keeps an in-memory bounty map and returns deterministic synthetic receipts for:

```text
createBounty
claimBounty
recordAttestations
releaseTranche
```

Those receipts contain chain ID `10143`, local block numbers, synthetic transaction hashes, and `confirmed: true`, but no RPC call or onchain transaction occurred. The ledger releases cumulative 70%, 90%, and 100% targets as three local steps.

### Read-only network probe

`src/services/monad-network.js` is deliberately separate from execution. When both origins are configured, it:

- requires origin-only HTTPS URLs with no credentials, path, query, or fragment;
- POSTs JSON-RPC `eth_chainId` and requires exactly `10143`;
- GETs facilitator `/supported` and requires a `kinds` entry for x402 v2, `exact` or `v2-eip155-exact`, and `eip155:10143`;
- uses bounded timeouts and 64 KiB response limits;
- permits at most three same-origin redirects and rejects unsafe POST redirect status codes;
- returns only public origins, fixed network identifiers, check status, sanitized error codes, and a timestamp.

It never loads a private key, signs data, calls a contract, submits a transaction, calls `/verify` or `/settle`, or returns upstream response bodies.

### The Solidity lifecycle is not the local adapter lifecycle

`contracts/RecoveryBountyRegistry.sol` is a reference contract. It is not compiled, deployed, configured, or called by the running application. A live adapter cannot simply send transactions using the local method names because the contract surface and state machine differ:

| Local demo step | Actual reference-contract path |
| --- | --- |
| `createBounty()` | `createMission(params)` after the sponsor approves the reward ERC-20; the contract pulls the exact reward with `transferFrom` |
| `claimBounty()` | `claimMission(missionId)` with the provider sending the exact required native collateral as `msg.value` |
| `recordAttestations()` | Provider first calls `beginVerification(missionId, challengeDigest)`, then authorized verifiers submit EIP-712 signatures through `submitAttestations()` |
| `releaseTranche(..., 70)` | No public release function exists. Recovery quorum automatically releases 70% and moves `Verifying -> Recovered` |
| `releaseTranche(..., 90)` | A mission party calls `beginRetention()`, then availability quorum is collected for required epochs; the last required epoch automatically releases 20% |
| `releaseTranche(..., 100)` | Replication quorum after retention automatically releases the remaining 10%, marks the mission complete, and credits native collateral back to the provider |
| Local collateral return | Contract collateral is pull-based; the credited recipient calls `withdrawNativeCurrency()` |

The contract also implements deadlines, cancellation of unclaimed missions, expiration, disputes, verifier nonces, replay protection, pause controls, and owner arbitration. A true Monad adapter must model `Open -> Claimed -> Verifying -> Recovered -> Retaining -> Completed` and the `Expired` / `Disputed` branches rather than treating the local cumulative percentage call as an onchain method.

## x402: local discovery versus live payment

`src/services/x402-local.js` simulates both sides of the discovery purchase. It returns a local HTTP `402` requirement with `scheme: "exact"`, network `eip155:10143`, asset label `USDC`, amount `1` minor unit, and the availability resource. Settlement then creates an idempotent in-memory receipt, a synthetic transaction hash, and the provider recommendation used by negotiation.

The local requirement is not a complete x402 v2 payment contract: it has no payer signature, onchain token address, pay-to address, authorization nonce/window, facilitator verification, or onchain settlement. `PAYMENT-REQUIRED` and the cached receipt are demo artifacts.

The read-only facilitator probe does only capability discovery. A successful `GET /supported` proves that the configured service advertises v2 exact support for `eip155:10143`; it does not prove that this application's asset, payer, payee, balance, signature, or payment will succeed.

For the live protocol, follow the official [Monad x402 guide](https://docs.monad.xyz/guides/x402), [x402 facilitator flow](https://docs.x402.org/core-concepts/facilitator), and [x402 v2 migration guide](https://docs.x402.org/guides/migration-v1-to-v2). The live flow must use x402 v2 CAIP-2 identifiers and the exact scheme, with explicit network, token contract, recipient, amount, and resource checks.

## What configuration is still missing for true Monad/x402 execution

Rain credentials and UUIDs do not supply the following Monad identities or authority:

- a validated Monad testnet RPC origin;
- a signing key or external custody/wallet integration for the sponsor/payer;
- a compiled, tested, deployed, and verified `RecoveryBountyRegistry` address plus ABI;
- the selected reward-token / USDC contract address on chain `10143`;
- the x402 `payTo` address that receives the availability payment;
- provider and authorized verifier addresses and signing flows;
- testnet MON for gas and provider collateral, plus testnet USDC for reward and x402 payments;
- a facilitator whose `/supported` response advertises x402 v2 exact on `eip155:10143`.

The current `MONAD_PRIVATE_KEY`, `MONAD_BOUNTY_CONTRACT`, and `MONAD_PAY_TO_ADDRESS` flags only expose whether text is present in the environment. They do not validate addresses, inspect bytecode, prove signer control, or enable execution.

Any credential that has appeared in chat, logs, screenshots, or committed files should be revoked and replaced before sandbox or testnet use.

## HTTP API routes

The server exposes these loopback-only application routes:

| Method | Route | Behavior |
| --- | --- | --- |
| `GET` | `/api/health` | Rain health plus read-only Monad/facilitator readiness and explicit execution modes |
| `GET` | `/api/state` | Complete public demo state |
| `GET` | `/api/events` | Server-sent state updates |
| `POST` | `/api/demo/reset` | Resets the current session; returns `409` while recorded Rain sandbox authority can still be live remotely |
| `POST` | `/api/missions` | Creates a verified fixture mission after rights, artifact metadata, and published budget/reward checks |
| `POST` | `/api/missions/:id/step` | Executes the next of nine deterministic mission steps |
| `POST` | `/api/missions/:id/run` | Runs all remaining steps with one in-process run lock |
| `GET` | `/api/missions/:id/negotiation` | Returns stored negotiation state |
| `POST` | `/api/missions/:id/negotiation` | Runs/replays bargaining after availability discovery; returns `409` if called too early |
| `POST` | `/api/missions/:id/blocked-purchase` | Exercises a denied local Rain policy purchase after card creation |
| `GET` | `/api/missions/:id/export` | Downloads the mission audit JSON |

The API does not expose direct Rain, Monad, contract, wallet, or facilitator proxy routes.

## Safe path to real testnet execution

1. **Rotate and isolate secrets.** Replace any exposed Rain key, store all new credentials in a secret manager or local untracked environment, use a dedicated low-value testnet signer, and keep signing server-side or in an approved custody service.
2. **Validate Rain sandbox independently.** Confirm every UUID and the account's base URL against Rain's access-controlled docs. Run health, collateral, scoped-card, authorization, settlement, deliberate decline, and expiry tests with non-production funds. Confirm with Rain whether a cancel/freeze API becomes available before representing retirement as immediate.
3. **Make the reference contract deployable.** Add a Solidity toolchain, compile and test every state transition, fuzz deadlines and accounting, audit verifier/replay/dispute behavior, choose the reward token and verifier set, then deploy and verify the contract on Monad testnet.
4. **Implement a separate live Monad adapter.** Map the real contract lifecycle above, check chain ID before every write, simulate each call, use explicit nonces and bounded fee policy, wait for confirmed receipts, reconcile timeouts by transaction hash/nonce, and handle replacement and reorg cases. Never reuse a probe result as transaction authorization.
5. **Implement x402 v2 exact end to end.** Use the current `@x402/core`, `@x402/evm`, and HTTP integration packages recommended by Monad. Bind every requirement to `eip155:10143`, an allowlisted token contract, the configured payee, a maximum amount, the expected resource, and an authorization window. Call facilitator `/verify` and `/settle`, validate the settlement response, and make resource delivery idempotent.
6. **Keep negotiation ahead of payment.** Replace the local negotiation adapter only when a merchant API can return authenticated, expiring quotes. Continue to validate the quote twice and derive the one-use Rain policy from the accepted quote; never let merchant content choose a wallet, chain, token, or unlimited amount.
7. **Add explicit execution modes.** Introduce a distinct testnet mode instead of changing the meaning of `local` or `rain-sandbox`. Startup must fail closed unless the signer, bytecode, token, payee, facilitator capability, and Rain health all match the selected mode. Surface each execution adapter separately in health.
8. **Test failure paths before funds.** Run recorded Rain contract tests, a local Monad node or fork, live testnet smoke tests, duplicate/idempotency tests, webhook replay tests if webhooks are added, facilitator timeout cases, expired quotes, transaction replacement/reorgs, contract disputes, and card expiry. Only then consider a tightly capped production pilot.
