const { randomUUID } = require("node:crypto");
const { makeEvent } = require("./demo-state");
const { assertTransition, evaluatePolicy, evaluateQuote } = require("./domain");

const STEP_COUNT = 9;

class LazarusOrchestrator {
  constructor({ store, rain, monad, x402, negotiation, recovery, broadcast = () => {} }) {
    this.store = store;
    this.rain = rain;
    this.monad = monad;
    this.x402 = x402;
    this.negotiation = negotiation;
    this.recovery = recovery;
    this.broadcast = broadcast;
    this.activeRuns = new Map();
    this.generation = 0;
  }

  async reset(nextStateFactory) {
    const activeSandboxAuthority = this.store.get().missions.some(
      (mission) => (
        mission.rainCard?.mode === "rain-sandbox" &&
        ["active", "expiry_scheduled"].includes(mission.rainCard.state) &&
        new Date(mission.rainCard.expiresAt).getTime() > Date.now()
      ),
    );
    if (activeSandboxAuthority) {
      const error = new Error("Reset blocked while a Rain sandbox card can still be live remotely. Complete the mission and wait for the recorded card expiry.");
      error.statusCode = 409;
      error.code = "RAIN_SANDBOX_AUTHORITY_ACTIVE";
      throw error;
    }
    this.generation += 1;
    this.activeRuns.clear();
    await Promise.all([
      this.rain.reset(),
      this.monad.reset(),
      this.x402.reset(),
      this.negotiation.reset(),
      this.recovery.reset(),
    ]);
    const nextState = nextStateFactory();
    this.store.replace(nextState);
    this.publish();
    return nextState;
  }

  addMission(mission) {
    this.store.update((state) => {
      state.missions.unshift(mission);
      state.activeMissionId = mission.id;
    });
    this.publish();
    return mission;
  }

  getMission(missionId) {
    const mission = this.store.get().missions.find((item) => item.id === missionId);
    if (!mission) {
      const error = new Error("Mission not found.");
      error.statusCode = 404;
      throw error;
    }
    return mission;
  }

  async step(missionId, { fromRun = false } = {}) {
    const mission = this.getMission(missionId);
    if (this.activeRuns.has(missionId) && !fromRun) {
      const error = new Error("Mission is already running.");
      error.statusCode = 409;
      throw error;
    }
    if (mission.stepIndex >= STEP_COUNT) return mission;

    const nextStep = mission.stepIndex + 1;
    await this.executeStep(mission, nextStep);
    mission.stepIndex = nextStep;
    this.store.save();
    this.publish();
    return mission;
  }

  async run(missionId, delayMs = 420) {
    const mission = this.getMission(missionId);
    if (this.activeRuns.has(missionId)) {
      const error = new Error("Mission is already running.");
      error.statusCode = 409;
      throw error;
    }
    const runGeneration = this.generation;
    const runToken = Symbol(missionId);
    this.activeRuns.set(missionId, runToken);
    mission.running = true;
    this.store.save();
    this.publish();
    try {
      while (mission.stepIndex < STEP_COUNT && runGeneration === this.generation) {
        await this.step(missionId, { fromRun: true });
        if (mission.stepIndex < STEP_COUNT) await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    } finally {
      if (this.activeRuns.get(missionId) === runToken) this.activeRuns.delete(missionId);
      if (runGeneration === this.generation) {
        mission.running = false;
        this.store.save();
        this.publish();
      } else {
        // This object belongs to the cancelled pre-reset generation. Clear its
        // transient flag, but never write it over the fresh state.
        mission.running = false;
      }
    }
    return runGeneration === this.generation ? mission : this.getMission(missionId);
  }

  addEvent(mission, source, title, description, status = "success") {
    mission.events.unshift(makeEvent({ source, title, description, status }));
    if (mission.events.length > 100) mission.events.length = 100;
  }

  checkpoint() {
    this.store.save();
    this.publish();
  }

  transition(mission, nextStatus, statusLabel) {
    if (mission.status !== nextStatus) assertTransition(mission.status, nextStatus);
    mission.status = nextStatus;
    mission.statusLabel = statusLabel;
  }

  addChainTransaction(mission, receipt) {
    mission.transactions.unshift({
      id: receipt.transactionHash,
      rail: "Monad",
      operation: receipt.operation,
      status: "confirmed",
      amountMinor: receipt.amountMinor || receipt.stakeMinor || 0,
      currency: receipt.currency || "USDC",
      timestamp: receipt.timestamp,
      synthetic: receipt.synthetic === true,
      fundsMoved: receipt.fundsMoved === true,
      chainWrite: receipt.chainWrite === true,
      details: receipt,
    });
  }

  getNegotiation(missionId) {
    return this.getMission(missionId).negotiation;
  }

  async negotiate(missionId) {
    const mission = this.getMission(missionId);
    if (mission.stepIndex < 1) {
      const error = new Error("Run availability discovery before negotiating with the merchant.");
      error.statusCode = 409;
      error.code = "DISCOVERY_REQUIRED";
      throw error;
    }
    await this.executeNegotiation(mission);
    this.store.save();
    this.publish();
    return mission.negotiation;
  }

  async executeNegotiation(mission) {
    const policy = mission.negotiation;
    if (policy.acceptedQuote && ["quote_accepted", "consumed"].includes(policy.status)) {
      return policy.acceptedQuote;
    }

    const sessionStart = await this.negotiation.getOffers({
      missionId: mission.id,
      contentRoot: mission.contentRoot,
      providerId: mission.provider.id,
      requirements: {
        maximumRounds: policy.maximumRounds,
        maximumAmountMinor: policy.maximumAmountMinor,
      },
      idempotencyKey: `offers:${mission.id}`,
    });
    const initialOffer = sessionStart.offers[0];
    if (!initialOffer) throw new Error("Merchant negotiation returned no offers.");

    let response = await this.negotiation.sendCounterOffer({
      sessionId: sessionStart.sessionId,
      offerId: initialOffer.offerId,
      amountMinor: policy.targetAmountMinor,
      terms: policy.requiredTerms,
      idempotencyKey: `counter:${mission.id}:1`,
    });

    if (!response.quote && response.round?.seller?.action === "counter") {
      const bestWithinPolicy = Math.floor(
        (policy.targetAmountMinor + response.round.seller.amountMinor) / 2,
      );
      response = await this.negotiation.sendCounterOffer({
        sessionId: sessionStart.sessionId,
        offerId: initialOffer.offerId,
        amountMinor: bestWithinPolicy,
        terms: policy.requiredTerms,
        idempotencyKey: `counter:${mission.id}:2`,
      });
    }

    if (!response.quote) {
      const error = new Error("Merchant negotiation ended without an acceptable binding quote.");
      error.statusCode = 422;
      error.code = "NEGOTIATION_NO_BINDING_QUOTE";
      throw error;
    }

    const quote = await this.negotiation.getBindingQuote({
      sessionId: sessionStart.sessionId,
      quoteId: response.quote.quoteId,
    });
    if (
      this.negotiation.liveMerchantApi === true &&
      (
        this.negotiation.merchantAuthenticated !== true ||
        this.negotiation.merchantSignedQuotes !== true ||
        quote.merchantAuthenticated !== true ||
        quote.merchantSigned !== true
      )
    ) {
      const error = new Error("A live merchant quote must be authenticated and signature-verified before it can be accepted.");
      error.statusCode = 422;
      error.code = "MERCHANT_QUOTE_UNTRUSTED";
      throw error;
    }
    const decision = evaluateQuote({
      mission,
      policy,
      quote,
      expectedSessionId: sessionStart.sessionId,
      roundCount: response.session.rounds.length,
    });
    if (!decision.allowed) {
      const error = new Error(`Binding quote rejected: ${decision.code}`);
      error.statusCode = 422;
      error.code = decision.code;
      throw error;
    }

    const savingsMinor = Math.max(0, policy.initialAmountMinor - quote.amountMinor);
    Object.assign(policy, {
      status: "quote_accepted",
      sessionId: sessionStart.sessionId,
      offers: response.session.offers,
      rounds: response.session.rounds,
      acceptedQuote: quote,
      decision,
      savingsMinor,
      savingsBps: policy.initialAmountMinor > 0
        ? Math.round((savingsMinor * 10_000) / policy.initialAmountMinor)
        : 0,
      completedAt: response.session.completedAt,
    });
    this.addEvent(
      mission,
      this.negotiation.liveMerchantApi === true ? "Merchant connector" : "Local bargaining policy",
      this.negotiation.liveMerchantApi === true ? "Binding archive quote accepted" : "Policy-bound demo quote accepted",
      this.negotiation.liveMerchantApi === true
        ? `The merchant accepted $${(quote.amountMinor / 100).toFixed(2)} after ${policy.rounds.length} counteroffers, saving $${(savingsMinor / 100).toFixed(2)} under one-time terms.`
        : `The simulated Atlas merchant model accepted $${(quote.amountMinor / 100).toFixed(2)} after ${policy.rounds.length} deterministic counteroffers, saving $${(savingsMinor / 100).toFixed(2)}. No external seller was contacted.`,
    );
    return quote;
  }

  async executeStep(mission, step) {
    if (step === 1) {
      const requirement = await this.x402.requestAvailability(mission.contentRoot);
      const receipt = await this.x402.settleAvailability({
        missionId: mission.id,
        contentRoot: mission.contentRoot,
        payer: mission.principal.id,
      });
      this.transition(
        mission,
        "DISCOVERING",
        this.negotiation.liveMerchantApi === true
          ? "Candidate discovered and archive price negotiated"
          : "Demo candidate selected and quote simulated",
      );
      mission.availability = 8;
      mission.budget.spentMinor += receipt.amountMinor;
      mission.payments.unshift({ ...receipt, protocolStatus: requirement.status });
      mission.transactions.unshift({
        id: receipt.transactionHash,
        rail: "x402 / Monad",
        operation: "availability intelligence",
        status: "settled",
        amountMinor: receipt.amountMinor,
        currency: "USDC",
        timestamp: receipt.timestamp,
        synthetic: receipt.synthetic === true,
        fundsMoved: receipt.fundsMoved === true,
        externalEndpoint: receipt.externalEndpoint === true,
      });
      await this.executeNegotiation(mission);
      this.addEvent(
        mission,
        "x402",
        this.x402.mode === "local" ? "Availability handshake simulated" : "Availability intelligence purchased",
        this.x402.mode === "local"
          ? "The local HTTP 402 demo handshake selected the simulated Atlas fixture provider. No external provider was contacted and no token was signed or transferred."
          : "Agent completed an HTTP 402 availability-discovery handshake and found Atlas Archive Node; bargaining happened in a separate quote session.",
      );
      return;
    }

    if (step === 2) {
      const receipt = await this.monad.createBounty({
        missionId: mission.id,
        sponsor: mission.principal.id,
        contentRoot: mission.contentRoot,
        rewardMinor: mission.budget.rewardMinor,
        stakeMinor: mission.budget.stakeMinor,
      });
      this.transition(
        mission,
        "FUNDED",
        this.monad.mode === "local" ? "Bounty recorded in local demo ledger" : "Bounty funded on Monad",
      );
      mission.availability = 12;
      this.addChainTransaction(mission, receipt);
      this.addEvent(
        mission,
        "Monad",
        this.monad.mode === "local" ? "Demo bounty recorded" : "Recovery bounty funded",
        this.monad.mode === "local"
          ? `$${(mission.budget.rewardMinor / 100).toFixed(2)} demo reward recorded under content root ${mission.contentRoot.slice(0, 12)}… No USDC moved.`
          : `$${(mission.budget.rewardMinor / 100).toFixed(2)} USDC escrowed under content root ${mission.contentRoot.slice(0, 12)}…`,
      );
      return;
    }

    if (step === 3) {
      const quote = mission.negotiation.acceptedQuote;
      const localPaymentSimulation = this.rain.mode === "local";
      if (!quote) {
        const error = new Error("A binding merchant quote is required before payment authority can be created.");
        error.statusCode = 409;
        error.code = "BINDING_QUOTE_REQUIRED";
        throw error;
      }
      const quoteDecision = evaluateQuote({
        mission,
        policy: mission.negotiation,
        quote,
        expectedSessionId: mission.negotiation.sessionId,
        roundCount: mission.negotiation.rounds.length,
      });
      mission.negotiation.decision = quoteDecision;
      if (!quoteDecision.allowed) {
        const error = new Error(`Binding quote is no longer payable: ${quoteDecision.code}`);
        error.statusCode = 422;
        error.code = quoteDecision.code;
        throw error;
      }

      const normalizedPolicy = {
        allowedRails: ["rain_card"],
        allowedMerchants: [quote.merchantId],
        allowedMccs: [quote.mcc],
        allowedPurposes: [quote.purpose],
        perTransactionLimitMinor: quote.amountMinor,
        totalLimitMinor: mission.policy.totalLimitMinor,
        maxTransactions: 1,
        approvalThresholdMinor: mission.negotiation.autoApprovalThresholdMinor,
        expiresAt: quote.expiresAt,
        requireRightsEvidence: true,
        killSwitchActive: mission.policy.killSwitchActive,
      };
      const approvedIntent = {
        id: `intent_archive_${quote.quoteId}`,
        idempotencyKey: `archive:${quote.quoteId}`,
        rail: "rain_card",
        merchant: quote.merchantId,
        mcc: quote.mcc,
        purpose: quote.purpose,
        amountMinor: quote.amountMinor,
      };
      const preflightDecision = evaluatePolicy({
        mission: { ...mission, status: "RECOVERING" },
        policy: normalizedPolicy,
        intent: approvedIntent,
        usage: { spentMinor: mission.budget.spentMinor, transactionCount: 0 },
      });
      if (!preflightDecision.allowed) {
        const error = new Error(`Payment policy preflight failed: ${preflightDecision.code}`);
        error.code = preflightDecision.code;
        throw error;
      }

      const claim = await this.monad.claimBounty(mission.id, mission.provider.id);
      mission.provider.state = "staked";
      this.addChainTransaction(mission, claim);

      const card = await this.rain.createScopedCard({
        principalId: mission.principal.id,
        missionId: mission.id,
        quoteId: quote.quoteId,
        allowedMerchantIds: [quote.merchantId],
        allowedMccs: [quote.mcc],
        maximumAmountMinor: quote.amountMinor,
        maxTransactions: 1,
        expiresAt: quote.expiresAt,
        purpose: quote.purpose,
      });
      mission.rainCard = card;
      // Persist external authority immediately so a later network failure or
      // process interruption cannot make the application forget a live card.
      this.checkpoint();

      const blockedIntent = {
        id: `intent_blocked_${mission.id}`,
        rail: "rain_card",
        merchant: "merchant_luxury_market",
        mcc: "5944",
        purpose: "unrelated_purchase",
        amountMinor: 900,
      };
      const blockedPolicyDecision = evaluatePolicy({
        mission: { ...mission, status: "RECOVERING" },
        policy: normalizedPolicy,
        intent: blockedIntent,
        usage: { spentMinor: mission.budget.spentMinor, transactionCount: 0 },
      });
      mission.policyDecisions.unshift({
        id: randomUUID(),
        action: "Unrelated luxury purchase",
        ...blockedPolicyDecision,
        timestamp: new Date().toISOString(),
      });

      const blocked = await this.rain.authorizePurchase(card.cardId, {
        intentId: blockedIntent.id,
        merchantId: blockedIntent.merchant,
        merchantName: "Unrelated Luxury Market",
        mcc: blockedIntent.mcc,
        amountMinor: blockedIntent.amountMinor,
        currency: "USD",
        exerciseRemoteControl: true,
      });
      mission.payments.unshift(blocked);
      mission.transactions.unshift({
        id: blocked.transactionId,
        rail: "Rain scoped card",
        operation: "blocked purchase",
        status: blocked.status,
        amountMinor: blocked.amountMinor,
        currency: blocked.currency,
        timestamp: blocked.checkedAt,
        reason: blocked.code,
        synthetic: blocked.synthetic === true,
        fundsMoved: blocked.fundsMoved === true,
        externalEndpoint: blocked.externalEndpoint === true,
      });
      this.checkpoint();

      const allowedPolicyDecision = evaluatePolicy({
        mission: { ...mission, status: "RECOVERING" },
        policy: normalizedPolicy,
        intent: approvedIntent,
        usage: { spentMinor: mission.budget.spentMinor, transactionCount: 0 },
      });
      mission.policyDecisions.unshift({
        id: randomUUID(),
        action: "Approved negotiated archival egress",
        quoteId: quote.quoteId,
        ...allowedPolicyDecision,
        timestamp: new Date().toISOString(),
      });
      if (!allowedPolicyDecision.allowed) {
        throw new Error(`Payment policy rejected the accepted quote: ${allowedPolicyDecision.code}`);
      }

      const allowed = await this.rain.authorizePurchase(card.cardId, {
        intentId: approvedIntent.id,
        quoteId: quote.quoteId,
        merchantId: quote.merchantId,
        merchantName: quote.merchantName,
        mcc: quote.mcc,
        amountMinor: quote.amountMinor,
        currency: quote.currency,
        settle: true,
      });
      if (!allowed.authorized) throw new Error(`Rain rejected the accepted quote: ${allowed.code}`);
      mission.payments.unshift(allowed);
      mission.transactions.unshift({
        id: allowed.transactionId,
        rail: "Rain scoped card",
        operation: "negotiated archival egress",
        status: allowed.status,
        amountMinor: allowed.amountMinor,
        currency: allowed.currency,
        timestamp: allowed.checkedAt,
        quoteId: quote.quoteId,
        synthetic: allowed.synthetic === true,
        fundsMoved: allowed.fundsMoved === true,
        externalEndpoint: allowed.externalEndpoint === true,
      });
      this.checkpoint();
      mission.budget.spentMinor += allowed.amountMinor;
      mission.negotiation.status = "consumed";
      mission.negotiation.consumedAt = allowed.checkedAt;
      this.transition(
        mission,
        "RECOVERING",
        localPaymentSimulation ? "Negotiated archive access simulated" : "Negotiated archive access sandbox-settled",
      );
      mission.availability = 16;
      this.addEvent(
        mission,
        "Rain",
        localPaymentSimulation ? "Policy safety test passed" : "Unauthorized purchase blocked",
        localPaymentSimulation
          ? `Local policy simulation blocked the unrelated $9.00 purchase as designed: ${blocked.code}. No funds moved.`
          : `An in-limit $9.00 unrelated-merchant purchase was denied: ${blocked.code}.`,
        "blocked",
      );
      this.addEvent(
        mission,
        "Rain",
        localPaymentSimulation ? "Archive purchase simulated" : "Negotiated archive quote sandbox-settled",
        localPaymentSimulation
          ? `Local scoped-card policy simulated the $${(quote.amountMinor / 100).toFixed(2)} archive allocation at MCC ${quote.mcc}. $0.00 was charged.`
          : `Scoped card •••• ${card.lastFour} sandbox-settled $${(quote.amountMinor / 100).toFixed(2)} at approved MCC ${quote.mcc}, bound to quote ${quote.quoteId.slice(0, 14)}…`,
      );
      this.addEvent(
        mission,
        "Monad",
        this.monad.mode === "local" ? "Demo provider claim recorded" : "Provider claimed bounty",
        this.monad.mode === "local"
          ? "The simulated Atlas fixture provider was assigned in the local ledger; no provider endpoint was contacted and no collateral or token moved."
          : "Atlas Archive Node posted collateral and committed to recovery.",
      );
      return;
    }

    if (step === 4) {
      mission.pieces = await this.recovery.recoverThrough(mission.id, 8);
      mission.status = "RECOVERING";
      mission.statusLabel = "Recovering pieces — 8 of 24";
      mission.availability = 34;
      this.addEvent(
        mission,
        this.recovery.mode === "local" ? "Local recovery fixture" : "Recovery provider",
        "First pieces recovered",
        this.recovery.mode === "local"
          ? "8 cryptographically addressed pieces loaded from the bundled CC0 fixture; no external provider transferred data."
          : "8 cryptographically addressed pieces received from the recovery provider.",
      );
      return;
    }

    if (step === 5) {
      mission.pieces = await this.recovery.recoverThrough(mission.id, 16);
      mission.statusLabel = "Recovering pieces — 16 of 24";
      mission.availability = 58;
      this.addEvent(
        mission,
        this.recovery.mode === "local" ? "Local recovery fixture" : "Recovery provider",
        "Recovery passed halfway",
        this.recovery.mode === "local"
          ? "16 of 24 bundled fixture pieces loaded; each piece hash matches the manifest."
          : "16 of 24 pieces received; each piece hash matches the manifest.",
      );
      return;
    }

    if (step === 6) {
      mission.pieces = await this.recovery.recoverThrough(mission.id, 24);
      mission.pieces = await this.recovery.verifyAll(mission.id);
      this.transition(mission, "VERIFYING", "Verifier quorum reconstructing artifact");
      mission.availability = 82;
      mission.verifiers[0].state = "passed";
      mission.verifiers[1].state = "passed";
      mission.audit.quorum = "2/2";
      this.addEvent(
        mission,
        "Local verifier quorum",
        "Scripted verification passed",
        "North and East are local verifier roles in this demo; they checked the fixture pieces against the declared hashes without contacting independent services.",
      );
      return;
    }

    if (step === 7) {
      const reconstruction = await this.recovery.reconstruct(mission.id);
      if (!reconstruction.matches) throw new Error("Reconstructed artifact root mismatch.");
      mission.audit.reconstructedContentSha256 = reconstruction.contentSha256;
      mission.audit.rootMatched = true;
      const attestationReceipt = await this.monad.recordAttestations(
        mission.id,
        mission.verifiers.slice(0, 2).map((verifier) => ({
          verifierId: verifier.id,
          result: "pass",
          contentSha256: reconstruction.contentSha256,
        })),
      );
      const release = await this.monad.releaseTranche(mission.id, 70, "recovery");
      mission.budget.releasedMinor = release.totalReleasedMinor;
      this.transition(
        mission,
        "VERIFIED",
        this.monad.mode === "local" ? "Artifact verified — demo reward advanced" : "Artifact verified — reward released",
      );
      mission.availability = 94;
      this.addChainTransaction(mission, attestationReceipt);
      this.addChainTransaction(mission, release);
      this.addEvent(
        mission,
        "Monad",
        this.monad.mode === "local" ? "Demo recovery tranche recorded" : "Recovery tranche released",
        this.monad.mode === "local"
          ? "Verifier quorum matched the complete SHA-256 root; the local ledger advanced the demo reward to 70%."
          : "Verifier quorum matched the complete SHA-256 root; 70% of bounty released.",
      );
      return;
    }

    if (step === 8) {
      const release = await this.monad.releaseTranche(mission.id, 90, "availability");
      mission.budget.releasedMinor = release.totalReleasedMinor;
      mission.seeders = 2;
      mission.provider.state = "reseeding";
      this.transition(
        mission,
        "RESEEDED",
        this.recovery.mode === "local" ? "Demo modeled two local replicas" : "Restored to two independent seeders",
      );
      mission.availability = 100;
      this.addChainTransaction(mission, release);
      this.addEvent(
        mission,
        "Recovery network",
        this.recovery.mode === "local" ? "Demo replicas modeled" : "Artifact resurrected",
        this.monad.mode === "local"
          ? "The demo modeled two complete replicas and recorded the retention milestone locally; no external seeding network was contacted."
          : "Availability changed from zero to two complete seeders; retention tranche released.",
      );
      return;
    }

    if (step === 9) {
      const release = await this.monad.releaseTranche(mission.id, 100, "replication");
      mission.budget.releasedMinor = release.totalReleasedMinor;
      mission.provider.state = "completed";
      this.transition(mission, "COMPLETED", "Recovery complete and auditable");
      mission.completedAt = new Date().toISOString();
      if (mission.rainCard?.cardId) mission.rainCard = await this.rain.retireCard(mission.rainCard.cardId);
      this.addChainTransaction(mission, release);
      if (mission.rainCard?.state === "expiry_scheduled") {
        this.addEvent(mission, "Rain", "Scoped card expiration scheduled", "Application payment authority was disabled; the Rain sandbox card remains bounded by its short remote expiry because the public sandbox exposes no cancel endpoint.");
      } else {
        this.addEvent(
          mission,
          "Rain",
          this.rain.mode === "local" ? "Simulated card retired" : "Scoped card retired",
          this.rain.mode === "local"
            ? "The local card-policy simulation removed its demo authority; no real card existed."
            : "Payment authority removed immediately after mission completion.",
        );
      }
      this.addEvent(
        mission,
        "Lazarus Mesh",
        "Mission completed",
        this.monad.mode === "local"
          ? "The bundled-fixture recovery simulation completed. Demo allocations, scripted proofs, and local receipts reconciled with $0.00 charged."
          : "Dead data is live again. Payment, proof, and recovery receipts reconciled.",
      );
    }
  }

  async triggerBlockedPurchase(missionId) {
    const mission = this.getMission(missionId);
    if (!mission.rainCard?.cardId) {
      const error = new Error("Run through scoped-card creation first.");
      error.statusCode = 409;
      throw error;
    }
    const result = await this.rain.authorizePurchase(mission.rainCard.cardId, {
      merchantId: "merchant_unapproved",
      merchantName: "Unapproved Merchant",
      mcc: "7995",
      amountMinor: 25_000,
      currency: "USD",
    });
    mission.payments.unshift(result);
    mission.transactions.unshift({
      id: result.transactionId,
      rail: "Rain scoped card",
      operation: "manual policy challenge",
      status: result.status,
      amountMinor: result.amountMinor,
      currency: result.currency,
      timestamp: result.checkedAt,
      reason: result.code,
    });
    this.addEvent(mission, "Rain", "Policy challenge blocked", `$250.00 purchase rejected: ${result.code}.`, "blocked");
    this.store.save();
    this.publish();
    return result;
  }

  publish() {
    this.broadcast({ type: "state", data: this.publicState() });
  }

  publicState() {
    return JSON.parse(JSON.stringify(this.store.get(), (key, value) => (key.startsWith("_") ? undefined : value)));
  }
}

module.exports = { LazarusOrchestrator, STEP_COUNT };
