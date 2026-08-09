# Actors, Merchants, and Live Integration

This document answers two questions precisely:

1. Who are the merchants, agents, and wallets shown by Lazarus Mesh?
2. Which of them communicate or move testnet value in each deployment?

## Current deployed reality

Lazarus Mesh has three deliberately different surfaces:

| Surface | Buyer behavior | Seller behavior | Financial boundary |
| --- | --- | --- | --- |
| Public production | Local x402-shaped simulation plus optional authenticated merchant calls | Remote merchant/provider at `https://lazarus-merchant.vercel.app` or local Atlas fallback | Merchant HTTPS traffic may be real; payment, bounty, verifier, reseeding, and chain execution remain local with `$0.00` charged. |
| Protected branch preview | One fixed mission may use the Privy payer server wallet once | Durable x402 seller is enabled behind the same deployment protection | One capped test-USDC discovery payment; reset and arbitrary mission creation are disabled. |
| Local Node runtime | Local by default; optional raw-key or Privy testnet buyer | Seller is optional | Developer-controlled integration surface; never expose it directly to the internet. |

Neon and Vercel are real infrastructure. Remote merchant bargaining, quote signing, manifest retrieval, and provider piece delivery are real HTTPS operations. Only the separate protected preview's x402 buyer/seller/facilitator path can be a Monad testnet action, and that safety profile uses the pinned local fixture rather than remote merchant mode. The archive spend, recovery bounty, verifier independence, and reseeding remain local models in the remote-merchant deployment.

| Displayed actor | Runtime identity | What it really is | External connection |
| --- | --- | --- | --- |
| Lazarus buyer policy | Buyer orchestrator | Deterministic recovery and bargaining workflow | Calls only configured adapters; it is not an LLM chat agent. |
| Lazarus Recovery Merchant | Remote archive merchant | Independently deployed structured merchant API with an operator-configured ask/floor | Authenticated HTTPS sessions and Ed25519-signed binding quotes. |
| Lazarus Recovery Merchant provider | Remote recovery provider | Serves the eight-piece CC0 artifact described by the sponsor-pinned manifest | Authenticated HTTPS manifest and piece retrieval. It does not persist replicas after delivery. |
| Merchant operator console | Merchant-facing UI | Shows settings, sessions, counters, signed deals, and audit events | The offer carries proposed bounty context, but the service does not persist it; the console has no bounty, claim, wallet, or payout display. |
| Atlas Archive Cloud / Node | Local fallback merchant/provider | Simulated seller and bundled 24-piece fixture | Used only when `MERCHANT_MODE=local`. |
| North / East / West Verifier | Verification quorum | Scripted local roles | No independent verifier service is contacted. |
| Privy payer server wallet | x402 payer | Dedicated low-value EVM signer held behind Privy's server API | Used only by the armed, protected preview or an access-controlled local run. |
| Receive-only payee | x402 recipient | Distinct public EVM address | Receives test USDC; Lazarus does not need or store its private key to receive. |
| Lazarus x402 availability seller | Paid API resource | Protected-preview `GET /api/x402/availability/:contentRoot` endpoint | Issues 402 requirements, uses the facilitator, and persists payment-ID outcomes in Neon. It is disabled in production. |
| Rain | Card-control rail | Local policy simulation or optional Rain sandbox adapter | Not a merchant, agent, or Monad wallet. |
| Monad | Chain | Testnet settlement/receipt verification plus a still-local bounty model | Not a merchant or bargaining agent. |
| x402 | Payment protocol | Payment requirements, authorization, settlement evidence, and replay identity | Not a bargaining protocol. |

Negative-control merchant names in the UI exist only to demonstrate policy denial.

## What communicates today

The verified remote merchant/provider path is:

```text
Browser -> Lazarus mission API
  -> authenticated HTTPS offer/counter requests
  -> Lazarus Recovery Merchant
  -> Ed25519-signed $9.75 USD quote verified against a pinned key
  -> authenticated manifest/piece requests
  -> 8/8 piece hashes + reconstructed artifact/root verified
  -> local-only bounty, card allocation, verifier, and reseeding records
```

An end-to-end acceptance run completed that flow in two bargaining rounds. It charged `$0.00` and made no chain write. The sponsor pins the complete eight-piece manifest in Lazarus configuration; the provider's live manifest must exactly match before any piece is accepted. The merchant cannot redefine the trusted root at runtime.

The protected branch preview co-locates exactly one outgoing buyer path and its durable seller:

```text
Fixed bundled mission
  -> Lazarus x402 buyer
  -> Privy payer server wallet signs approved EIP-3009 typed data
  -> internal same-origin seller transport
  -> protected Lazarus x402 seller
  -> facilitator settlement on Monad testnet
  -> confirmed test-USDC Transfer to the distinct payee
```

The buyer uses the internal same-origin seller transport so it does not bypass or depend on calling the deployment through Vercel's external protection challenge. The HTTP seller route still exists for protocol inspection and protected clients, but it remains behind Vercel Deployment Protection and is disabled in public production.

The buyer authorization is gasless; the facilitator or other settlement submitter needs testnet MON for gas. The payer needs only the capped amount of the pinned Monad test USDC unless that facilitator explicitly requires otherwise.

The x402 Preview path does not add remote merchant bargaining, archive checkout, provider download, independent verification, or seeding. It remains separate from the remote merchant/provider profile. Conversely, the remote merchant profile performs real bargaining and provider download but does not move testnet value.

## Wallet security boundary

The payer and payee must be different wallets with different roles:

- The **payer** is a dedicated Privy server wallet funded only with the test USDC needed for the demo. Its app secret and wallet ID stay in branch-scoped server-side environment variables.
- The **payee** is receive-only from this application's perspective. The seller needs only its public address; no payee private key, seed phrase, or signing credential belongs in Vercel.
- Vercel refuses a raw `MONAD_PRIVATE_KEY` in live preview mode.
- A Privy wallet policy should restrict the payer to the intended typed-data method and testnet payment envelope.
- Lazarus independently validates the exact `TransferWithAuthorization` schema, USDC domain/version, Monad testnet chain, token contract, payer, payee, amount cap, nonce shape, and short validity window before requesting a Privy signature. It then verifies that Privy's returned signature recovers to the configured payer address.

Neither Vercel Deployment Protection nor a Privy policy replaces application policy. The preview requires all three layers: deployment authentication, the one-shot runtime gate, and restrictive signing policy.

## What Rain, x402, and A2A each do

- **Rain** provides controlled virtual-card infrastructure. It does not find sellers, bargain, or operate merchant checkout. Login, inventory, 3DS/OTP, CAPTCHA, fraud checks, refunds, and merchant terms remain separate concerns.
- **x402** carries machine-readable payment requirements and proof for an endpoint that explicitly implements it. It does not negotiate price or terms.
- **A2A** can let compatible remote agents advertise capabilities and communicate. It cannot turn an arbitrary merchant into an agent.

The Rain adapter is implemented, but the current deployment must keep `ADAPTER_MODE=local`: the previously supplied sandbox API credential must be rotated, and the supplied collateral/contract identifier is not a valid UUID. Do not guess or repair an identifier. Rain sandbox can be armed only after the operator supplies a newly rotated key and a valid provider-issued UUID through server-side secrets.

## Execution and currency boundary

Core local mission accounting supports USD, EUR, GBP, CAD, and AUD using fixed demo references, not live exchange rates. A remote merchant deployment accepts one configured accounting currency at a time. The current deployment is USD-only; changing currency requires coordinated configuration on both services.

Settlement is separate:

- local adapters move no value;
- Rain sandbox, once correctly configured, accepts USD mission accounting and uses sandbox rUSD collateral;
- Monad x402 always settles the pinned test-USDC asset; and
- MON is gas for the settlement submitter, not a selectable mission currency.

Selecting EUR, GBP, CAD, or AUD does not create a token or card payment in that currency.

## Remote bargaining contract

Remote mode now implements authenticated structured offer, counteroffer, session, quote, manifest, and piece operations. Lazarus pins the merchant's Ed25519 public-key fingerprint, recomputes the canonical quote digest, verifies the signature, and then applies its independent quote and payment policies.

The binding response commits to merchant/provider identity, MCC, content root, purpose, price, currency, terms, issue time, expiry, and session. The signature includes a unique nonce. Free-form transcript text remains presentation only and never authorizes payment.

Remote Lazarus configuration uses these environment-variable names, with values kept in encrypted server-side configuration:

```text
MERCHANT_MODE
MERCHANT_BASE_URL
MERCHANT_API_TOKEN
MERCHANT_EXPECTED_KEY_ID
MERCHANT_CURRENCY
MERCHANT_TRUSTED_MANIFEST_JSON
MERCHANT_TIMEOUT_MS
MERCHANT_RESPONSE_LIMIT_BYTES
MERCHANT_MAXIMUM_PIECE_BYTES
MERCHANT_MAXIMUM_TOTAL_BYTES
```

The adapter enforces HTTPS except on loopback, bounded timeouts and bodies, exact identities/currency/root, a sponsor-pinned manifest, quote expiry, and signature verification. Failure stops the mission; it never silently substitutes a simulated success.

The merchant receives the `$5.00` proposed bounty only as non-settling context in the initial offer request; its current API does not persist or expose that field. The `$2.00` collateral reference, provider claim, 70/90/100 releases, and all associated receipts live only in Lazarus's local demo ledger. Adding a merchant bounty view requires an explicit authenticated, idempotent bounty-status API and a clear distinction between the `$9.75` archive sale and the provider reward.

## Production-money boundary

Do not treat test USDC, sandbox rUSD, or synthetic mission accounting as production money. Mainnet and production-card operation still require managed custody, user/tenant authorization, rate limits and quotas, production onboarding, signed webhooks, reconciliation, refunds/disputes, incident controls, compliance review, and explicit permission to move funds.
