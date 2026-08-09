# Actors, Merchants, and Live Integration

This document answers two questions precisely:

1. Who are the merchants and agents shown by Lazarus Mesh?
2. What must exist before the buyer can communicate with real merchant agents?

## Current deployed reality

The public Vercel application is a durable **local simulation** backed by Neon. The browser and database are real infrastructure; the marketplace counterparties, payment execution, chain writes, recovery network, verifier network, and replica count are simulated.

| Displayed actor | Runtime identity | What it really is | External connection |
| --- | --- | --- | --- |
| Lazarus buyer policy | `lazarus_buyer_policy` | Deterministic recovery and bargaining workflow | None |
| Atlas Archive Cloud | `merchant_atlas_archive` | Simulated seller with a `$12.00` ask and `$9.75` floor | None |
| Atlas Archive Node | `provider_atlas_archive` | Simulated provider backed by the bundled CC0 fixture | None |
| North / East / West Verifier | local verifier IDs | Scripted quorum roles | None |
| Lazarus Demo Sponsor | `principal_lazarus_demo` | Simulated mission principal | None |
| Rain | payment rail adapter | Local policy simulation or optional external Rain sandbox simulation | Not a merchant |
| Monad | coordination/payment-chain adapter | Local bounty ledger; an opt-in Node runtime can settle only x402 discovery on Monad testnet | Not an agent |
| x402 | machine-payment protocol adapter | Local 402 handshake or an opt-in, capped test-USDC discovery payment to a configured x402 seller | Not a merchant |

`Unrelated Luxury Market` and `Unapproved Merchant` are negative-control fixtures used only to prove that policy blocks an out-of-scope purchase.

## What communicates today

The public Vercel runtime is local-only:

```text
Browser
  -> same-origin Lazarus API
      -> local x402 handshake
      -> local Atlas offer/counter/quote model
      -> local Rain card-policy simulation
      -> local Monad bounty ledger
      -> bundled CC0 fixture bytes
      -> scripted local verifier roles
  -> Neon Postgres for durable demo state
```

An access-controlled Node runtime may independently set `MONAD_EXECUTION_MODE=x402-testnet`. That adds one external path:

```text
Lazarus x402 buyer
  -> configured HTTPS x402 availability seller
  -> seller/facilitator submits settlement
  -> Monad testnet test-USDC transfer and confirmed receipt
```

The payer signs an EIP-3009 `TransferWithAuthorization` and does not submit the transaction, so the buyer flow is gasless. The facilitator or other chain submitter needs MON for gas; Lazarus does not inspect or quantify that submitter's MON balance. The payer still needs enough of the pinned Monad testnet USDC.

Enabling this path does not add merchant chat, LLM negotiation, A2A, merchant website automation, provider download, independent verifier requests, or seeding-network requests. Bargaining, the bounty registry and releases, the provider, verifier quorum, fixture recovery, and replica count remain local.

## What Rain, x402, and A2A each do

- **Rain** can provide controlled virtual-card infrastructure. It does not search for sellers, bargain, or operate every merchant checkout. A card may work at a compatible conventional card merchant, but login, inventory, regional eligibility, 3DS/OTP, CAPTCHA, fraud checks, shipping, refunds, and merchant terms still apply. See [Rain scoped cards](https://www.rain.xyz/solutions/scoped-cards) and [Rain card issuing](https://www.rain.xyz/product/card-issuing).
- **x402** carries machine-readable payment requirements and payment proof for a service that explicitly implements x402. It is a payment protocol, not a bargaining protocol. See the [x402 payment flow](https://docs.cdp.coinbase.com/x402/how-it-works).
- **A2A** lets compatible remote agents advertise identity, capabilities, endpoint, and authentication through Agent Cards. It cannot convert an arbitrary shop into an agent. See [A2A 1.0](https://a2a-protocol.org/v1.0.0/).

## Execution and currency boundary

`ADAPTER_MODE` controls Rain, while `MONAD_EXECUTION_MODE` independently controls x402. The public Vercel deployment permits only local execution; Rain sandbox and Monad x402 testnet require an explicitly configured Node runtime.

Mission accounting supports USD, EUR, GBP, CAD, and AUD using fixed demo reference values rather than live exchange rates. Local Rain supports all five for simulation, but Rain sandbox missions must use USD. The Monad x402 rail always settles in the pinned test-USDC asset; selecting another accounting currency does not create an EUR-, GBP-, CAD-, or AUD-denominated token payment.

## Safe live architecture

```text
Authorized recovery request
  -> buyer orchestrator
  -> curated merchant registry
  -> merchant A2A or merchant-specific quote connector
  -> deterministic quote policy
  -> optional human approval
  -> Rain scoped card OR exact x402 payment on Monad
  -> provider fulfillment
  -> independent verification
  -> durable receipt, reconciliation, and refund state
```

Real bargaining must be a merchant-supported structured capability such as:

- `request_quote`
- `counter_offer`
- `accept_quote`
- `cancel_quote`

The binding response must commit to merchant identity, endpoint/payee, content root or SKU, purpose, price, currency, terms, expiry, nonce, session, and idempotency key. It must be authenticated or signed by the merchant. Free-form model output must never authorize payment.

## What is required from external agents

To connect the user's own agents, provide:

1. Merchant-agent HTTPS or A2A endpoint.
2. Authentication method and merchant signing/public key.
3. Agent Card or request/response schema for offers, counters, acceptance, cancellation, and errors.
4. Provider-agent endpoint for the manifest and authenticated piece streaming.
5. At least two independent verifier-agent endpoints and signing keys.
6. Merchant identity, payee, MCC where applicable, fulfillment rules, refund policy, and supported currencies.

The production adapter must use HTTPS allowlists, bounded timeouts and response sizes, durable idempotency, replay protection, quote-signature verification, and a persisted operation journal. If an external actor fails, the app must show the failure and stop; it must never silently substitute simulated success.

The current runtime enforces that boundary: merely setting a connector to `liveMerchantApi` is insufficient. The connector and returned quote must both report verified merchant authentication and a verified signature before the quote can be accepted. Otherwise the mission stops with `MERCHANT_QUOTE_UNTRUSTED` before any card or payment step.

## Opt-in testnet boundary

The repository includes an opt-in buyer path for a real test network with payment bounded to test assets. It requires:

- a server-side managed EVM test signer;
- sufficient pinned test USDC in the payer wallet;
- MON gas held by the facilitator or other account that submits settlement, not necessarily by the EIP-3009 payer;
- one genuine x402-enabled test seller that serves the authorized fixture;
- payment caps, an allowlisted payee, durable payment-identifier deduplication, a kill switch, and receipt reconciliation.

Lazarus does not check or estimate the submitter's MON requirement. Monad documents the x402 testnet flow at [Monad x402](https://docs.monad.xyz/guides/x402). Core x402 bargaining is still out of scope; merchant negotiation remains a separate, currently local capability.

## Production-money boundary

Do not enable real funds in the public demo. Rain production requires commercial and compliance onboarding, production credentials, verified users/businesses, funding, webhooks, secure card-detail injection, and controlled launch approval. Existing sandbox identifiers do not provide production authority. See [Rain's launch process](https://www.rain.xyz/resources/launch-a-card-program-with-rain).

Monad mainnet additionally requires production key custody, real assets, explicit permission to move funds, strict budgets, allowlisted payees, a kill switch, and reconciliation. Unknown merchants must stop at preview or human approval rather than receiving autonomous payment.
