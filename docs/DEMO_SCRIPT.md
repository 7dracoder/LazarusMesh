# Four-Minute Demo Script

## Before presenting

Choose one truthful run profile:

<<<<<<< Updated upstream
- **Remote merchant Production (recommended):** authenticated merchant bargaining and provider download; local Rain, local x402, local bounty, and no value or chain writes.
- **Local Production:** bundled 24-piece fixture and Atlas fallback; all operations local.
- **Protected branch Preview:** local Rain plus one Privy-backed test-USDC x402 discovery payment through the co-located durable seller. The full bounty and archive purchase remain local.
- **Local Rain sandbox:** do not present yet. The prior key must be rotated and the collateral/contract value replaced with a valid provider-issued UUID.
=======
- **Hybrid Production (recommended):** authenticated remote merchant bargaining and provider download plus armed Rain sandbox card operations; local x402 and local bounty; no real-money or chain movement.
- **Local Production:** bundled 24-piece fixture and Atlas fallback; all operations local.
- **Protected branch Preview:** local fixture, Rain sandbox archive allocation, and one real test-USDC x402 discovery payment through the co-located durable seller. The full bounty, verifier roles, and reseeding remain local.
>>>>>>> Stashed changes

For the protected Preview, verify before opening the app:

1. Vercel Deployment Protection is enabled.
2. Live variables exist only on the intended branch Preview.
3. Exactly one dedicated low-value signer is configured: a complete Privy setup (preferred) or one 32-byte raw key. The verified run used the raw-key fallback.
4. The receive-only payee is a different wallet; no payee secret is deployed.
5. Price/cap are fixed at test USDC 0.01, authorization is at most five minutes, and confirmations are at least six.
6. Seller and Neon settlement storage are enabled; the state key is unique and begins with `preview-`.
7. Reset and new-mission creation return the one-shot denial.

<<<<<<< Updated upstream
Before presenting the remote profile, open the [live Lazarus demo](https://lazarus-mesh-merchant-demo.vercel.app) and confirm that merchant health reports authenticated HTTPS, a pinned Ed25519 key, and a matching sponsor-pinned manifest. The separate [merchant operator console](https://lazarus-merchant.vercel.app) requires the private `OPERATOR_TOKEN` from that Vercel project's Production environment; never paste the server-to-server merchant API token into the browser. Core local accounting supports USD, EUR, GBP, CAD, and AUD through fixed demo references, not live FX. The deployed remote merchant accepts one configured currency at a time and is currently USD, so use USD for the timings below.
=======
Before presenting the hybrid profile, open the [live Lazarus demo](https://lazarus-mesh-merchant-demo.vercel.app) and confirm that merchant health reports authenticated HTTPS, a pinned Ed25519 key, and a matching sponsor-pinned manifest; Rain health must report the armed sandbox rather than local mode. The separate [merchant operator console](https://lazarus-merchant.vercel.app) requires the private `OPERATOR_TOKEN` from that Vercel project's Production environment; never paste the server-to-server merchant API token into the browser. Core local accounting supports USD, EUR, GBP, CAD, and AUD through fixed demo references, not live FX. The deployed remote merchant and Rain sandbox profile is USD, so use USD for the timings below.
>>>>>>> Stashed changes

## 0:00–0:25 — The problem

“This CC0 research dataset still has a valid cryptographic commitment but zero complete seeders. A content address proves identity; it does not guarantee availability.”

Show `DEAD`, zero seeders, and eight missing pieces in the remote profile (`24` in local mode).

## 0:25–0:50 — Mission and authority

Show the USD reference envelope:

- 20.00 service budget;
- 5.00 local recovery bounty;
- public-domain rights evidence;
- one approved archive merchant/MCC;
- 12.00 negotiation ceiling, 9.00 buyer target, and three-round maximum; and
- one-time archival egress with no renewal, sharing, or exclusivity.

Select **Run full recovery**. On the protected x402 Preview, use only the preloaded bundled mission. Do not combine that one-shot payment profile with remote merchant mode.

## 0:50–1:25 — Discovery and bargaining

<<<<<<< Updated upstream
In remote merchant Production, describe x402 as a local one-cent-reference simulation and say “no value moved.” Then open the separate merchant console and show that Lazarus created a real authenticated negotiation session.
=======
In hybrid Production, describe x402 as a local one-cent-reference simulation. Then open the separate merchant console and show that Lazarus created a real authenticated negotiation session.
>>>>>>> Stashed changes

In the protected Preview, show the real test-USDC `0.01` settlement, payment ID, confirmed transaction hash, and explorer evidence. The verified transaction is [`0x204f66f2cc3180e619babc9c341ddc71805ca8240a556d4665cf449bfb15300d`](https://testnet.monadscan.com/tx/0x204f66f2cc3180e619babc9c341ddc71805ca8240a556d4665cf449bfb15300d); independent RPC checks confirmed chain `10143`, receipt success, and the exact 10,000-atomic official test-USDC Transfer. Explain:

“A dedicated low-value raw-key signer signed only the approved Monad-testnet USDC authorization in this verified run; complete Privy signing is the preferred managed alternative, and the runtime allows exactly one signer type. A different wallet received the test USDC. The protected seller settled through the facilitator and Neon prevents a duplicate payment ID from charging again.”

For the remote merchant profile, show the two-round transcript in both Lazarus and the merchant console:

```text
Merchant asks    $12.00
Buyer offers      $9.00
Merchant counters $10.50
Buyer offers      $9.75
Merchant accepts  $9.75
```

“The independently deployed merchant bargained over authenticated HTTPS. Lazarus pinned its Ed25519 key, recomputed the canonical quote digest, and verified the signed 9.75 binding quote before policy accepted it. The result saves 2.25, or 18.75%.”

Point out the console boundary: Lazarus includes the proposed bounty in the offer message, but the merchant currently does not persist it. The console therefore shows the negotiation session, counters, signed quote, and audit events but no bounty field. The provider reward is not the same thing as the merchant's 9.75 archive quote.

## 1:25–1:50 — Monad boundary

Show the 5.00 demo bounty and 2.00 simulated collateral requirement.

Say explicitly:

<<<<<<< Updated upstream
“This remote-merchant run makes no Monad transaction. The offer message includes proposed bounty context, but the recovery bounty, provider claim, attestations, and 70/90/100 releases use the local ledger. Their hash-shaped receipts are not explorer transactions, and the merchant console does not persist or display them.”
=======
“This hybrid merchant-and-Rain run makes no Monad transaction. The offer message includes proposed bounty context, but the recovery bounty, provider claim, attestations, and 70/90/100 releases use the local ledger. Their hash-shaped receipts are not explorer transactions, and the merchant console does not persist or display them.”
>>>>>>> Stashed changes

## 1:50–2:25 — Controlled archive allocation

In hybrid Production, Rain sandbox is armed and externally verified:

<<<<<<< Updated upstream
“Lazarus creates one local card-like authority for the signed 9.75 quote. The 9.00 unrelated merchant/category attempt is denied and costs nothing; only the exact quoted allocation succeeds. The merchant is not actually charged or paid.”

For the USD run, policy usage is 9.76: 0.01 discovery plus 9.75 archive allocation. In remote merchant Production both are simulated accounting, so the verified end-to-end run charged `$0.00` and made no chain write. In the separate protected x402 Preview only the discovery cent settles in test USDC; the 9.75 archive allocation remains local.
=======
“Lazarus issued a real Rain sandbox scoped card for the signed 9.75 quote. Rain's own ledger shows the 9.00 unrelated MCC 5944 attempt declined and the exact 9.75 MCC 5734 archive authorization completed. This is sandbox behavior: no production card or real money is involved.”

For the USD run, policy usage is 9.76: 0.01 discovery plus 9.75 archive allocation. In hybrid Production, discovery is local while Rain records the archive operation in its sandbox; `$0.00` real money is charged and there is no chain write. In the separate protected x402 Preview, the discovery cent settles in test USDC and Rain records the 9.75 archive allocation in its sandbox; neither is production money.
>>>>>>> Stashed changes

If asked about Rain payment routes, answer:

“Lazarus implements and has verified Rain's scoped-card issuance, authorization, decline, and settlement path. The sponsor starter also lists `/payment-routes`, but this project does not implement or claim that separate cross-rail flow.”

## 2:25–3:15 — Recover and verify

Watch all `8/8` remote pieces move from missing to recovered to verified. Show the pinned provider manifest, piece hashes, reconstructed SHA-256, and root match. Local fallback uses `24/24` pieces.

“The provider networking and byte transfer are real HTTPS operations. Lazarus bounds every response and verifies the live manifest against the sponsor-pinned copy, every piece hash, the total size, and the reconstructed artifact. The verifier roles themselves remain scripted and local.”

## 3:15–3:40 — Reward and network effect

Show:

- 3.50 released at the 70% milestone;
- 1.00 more at 90%;
- the final 0.50 at 100%; and
- seeders changing from zero to two.

State that reward release and seeders are local model state, not onchain bounty settlement or active seeding processes.

## 3:40–4:00 — Close

<<<<<<< Updated upstream
“Lazarus Mesh separates autonomy from authority. The buyer bargains with a real merchant API, verifies its signed quote, and retrieves a sponsor-pinned artifact from the provider. Deterministic policy still decides what may happen. The remote run charges nothing; Privy/x402 testnet settlement is isolated to a different protected profile, and Rain stays unarmed until valid rotated credentials arrive.”
=======
“Lazarus Mesh separates autonomy from authority. The buyer bargains with a real merchant API, verifies its signed quote, retrieves a sponsor-pinned artifact, and constrains the archive purchase through Rain's sandbox. Deterministic policy still decides what may happen. Real x402 test-USDC settlement is isolated to a separate protected local-fixture Preview. The full bounty, verifier network, and reseeding remain local in every profile.”
>>>>>>> Stashed changes

Closing line:

> Lazarus Mesh is an economic immune system for missing digital knowledge.
