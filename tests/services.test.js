const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { LocalRainAdapter } = require("../src/services/rain-local");
const { LocalMonadAdapter } = require("../src/services/monad-local");
const { LocalX402Adapter } = require("../src/services/x402-local");
const { LocalRecoveryAdapter } = require("../src/services/recovery-local");
const { createSyntheticManifest } = require("../src/domain");

const fixedNow = new Date("2026-08-09T12:00:00.000Z");
const clock = () => new Date(fixedNow);

test("Rain adapter authorizes bounded purchase and blocks oversized purchase", () => {
  const rain = new LocalRainAdapter({ clock });
  const card = rain.createScopedCard({
    principalId: "principal",
    missionId: "mission",
    allowedMerchantIds: ["archive"],
    allowedMccs: ["5734"],
    maximumAmountMinor: 1200,
    maxTransactions: 1,
    expiresAt: "2026-08-09T13:00:00.000Z",
    purpose: "archival_egress",
  });
  const blocked = rain.authorizePurchase(card.cardId, {
    merchantId: "other",
    merchantName: "Other",
    mcc: "7995",
    amountMinor: 10_000,
  });
  assert.equal(blocked.authorized, false);
  assert.equal(blocked.code, "AMOUNT_LIMIT_EXCEEDED");

  const wrongMerchant = rain.authorizePurchase(card.cardId, {
    merchantId: "other",
    merchantName: "Other",
    mcc: "7995",
    amountMinor: 1000,
  });
  assert.equal(wrongMerchant.authorized, false);
  assert.equal(wrongMerchant.code, "MERCHANT_NOT_ALLOWED");

  const allowed = rain.authorizePurchase(card.cardId, {
    merchantId: "archive",
    merchantName: "Archive",
    mcc: "5734",
    amountMinor: 1200,
  });
  assert.equal(allowed.authorized, true);
  assert.equal(rain.retireCard(card.cardId).state, "retired");
});

test("Rain adapter rejects malformed authority and purchase amounts", () => {
  const rain = new LocalRainAdapter({ clock });
  assert.throws(() => rain.createScopedCard({
    principalId: "principal",
    missionId: "mission",
    allowedMerchantIds: ["archive"],
    allowedMccs: ["5734"],
    maximumAmountMinor: 1200,
    maxTransactions: 1,
  }), (error) => error.code === "INVALID_POLICY");

  const card = rain.createScopedCard({
    principalId: "principal",
    missionId: "mission",
    allowedMerchantIds: ["archive"],
    allowedMccs: ["5734"],
    maximumAmountMinor: 1200,
    maxTransactions: 1,
    expiresAt: "2026-08-09T13:00:00.000Z",
  });
  assert.equal(rain.authorizePurchase(card.cardId, {}).code, "INVALID_AMOUNT");
  assert.equal(rain.authorizePurchase(card.cardId, { amountMinor: -1 }).code, "INVALID_AMOUNT");
});

test("Rain card scopes cannot be widened by mutating caller-owned arrays", () => {
  const rain = new LocalRainAdapter({ clock });
  const merchants = ["archive"];
  const mccs = ["5734"];
  const card = rain.createScopedCard({
    principalId: "principal",
    missionId: "immutable-scope",
    allowedMerchantIds: merchants,
    allowedMccs: mccs,
    maximumAmountMinor: 1200,
    maxTransactions: 1,
    expiresAt: "2026-08-09T13:00:00.000Z",
  });
  merchants.length = 0;
  mccs.length = 0;
  const result = rain.authorizePurchase(card.cardId, {
    merchantId: "unapproved",
    mcc: "7995",
    amountMinor: 1000,
  });
  assert.equal(result.authorized, false);
  assert.equal(result.code, "MERCHANT_NOT_ALLOWED");
});

test("Monad adapter releases cumulative 70/90/100 percent tranches exactly once", () => {
  const monad = new LocalMonadAdapter({ clock });
  monad.createBounty({ missionId: "m1", sponsor: "s", contentRoot: "root", rewardMinor: 500, stakeMinor: 200 });
  monad.claimBounty("m1", "provider");
  monad.recordAttestations("m1", [
    { verifierId: "v1", result: "pass" },
    { verifierId: "v2", result: "pass" },
  ]);
  assert.equal(monad.releaseTranche("m1", 70, "recovery").amountMinor, 350);
  assert.equal(monad.releaseTranche("m1", 90, "availability").amountMinor, 100);
  assert.equal(monad.releaseTranche("m1", 100, "replication").amountMinor, 50);
  assert.throws(() => monad.releaseTranche("m1", 250, "invalid"), /BOUNTY_NOT_RELEASABLE|INVALID_RELEASE_PERCENTAGE/);
});

test("Monad adapter rejects release percentages above 100 before funds can over-release", () => {
  const monad = new LocalMonadAdapter({ clock });
  monad.createBounty({ missionId: "m2", sponsor: "s", contentRoot: "root", rewardMinor: 500, stakeMinor: 200 });
  monad.claimBounty("m2", "provider");
  monad.recordAttestations("m2", [
    { verifierId: "v1", result: "pass" },
    { verifierId: "v2", result: "pass" },
  ]);
  assert.throws(() => monad.releaseTranche("m2", 250, "invalid"), /INVALID_RELEASE_PERCENTAGE/);
  assert.equal(monad.releaseTranche("m2", 100, "complete").amountMinor, 500);
});

test("Monad adapter rejects unsafe bounty economics", () => {
  const monad = new LocalMonadAdapter({ clock });
  for (const rewardMinor of [Infinity, Number.NaN, 0, -1, 1.5]) {
    assert.throws(() => monad.createBounty({
      missionId: `invalid-${String(rewardMinor)}`,
      sponsor: "s",
      contentRoot: "root",
      rewardMinor,
      stakeMinor: 200,
    }), /INVALID_BOUNTY_PARAMETERS/);
  }
  assert.throws(() => monad.createBounty({
    missionId: "invalid-stake",
    sponsor: "s",
    contentRoot: "root",
    rewardMinor: 500,
    stakeMinor: Infinity,
  }), /INVALID_BOUNTY_PARAMETERS/);
});

test("Monad adapter fails closed on malformed providers and quorum evidence", () => {
  const monad = new LocalMonadAdapter({ clock });
  monad.createBounty({ missionId: "m3", sponsor: "s", contentRoot: "root", rewardMinor: 500, stakeMinor: 200 });
  assert.throws(() => monad.claimBounty("m3", ""), /INVALID_PROVIDER/);
  monad.claimBounty("m3", "provider");
  assert.throws(() => monad.recordAttestations("m3", [], 0), /INVALID_ATTESTATIONS/);
  assert.throws(() => monad.recordAttestations("m3", [{ verifierId: "", result: "pass" }]), /INVALID_ATTESTATIONS/);
});

test("x402 adapter returns 402 requirement and settled availability receipt", () => {
  const x402 = new LocalX402Adapter({ clock });
  assert.equal(x402.requestAvailability("root").status, 402);
  const receipt = x402.settleAvailability({ missionId: "m", contentRoot: "root", payer: "p" });
  assert.equal(receipt.status, "settled");
  assert.equal(receipt.network, "eip155:10143");
  assert.equal(receipt.paymentResponse.candidateProviders, 2);
  assert.deepEqual(
    x402.settleAvailability({ missionId: "m", contentRoot: "root", payer: "p" }),
    receipt,
  );
});

test("x402 adapter rejects malformed resource and payment identities", () => {
  const x402 = new LocalX402Adapter({ clock });
  assert.throws(() => x402.requestAvailability(""), /INVALID_CONTENT_ROOT/);
  assert.throws(() => x402.settleAvailability({ missionId: "m", contentRoot: "", payer: "p" }), /INVALID_X402_PAYMENT/);
});

test("recovery adapter reconstructs exact fixture bytes", () => {
  const recovery = new LocalRecoveryAdapter({
    fixturePath: path.join(__dirname, "..", "fixtures", "cc0-rainfall-dataset", "rainfall-sample.json"),
  });
  const manifest = recovery.buildManifest(24);
  recovery.start("m", manifest);
  recovery.recoverThrough("m", 24);
  const progress = recovery.verifyAll("m");
  assert.equal(progress.verified, 24);
  const result = recovery.reconstruct("m");
  assert.equal(result.matches, true);
  assert.equal(result.contentSha256, manifest.contentSha256);
});

test("recovery adapter accepts the canonical offline domain manifest", () => {
  const recovery = new LocalRecoveryAdapter();
  const manifest = createSyntheticManifest({ pieceSize: 256 });
  recovery.start("domain-manifest", manifest);
  recovery.recoverThrough("domain-manifest", manifest.pieceCount);
  assert.equal(recovery.verifyAll("domain-manifest").verified, 24);
  const result = recovery.reconstruct("domain-manifest");
  assert.equal(result.matches, true);
  assert.equal(result.contentSha256, manifest.artifactSha256);
});

test("recovery adapter rejects inconsistent manifests before opening a session", () => {
  const recovery = new LocalRecoveryAdapter();
  const wrongCount = createSyntheticManifest({ pieceSize: 64 });
  wrongCount.pieceCount = 23;
  assert.throws(() => recovery.start("wrong-count", wrongCount), /piece count/i);

  const wrongSize = createSyntheticManifest({ pieceSize: 64 });
  wrongSize.pieces[4].byteLength += 1;
  assert.throws(() => recovery.start("wrong-size", wrongSize), /metadata is inconsistent/i);

  const wrongHash = createSyntheticManifest({ pieceSize: 64 });
  wrongHash.pieces[7].fixtureBase64 = Buffer.alloc(64, 1).toString("base64");
  assert.throws(() => recovery.start("wrong-hash", wrongHash), /hash does not match/i);
});

test("default recovery fixture resolves independently of process cwd", () => {
  const recovery = new LocalRecoveryAdapter();
  assert.equal(path.isAbsolute(recovery.fixturePath), true);
  assert.doesNotThrow(() => recovery.buildManifest(24));
});
