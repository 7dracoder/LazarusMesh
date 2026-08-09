# Hackathon Acceptance and Currency Model

Updated: 2026-08-08

This is the canonical truth table for Lazarus Mesh's hackathon demo. It explains what the multi-currency selector means, which rails can move sandbox or testnet value, and which parts still run as local deterministic models.

Never put API keys, private keys, wallet seed phrases, Rain identifiers, card data, or other credential values in this file. Use environment-variable names only. Rotate any credential that has appeared in chat, screenshots, logs, or a commit before using it again.

## One-sentence boundary

Lazarus Mesh supports selectable mission accounting in `USD`, `EUR`, `GBP`, `CAD`, and `AUD`; Rain's hackathon sandbox authorizes only USD against sandbox rUSD collateral; opt-in Monad x402 pays the official Monad test-USDC token, while the submitting seller/facilitator uses MON for gas; the bounty registry remains local.

Multi-currency accounting does **not** mean that every external payment rail natively accepts every selected currency.

## Three different kinds of value

| Layer | Values used | What it means |
| --- | --- | --- |
| Mission accounting | `USD`, `EUR`, `GBP`, `CAD`, `AUD` | User-selected display, budget, reward, bargaining, savings, and policy amounts. All are integer minor units. |
| External settlement | Rain: USD-denominated sandbox authorization; Monad x402: test USDC | The value format accepted by a particular external rail. It is separate from the selected mission currency. |
| Chain gas/collateral | MON | Native Monad testnet asset used for transaction gas. The reference bounty contract also models native provider collateral, but that contract is not deployed or called by the app. |

`USDC`, `MON`, BTC, and other tokens are not selectable mission-accounting currencies. The official test-USDC contract and Monad testnet network are pinned by the x402 adapter rather than chosen by merchant or browser input.

## Selectable accounting currencies

The rate set is `lazarus-demo-reference-v1`. It is deterministic demo data, not live foreign exchange, a price quote, or a conversion service.

| Mission currency | Minor units per reference USD | Example reference relationship |
| --- | ---: | --- |
| USD | 100 | USD 1.00 |
| EUR | 92 | EUR 0.92 |
| GBP | 78 | GBP 0.78 |
| CAD | 137 | CAD 1.37 |
| AUD | 152 | AUD 1.52 |

Every supported currency has two decimal places. The server publishes the currency catalog, rate-set identifier, adapter support, and currency-specific mission limits under `system.missionCreation` in `GET /api/state`.

Conversions use integer arithmetic. Debits and required reserves round conservatively upward so a conversion cannot weaken a spending ceiling; maximum allowed values round downward. This keeps each selected mission's quote, budget, savings, bounty, and spend accounting internally consistent.

The default USD story remains the easiest presentation example: a USD 12.00 initial ask is bargained to USD 9.75, with USD 0.01 of discovery accounting and USD 2.25 of negotiated savings. Other selected currencies show deterministic reference equivalents rather than a live FX conversion.

## Rail and deployment matrix

`ADAPTER_MODE` and `MONAD_EXECUTION_MODE` are independent. The first selects the Rain adapter; the second selects the availability-payment adapter.

| Runtime selection | Rain behavior | x402 behavior | Monad bounty behavior | Currency boundary |
| --- | --- | --- | --- | --- |
| `ADAPTER_MODE=local`, `MONAD_EXECUTION_MODE=local` | Local scoped-card simulation | x402-shaped local 402/receipt simulation | Local deterministic ledger | Missions may use USD/EUR/GBP/CAD/AUD; no value moves. |
| `ADAPTER_MODE=rain-sandbox`, `MONAD_EXECUTION_MODE=local` | Authenticated Rain sandbox calls | x402-shaped local simulation | Local deterministic ledger | Mission currency must be USD; collateral setup uses sandbox `rUSD`. |
| `ADAPTER_MODE=local`, `MONAD_EXECUTION_MODE=x402-testnet` | Local scoped-card simulation | Real bounded x402 v2 test-USDC payment on Monad testnet | Local deterministic ledger | Mission may use any supported accounting currency; discovery settles test USDC, buyer signing is gasless, and the submitter pays MON gas. |
| `ADAPTER_MODE=rain-sandbox`, `MONAD_EXECUTION_MODE=x402-testnet` | Authenticated Rain sandbox calls | Real bounded x402 v2 test-USDC payment on Monad testnet | Local deterministic ledger | Mission must be USD because of Rain; x402 still settles test USDC. Use only in an access-controlled local runtime. |
| Public Vercel deployment | Local only | Local only | Local only | Multi-currency demo accounting is available, but Vercel rejects both external modes. |

The public Vercel deployment deliberately rejects `ADAPTER_MODE` values other than `local` and `MONAD_EXECUTION_MODE` values other than `local`. Its Neon snapshot is suitable for deterministic demo state, not durable reconciliation of external financial operations.

## What “x402” means in each mode

### Local mode

`LocalX402Adapter` is an **x402-shaped simulation**. It returns a local HTTP-402-style requirement and a deterministic receipt, then records a synthetic test-USDC reference for accounting. It does not produce a valid x402 v2 authorization, call a seller or facilitator, move a token, pay gas, or create an explorer transaction. Its transaction hash is synthetic.

### Opt-in Monad testnet mode

`MONAD_EXECUTION_MODE=x402-testnet` swaps only availability discovery to `MonadX402Adapter`. It performs the buyer side of a real x402 v2 exact payment against an HTTPS seller endpoint, signs a bounded EIP-3009 test-USDC authorization, checks the returned settlement response, waits for configured confirmations, and independently verifies the exact USDC `Transfer` log on Monad testnet.

The adapter pins:

- network `eip155:10143`;
- Monad testnet chain ID `10143`;
- official Monad test USDC, with six decimals;
- the expected provider identity;
- the expected price and maximum price;
- the expected payee and availability resource;
- a short authorization window; and
- the required x402 payment-identifier extension.

The default availability price is `10000` USDC atomic units, or test USDC 0.01. Test USDC can move in this mode. It is not real-money production settlement, but it is a real testnet chain write.

The x402 seller/facilitator—not this buyer adapter—performs facilitator verification and settlement. `X402_FACILITATOR_URL` is also used by the separate readiness probe; the buyer sends its paid request to `X402_AVAILABILITY_BASE_URL`.

## Requirements for a live x402 demo

Use a dedicated, low-value testnet payer. The following are mandatory before selecting `x402-testnet`:

1. A credential-free HTTPS Monad RPC URL in `MONAD_RPC_URL`.
2. An access-controlled server-side payer key in `MONAD_PRIVATE_KEY`.
3. Enough official Monad test USDC to cover the capped availability payment.
4. A seller/facilitator settlement submitter able to fund testnet MON gas. The payer's EIP-3009 authorization is gasless, so do not require MON in the payer wallet unless the chosen service explicitly does. Lazarus does not inspect or quantify the submitter's MON balance.
5. A distinct seller wallet in `MONAD_PAY_TO_ADDRESS`. Payer and payee must not be the same address.
6. A credential-free HTTPS x402 seller base URL in `X402_AVAILABILITY_BASE_URL`. It must expose the expected availability resource, return an x402 v2 exact requirement, enforce payment identifiers, settle through a compatible facilitator, and return verifiable settlement evidence.
7. Durable uniqueness for every payment identifier and durable storage for paid results. The seller must return the already-settled result for an exact duplicate instead of charging twice.
8. The implemented durable pending-payment gate must succeed before signing/transmission. It blocks reset, fresh startup, and another authorization until an ambiguous outcome is reconciled by payment identifier and transaction evidence.

The optional guardrail variables are documented in [API and Testnet Integration Guide](API_INTEGRATION.md). Do not place live keys in Vercel for this release.

## Rain currency boundary

`ADAPTER_MODE=rain-sandbox` is a remote **sandbox** simulation, not a production card program. The adapter creates a scoped card and submits USD-denominated sandbox authorization/settlement calls. The sandbox collateral setup request uses `currency: "rusd"`; rUSD funding is rail setup and is not the mission's spend or remaining balance.

The mission API therefore rejects EUR, GBP, CAD, and AUD when Rain sandbox execution is active. To demonstrate those accounting currencies, use the local Rain adapter. Supporting them on a live card rail would require a provider-supported multi-currency issuing/settlement contract and explicit FX, fee, disclosure, reconciliation, and refund rules.

### Mapping to the Rain workshop guidance

The supplied Rain slide points builders to the hackathon sandbox documentation and the `api-dev.raincards.xyz/v1` sandbox origin, and says to use sandbox keys only. This repository follows that boundary:

- `RAIN_API_BASE_URL` targets the sandbox, never a production endpoint by default;
- all tenant-specific API/UUID values stay in server-side environment variables;
- scoped-card creation requests the accepted USD quote, MCC allowlist, and short expiry; Rain may apply its sandbox authorization buffer, while Lazarus policy still permits only the exact accepted quote;
- sandbox rUSD setup is labeled collateral provisioning rather than mission spend;
- authorization, settlement, deliberate decline/reversal, and safe card lookup are truth-labeled simulations; and
- provider errors are sanitized, while request IDs/timestamps can be retained for discussion with the Rain team without exposing secrets or card data.

The workshop sandbox is evidence of a real Rain API integration, not evidence of real fiat movement or a production wallet balance. See the [Rain sandbox documentation](https://rain-sandbox-trial.mintlify.site/) for the provider's current hackathon contract.

## Monad bounty boundary

The full recovery bounty remains `LocalMonadAdapter` in every current run mode, including `x402-testnet`. Bounty creation, provider claim/collateral, verifier attestations, and 70/90/100 percent releases are deterministic local ledger transitions. Their transaction hashes are synthetic.

`contracts/RecoveryBountyRegistry.sol` is a reference contract only. It is not compiled by the app, deployed, configured, called, audited, or represented as a live Monad bounty. `MONAD_BOUNTY_CONTRACT` is readiness metadata and does not activate a writer.

## Mapping to the Monad hackathon criteria

The supplied Monad slide asks for real transactions, a chain-dependent idea, agent autonomy with guardrails, and an onchain-native concept. The honest acceptance mapping is:

| Criterion | What the repository can demonstrate | Remaining caveat |
| --- | --- | --- |
| Real transactions on Monad | Opt-in x402 testnet mode can produce a real test-USDC transaction and verified explorer receipt. | Default/local/Vercel runs do not. The full bounty is still local. |
| The chain has to matter | Paid discovery can gate access to the provider recommendation and bind the result to a confirmed test-USDC transfer. | Local mode bypasses chain dependence by design; a fully chain-dependent recovery market still needs the bounty contract. |
| Agent autonomy with guardrails | The orchestrator may discover and bargain, while deterministic policy caps resource, network, token, payee, amount, expiry, duplicate identity, merchant, MCC, purpose, budget, and transaction count. | Merchant bargaining and verifier decisions are scripted local models. |
| “Weird beats polished” | Paid availability intelligence, policy-bounded bargaining, proof-based release, and reconstruction of a zero-replica CC0 artifact form an onchain-native recovery-market story. | Do not overstate simulated reseeding, provider networking, or registry settlement. |

## Demo acceptance checklist

### Safe public demo

- Run Vercel with both modes set to `local` or unset.
- Create missions in USD, EUR, GBP, CAD, and AUD and confirm that all amounts use the selected symbol/code.
- Show the fixed-reference-rate disclaimer.
- Explain that all payments and bounty receipts in this deployment are simulations.
- Show bargaining, the denied unrelated purchase, verified reconstruction, verifier quorum, and local tranche releases.

### Capped local integration demo

- Rotate every previously exposed credential.
- Start from a clean, access-controlled local runtime.
- Use USD if Rain sandbox is enabled.
- Fund the dedicated x402 payer with only the required test USDC; confirm the settlement submitter can fund MON gas.
- Use a separate payee wallet and an HTTPS seller endpoint with durable payment-ID uniqueness.
- Confirm health reports the chosen adapters truthfully.
- Run one mission and retain the x402 payment identifier, settlement response, confirmed transaction hash, and explorer link.
- State explicitly that the bounty registry, merchant, provider recovery, verifier network, and reseeding are still local.

## What this release does not claim

- It does not provide live foreign-exchange rates or convert fiat/token balances.
- It does not let merchant input choose the chain, token, recipient, or payment amount.
- It does not make Rain a wallet, merchant, or bargaining agent.
- It does not run a production card purchase or move real fiat.
- It does not deploy or call the full Monad bounty registry.
- It does not connect to a live merchant, provider network, independent verifier network, BitTorrent/IPFS retrieval network, or persistent seeding service.
- It does not make the public Vercel deployment suitable for private keys or external financial operations.

For exact environment variables and adapter behavior, see [API and Testnet Integration Guide](API_INTEGRATION.md). For operational blockers, see [Production Readiness](PRODUCTION_READINESS.md).
