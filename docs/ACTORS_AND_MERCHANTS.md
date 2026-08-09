# Actors, Merchants, and Live Integration

This document answers two questions precisely:

1. Who are the merchants, agents, and wallets shown by Lazarus Mesh?
2. Which of them communicate or move testnet value in each deployment?

## Current deployed reality

Lazarus Mesh has three deliberately different surfaces:

| Surface | Buyer behavior | Seller behavior | Financial boundary |
| --- | --- | --- | --- |
| Public production | Local x402-shaped simulation | Disabled | Entirely local-only: no payer signer, paid seller route, facilitator settlement, or chain write. |
| Protected branch preview | One fixed mission may use the Privy payer server wallet once | Durable x402 seller is enabled behind the same deployment protection | One capped test-USDC discovery payment; reset and arbitrary mission creation are disabled. |
| Local Node runtime | Local by default; optional raw-key or Privy testnet buyer | Seller is optional | Developer-controlled integration surface; never expose it directly to the internet. |

Neon and Vercel are real infrastructure. Only the protected preview's x402 buyer/seller/facilitator path can be a real Monad testnet action. Merchant bargaining, the archive purchase, the recovery bounty, provider fulfillment, verifier independence, and reseeding are still deterministic local models.

| Displayed actor | Runtime identity | What it really is | External connection |
| --- | --- | --- | --- |
| Lazarus buyer policy | Buyer orchestrator | Deterministic recovery and bargaining workflow | Calls only configured adapters; it is not an LLM chat agent. |
| Atlas Archive Cloud | Archive merchant | Simulated seller with a reference ask and floor | No merchant API, checkout, or human merchant is contacted. |
| Atlas Archive Node | Recovery provider | Simulated provider backed by the bundled CC0 fixture | No provider network is contacted. |
| North / East / West Verifier | Verification quorum | Scripted local roles | No independent verifier service is contacted. |
| Privy payer server wallet | x402 payer | Dedicated low-value EVM signer held behind Privy's server API | Used only by the armed, protected preview or an access-controlled local run. |
| Receive-only payee | x402 recipient | Distinct public EVM address | Receives test USDC; Lazarus does not need or store its private key to receive. |
| Lazarus x402 availability seller | Paid API resource | Protected-preview `GET /api/x402/availability/:contentRoot` endpoint | Issues 402 requirements, uses the facilitator, and persists payment-ID outcomes in Neon. It is disabled in production. |
| Rain | Card-control rail | Local policy simulation or optional Rain sandbox adapter | Not a merchant, agent, or Monad wallet. |
| Monad | Chain | Testnet settlement/receipt verification plus a still-local bounty model | Not a merchant or bargaining agent. |
| x402 | Payment protocol | Payment requirements, authorization, settlement evidence, and replay identity | Not a bargaining protocol. |

Negative-control merchant names in the UI exist only to demonstrate policy denial.

## What communicates today

Public production is fully local-only:

```text
Browser -> Lazarus mission API -> local x402 simulation
```

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

This path does not add merchant chat, A2A negotiation, website automation, archive checkout, provider download, independent verification, or seeding. Atlas bargaining and the `$9.75` reference archive allocation remain local even when the one-cent-reference x402 discovery payment settles onchain.

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

Mission accounting supports USD, EUR, GBP, CAD, and AUD using fixed demo references, not live exchange rates. These values control display, budgets, bargaining, savings, and local reward accounting.

Settlement is separate:

- local adapters move no value;
- Rain sandbox, once correctly configured, accepts USD mission accounting and uses sandbox rUSD collateral;
- Monad x402 always settles the pinned test-USDC asset; and
- MON is gas for the settlement submitter, not a selectable mission currency.

Selecting EUR, GBP, CAD, or AUD does not create a token or card payment in that currency.

## What real bargaining would require

The current bargaining transcript is an in-process deterministic state machine. A real merchant integration needs authenticated structured operations such as `request_quote`, `counter_offer`, `accept_quote`, and `cancel_quote`.

The merchant's binding response must commit to merchant identity, endpoint/payee, content root or SKU, purpose, price, currency, terms, expiry, nonce, session, and idempotency key. It must be authenticated or signed by the merchant. Free-form model output must never directly authorize payment.

To connect external agents, provide:

1. merchant-agent HTTPS or A2A endpoint and authentication method;
2. merchant signing/public key and quote schema;
3. provider endpoint for signed manifests and authenticated piece streaming;
4. at least two independent verifier endpoints and signing keys; and
5. fulfillment, refund, supported-currency, payee, and MCC rules.

The live adapter must add HTTPS allowlists, bounded timeouts and bodies, durable idempotency, replay protection, signature verification, and an operation journal. Failure must stop the mission; it must never silently substitute a simulated success.

## Production-money boundary

Do not treat test USDC, sandbox rUSD, or synthetic mission accounting as production money. Mainnet and production-card operation still require managed custody, user/tenant authorization, rate limits and quotas, production onboarding, signed webhooks, reconciliation, refunds/disputes, incident controls, compliance review, and explicit permission to move funds.
