(() => {
  "use strict";

  const STAGES = ["DEAD", "DISCOVERING", "RECOVERING", "VERIFIED", "RESEEDED"];
  const STAGE_COPY = {
    DEAD: "Agent awaiting command",
    DISCOVERING: "Discovery agents scanning providers",
    RECOVERING: "Recovery workers reconstructing pieces",
    VERIFIED: "Verifier quorum confirming content root",
    RESEEDED: "Artifact restored to the mesh",
  };
  const money = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

  const app = {
    data: { missions: [], activeMissionId: null, system: {} },
    selectedMissionId: null,
    auditTab: "receipts",
    eventSource: null,
    refreshTimer: null,
    pollingTimer: null,
    health: null,
    healthCheckedAt: null,
    healthRequest: null,
    hasShownConnectionError: false,
    busy: new Set(),
    missionCreationPolicy: {
      minimumBudgetMinor: 1201,
      maximumBudgetMinor: 500000,
      minimumRewardMinor: 100,
      maximumRewardMinor: 100000,
      available: true,
      unavailableReason: "",
    },
  };

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

  const elements = {
    dashboard: $("#dashboard"),
    emptyState: $("#empty-state"),
    missionList: $("#mission-list"),
    missionCount: $("#mission-count"),
    connectionChip: $("#connection-chip"),
    connectionLabel: $("#connection-label"),
    networkLabel: $("#network-label"),
    environmentPill: $("#environment-pill"),
    environmentLabel: $("#environment-label"),
    runtimeFootnote: $("#runtime-footnote"),
    protocolTitle: $("#protocol-title"),
    protocolList: $("#protocol-list"),
    readinessStrip: $("#readiness-strip"),
    readinessSummary: $("#readiness-summary"),
    readinessItems: $("#readiness-items"),
    footerPrimary: $("#footer-primary"),
    footerRuntime: $("#footer-runtime"),
    themeToggle: $("#theme-toggle"),
    dialog: $("#mission-dialog"),
    missionForm: $("#mission-form"),
    missionFormError: $("#mission-form-error"),
    missionFormErrorTitle: $("#mission-form-error-title"),
    missionFormErrorMessage: $("#mission-form-error-message"),
    createMissionButton: $("#create-mission-submit"),
    createMissionLabel: $("#create-mission-label"),
    budgetInput: $("#budget-input"),
    rewardInput: $("#reward-input"),
    costTotal: $("#cost-total"),
    costReward: $("#cost-reward"),
    costReserve: $("#cost-reserve"),
    toastRegion: $("#toast-region"),
    srStatus: $("#screen-reader-status"),
  };

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (char) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#039;",
    })[char]);
  }

  function asArray(value) {
    return Array.isArray(value) ? value : [];
  }

  function finiteNumber(value, fallback = 0) {
    const parsed = typeof value === "string" ? Number(value.replace(/[$,]/g, "")) : Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function displayMoney(value) {
    return money.format(finiteNumber(value));
  }

  function firstMinor(...values) {
    for (const value of values) {
      if (value === undefined || value === null || value === "") continue;
      const parsed = Number(value);
      if (Number.isSafeInteger(parsed) && parsed >= 0) return parsed;
    }
    return null;
  }

  function displayMinor(value, fallback = "—") {
    const amount = firstMinor(value);
    return amount === null ? fallback : displayMoney(amount / 100);
  }

  function asObject(value) {
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  }

  function configuredMinor(fallback, minorValues = [], majorValues = []) {
    const directMinor = firstMinor(...minorValues);
    if (directMinor !== null) return directMinor;
    for (const value of majorValues) {
      const amount = Number(value);
      if (Number.isFinite(amount) && amount >= 0) return Math.round(amount * 100);
    }
    return fallback;
  }

  function inputMoney(minor) {
    return (Math.max(0, finiteNumber(minor)) / 100).toFixed(2);
  }

  function objectLabel(value) {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (!value || typeof value !== "object") return null;
    const candidate = value.label ?? value.name ?? value.network ?? value.id;
    return typeof candidate === "string" && candidate.trim() ? candidate.trim() : null;
  }

  function formatInstant(value, fallback = "Not issued") {
    if (!value) return fallback;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return date.toLocaleString([], {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  function titleCase(value) {
    return String(value ?? "")
      .replace(/[_\-.]+/g, " ")
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .replace(/\b\w/g, (letter) => letter.toUpperCase())
      .trim();
  }

  function shorten(value, start = 8, end = 6) {
    const text = String(value ?? "");
    if (!text) return "—";
    if (text.length <= start + end + 3) return text;
    return `${text.slice(0, start)}…${text.slice(-end)}`;
  }

  function normalizeStage(mission) {
    const raw = String(mission?.status ?? mission?.availability?.status ?? mission?.availability ?? "DEAD")
      .trim()
      .toUpperCase()
      .replace(/[\s-]+/g, "_");

    const exact = {
      DEAD: "DEAD",
      UNAVAILABLE: "DEAD",
      DRAFT: "DEAD",
      OPEN: "DEAD",
      CREATED: "DEAD",
      DISCOVERING: "DISCOVERING",
      DISCOVERED: "DISCOVERING",
      RIGHTS_CHECKED: "DISCOVERING",
      PLANNED: "DISCOVERING",
      FUNDED: "DISCOVERING",
      CLAIMED: "DISCOVERING",
      SEARCHING: "DISCOVERING",
      RECOVERING: "RECOVERING",
      DOWNLOADING: "RECOVERING",
      RECONSTRUCTING: "RECOVERING",
      PURCHASING: "RECOVERING",
      VERIFYING: "RECOVERING",
      VERIFIED: "VERIFIED",
      RECOVERED: "VERIFIED",
      ATTESTED: "VERIFIED",
      RESEEDED: "RESEEDED",
      AVAILABLE: "RESEEDED",
      COMPLETED: "RESEEDED",
      COMPLETE: "RESEEDED",
    };

    if (exact[raw]) return exact[raw];
    if (raw.includes("RESEED") || raw.includes("COMPLETE") || raw.includes("ALIVE")) return "RESEEDED";
    if (raw.includes("VERIF") || raw.includes("ATTEST")) return "VERIFIED";
    if (raw.includes("RECOVER") || raw.includes("DOWNLOAD") || raw.includes("PIECE")) return "RECOVERING";
    if (raw.includes("DISCOVER") || raw.includes("SEARCH") || raw.includes("PLAN")) return "DISCOVERING";
    return "DEAD";
  }

  function piecesFor(mission) {
    const pieces = mission?.pieces ?? {};
    const total = Math.max(0, Math.round(finiteNumber(
      pieces.total ?? pieces.count ?? mission?.pieceCount ?? mission?.totalPieces,
      0,
    )));
    const recovered = clamp(Math.round(finiteNumber(
      pieces.recovered ?? pieces.downloaded ?? mission?.recoveredPieces,
      0,
    )), 0, total || Number.MAX_SAFE_INTEGER);
    const verified = clamp(Math.round(finiteNumber(
      pieces.verified ?? pieces.valid ?? mission?.verifiedPieces,
      0,
    )), 0, total || Number.MAX_SAFE_INTEGER);
    return { total, recovered: Math.max(recovered, verified), verified };
  }

  function budgetFor(mission) {
    const raw = mission?.budget;
    if (typeof raw === "number" || typeof raw === "string") {
      const total = finiteNumber(raw);
      return {
        total,
        spent: finiteNumber(mission?.spent),
        reward: finiteNumber(mission?.reward),
      };
    }
    const hasMinorUnits = raw && (
      raw.totalMinor !== undefined
      || raw.spentMinor !== undefined
      || raw.rewardMinor !== undefined
    );
    if (hasMinorUnits) {
      return {
        total: finiteNumber(raw.totalMinor) / 100,
        spent: finiteNumber(raw.spentMinor) / 100,
        reward: finiteNumber(raw.rewardMinor) / 100,
      };
    }
    return {
      total: finiteNumber(raw?.total ?? raw?.maximum ?? raw?.max ?? mission?.maximumBudget),
      spent: finiteNumber(raw?.spent ?? raw?.used ?? mission?.spent),
      reward: finiteNumber(raw?.reward ?? raw?.bounty ?? mission?.reward),
    };
  }

  function seedersFor(mission) {
    if (Array.isArray(mission?.seeders)) return mission.seeders.length;
    if (typeof mission?.seeders === "object" && mission?.seeders !== null) {
      return finiteNumber(mission.seeders.active ?? mission.seeders.count);
    }
    return Math.max(0, finiteNumber(mission?.seeders));
  }

  function availabilityFor(mission) {
    const availability = mission?.availability;
    if (typeof availability === "number") {
      return clamp(availability <= 1 && availability > 0 ? availability * 100 : availability, 0, 100);
    }
    if (typeof availability === "object" && availability !== null) {
      const value = finiteNumber(
        availability.percent ?? availability.percentage ?? availability.score ?? availability.value,
        Number.NaN,
      );
      if (Number.isFinite(value)) return clamp(value <= 1 && value > 0 ? value * 100 : value, 0, 100);
    }
    if (typeof availability === "string" && /^\d+(\.\d+)?%?$/.test(availability.trim())) {
      return clamp(finiteNumber(availability), 0, 100);
    }

    const pieces = piecesFor(mission);
    if (pieces.total > 0 && pieces.recovered > 0) return clamp((pieces.recovered / pieces.total) * 100, 0, 100);
    const stage = normalizeStage(mission);
    return stage === "RESEEDED" || stage === "VERIFIED" ? 100 : 0;
  }

  function missionProgress(mission) {
    const stageIndex = STAGES.indexOf(normalizeStage(mission));
    if (stageIndex === 2) {
      return clamp(38 + availabilityFor(mission) * 0.36, 38, 74);
    }
    return [0, 22, 54, 82, 100][Math.max(0, stageIndex)] ?? 0;
  }

  function activeMission() {
    return asArray(app.data.missions).find((mission) => String(mission.id) === String(app.selectedMissionId)) ?? null;
  }

  function applyState(payload) {
    const candidate = payload?.state?.missions ? payload.state : payload;
    if (!candidate || !Array.isArray(candidate.missions)) return false;

    app.data = {
      missions: candidate.missions,
      activeMissionId: candidate.activeMissionId ?? candidate.activeMission?.id ?? null,
      system: candidate.system ?? {},
    };

    const selectedStillExists = app.data.missions.some(
      (mission) => String(mission.id) === String(app.selectedMissionId),
    );
    if (!selectedStillExists) {
      const serverActiveExists = app.data.missions.some(
        (mission) => String(mission.id) === String(app.data.activeMissionId),
      );
      app.selectedMissionId = serverActiveExists
        ? app.data.activeMissionId
        : app.data.missions[0]?.id ?? null;
    }

    render();
    return true;
  }

  function render() {
    renderSystem();
    renderMissionNavigation();

    const mission = activeMission();
    const hasMission = Boolean(mission);
    elements.dashboard.hidden = !hasMission;
    elements.emptyState.hidden = hasMission;
    if (!mission) return;

    renderMissionHeader(mission);
    renderLifecycle(mission);
    renderMetrics(mission);
    renderPieceMap(mission);
    renderRails(mission);
    renderTimeline(mission);
    renderAudit(mission);
  }

  function resolveMissionCreationPolicy(system) {
    const integrations = asObject(system.integrations);
    const config = asObject(system.missionCreation ?? integrations.missionCreation);
    const budget = asObject(config.budget);
    const reward = asObject(config.reward ?? config.bounty);
    const minimumBudgetMinor = configuredMinor(1201, [
      config.minimumBudgetMinor,
      config.minBudgetMinor,
      budget.minimumMinor,
      budget.minMinor,
    ], [config.minimumBudget, config.minBudget, budget.minimum, budget.min]);
    const maximumBudgetMinor = Math.max(minimumBudgetMinor, configuredMinor(500000, [
      config.maximumBudgetMinor,
      config.maxBudgetMinor,
      budget.maximumMinor,
      budget.maxMinor,
    ], [config.maximumBudget, config.maxBudget, budget.maximum, budget.max]));
    const minimumRewardMinor = configuredMinor(100, [
      config.minimumRewardMinor,
      config.minRewardMinor,
      reward.minimumMinor,
      reward.minMinor,
    ], [config.minimumReward, config.minReward, reward.minimum, reward.min]);
    const maximumRewardMinor = Math.max(minimumRewardMinor, configuredMinor(100000, [
      config.maximumRewardMinor,
      config.maxRewardMinor,
      reward.maximumMinor,
      reward.maxMinor,
    ], [config.maximumReward, config.maxReward, reward.maximum, reward.max]));
    const available = config.available !== false && config.enabled !== false && config.ready !== false;
    return {
      minimumBudgetMinor,
      maximumBudgetMinor,
      minimumRewardMinor,
      maximumRewardMinor,
      available,
      unavailableReason: String(config.unavailableReason ?? config.message ?? "Mission creation is temporarily unavailable."),
    };
  }

  function configureMissionForm(system) {
    const policy = resolveMissionCreationPolicy(system);
    app.missionCreationPolicy = policy;
    const budgetHelp = $("#budget-help");
    const rewardHelp = $("#reward-help");
    elements.budgetInput.min = inputMoney(policy.minimumBudgetMinor);
    elements.budgetInput.max = inputMoney(policy.maximumBudgetMinor);
    elements.rewardInput.min = inputMoney(policy.minimumRewardMinor);
    elements.rewardInput.max = inputMoney(policy.maximumRewardMinor);
    budgetHelp.textContent = `Allowed range: ${displayMinor(policy.minimumBudgetMinor)}–${displayMinor(policy.maximumBudgetMinor)} for Rain/x402 archive access, discovery, and fees.`;
    rewardHelp.textContent = `Allowed range: ${displayMinor(policy.minimumRewardMinor)}–${displayMinor(policy.maximumRewardMinor)}. Released through the configured Monad rail after verification.`;
    if (!app.busy.has("create")) elements.createMissionButton.disabled = !policy.available;
    elements.createMissionButton.setAttribute("aria-disabled", String(!policy.available));
    elements.createMissionButton.title = policy.available ? "Create a bounded recovery mission" : policy.unavailableReason;
    elements.createMissionLabel.textContent = policy.available ? "Create secured mission" : "Mission creation unavailable";
    updateCostPreview();
  }

  function readinessItem(name, status, detail, tone) {
    return `
      <article class="readiness-item" data-tone="${escapeHtml(tone)}" title="${escapeHtml(`${name}: ${status}. ${detail}`)}">
        <span class="readiness-mark" aria-hidden="true"></span>
        <div><strong>${escapeHtml(name)}</strong><span>${escapeHtml(status)}</span><small>${escapeHtml(detail)}</small></div>
      </article>
    `;
  }

  function renderDeploymentReadiness(system, rawMode, network) {
    const integrations = asObject(system.integrations);
    const healthAdapters = asObject(app.health?.adapters);
    const rain = asObject(integrations.rain ?? system.rain ?? system.adapters?.rain);
    const rainHealth = asObject(healthAdapters.rain);
    const monad = asObject(integrations.monad ?? system.monad ?? system.adapters?.monad);
    const monadHealth = asObject(healthAdapters.monad);
    const monadNetwork = asObject(monadHealth.network);
    const x402 = asObject(integrations.x402 ?? system.x402 ?? system.adapters?.x402);
    const x402Health = asObject(healthAdapters.x402);

    const rainMode = String(rainHealth.mode ?? rain.mode ?? "local").toLowerCase();
    const rainExternal = rain.external === true || /sandbox|external/.test(rainMode) || /hybrid[_ -]?sandbox/.test(rawMode.toLowerCase());
    const rainChecked = Object.keys(rainHealth).length > 0;
    const rainReady = rainChecked ? rainHealth.ok === true : rain.ready !== false && rain.status !== "error";
    const rainAuthenticated = rainHealth.authenticated === true || rain.authenticated === true;
    const rainStatus = !rainReady
      ? "Sandbox unavailable"
      : rainExternal && rainAuthenticated
        ? "Sandbox authenticated"
        : rainExternal
          ? "Sandbox connected"
          : "Local adapter";
    const rainDetail = rainExternal
      ? "External sandbox card authority"
      : "No external card mutations";

    const monadWrites = monad.writesEnabled === true || monadHealth.writesEnabled === true;
    const probeConfigured = monadNetwork.configured === true || monad.rpcConfigured === true;
    const probePassed = monadNetwork.ok === true;
    const monadStatus = monadWrites
      ? "Testnet writes enabled"
      : probePassed
        ? "Network probe passed · read-only"
        : "Local ledger · read-only";
    const monadDetail = `${objectLabel(monadNetwork.caip2Network) ?? objectLabel(monad.network) ?? network}${probeConfigured && !probePassed ? " · probe unavailable" : ""}`;

    const x402Live = x402.liveSettlementEnabled === true || x402Health.liveSettlementEnabled === true;
    const facilitatorConfigured = x402Health.facilitatorConfigured === true || x402.facilitatorConfigured === true;
    const x402Status = x402Live ? "Testnet settlement enabled" : "Local settlement only";
    const x402Detail = facilitatorConfigured ? "Facilitator readiness configured" : "Machine handshake simulated locally";

    const needsAttention = !rainReady || app.missionCreationPolicy.available === false;
    elements.readinessStrip.dataset.state = needsAttention ? "attention" : rainExternal ? "sandbox" : "local";
    elements.readinessSummary.textContent = needsAttention
      ? "A required adapter needs attention before a mission can run."
      : rainExternal
        ? "Hybrid sandbox: Rain is external; Monad and x402 remain local/read-only."
        : "Local protocol sandbox: no production payment mutations are enabled.";
    elements.readinessItems.innerHTML = [
      readinessItem("Rain", rainStatus, rainDetail, !rainReady ? "attention" : rainExternal ? "sandbox" : "local"),
      readinessItem("Monad", monadStatus, monadDetail, monadWrites ? "testnet" : probePassed ? "ready" : "local"),
      readinessItem("x402", x402Status, x402Detail, x402Live ? "testnet" : "local"),
    ].join("");

    elements.footerPrimary.textContent = "Auditable recovery with bounded agent authority.";
    elements.footerRuntime.textContent = `${rainExternal ? "Rain sandbox" : "Rain local"} · ${monadWrites ? "Monad testnet writes" : "Monad local ledger / testnet read-only"} · ${x402Live ? "x402 testnet settlement" : "x402 local settlement"} · Authorized content only`;
    if (elements.runtimeFootnote) {
      elements.runtimeFootnote.innerHTML = rainExternal
        ? `${escapeHtml(rainStatus)}<br />Monad ${monadWrites ? "testnet writes enabled" : "local ledger · testnet read-only"}`
        : "Local protocol sandbox<br />No external payment mutations";
    }
  }

  function renderSystem() {
    const system = app.data.system ?? {};
    const rawMode = objectLabel(system.mode)
      ?? objectLabel(system.environment)
      ?? objectLabel(system.runtime?.mode)
      ?? "local";
    const mode = rawMode.toLowerCase().replace(/[\s_-]+/g, "_");
    const modeLabel = objectLabel(system.environmentLabel) ?? ({
      local: "Local protocol sandbox",
      sandbox: "Sandbox protocol",
      hybrid_sandbox: "Hybrid sandbox",
      testnet: "Testnet protocol",
      live: "Live protocol",
      production: "Production protocol",
    })[mode] ?? titleCase(rawMode);
    const explicitNetwork = objectLabel(system.network)
      ?? objectLabel(system.chain)
      ?? objectLabel(system.integrations?.monad?.network)
      ?? objectLabel(system.monad?.network)
      ?? objectLabel(system.adapters?.monad?.network)
      ?? objectLabel(system.monadNetwork);
    const network = explicitNetwork
      ?? (mode === "local" ? "Monad localnet" : /sandbox|testnet/.test(mode) ? "Monad testnet" : "Monad network");

    configureMissionForm(system);
    renderDeploymentReadiness(system, rawMode, network);
    elements.environmentLabel.textContent = modeLabel;
    elements.environmentPill.dataset.mode = mode;
    elements.environmentPill.title = `Runtime mode: ${rawMode}`;
    elements.networkLabel.textContent = network;
    elements.networkLabel.title = network;

    const stateHealthy = system.healthy !== false && system.status !== "error" && system.status !== "offline";
    const healthHealthy = app.health?.ok !== false;
    elements.protocolTitle.textContent = stateHealthy && healthHealthy ? "Runtime ready" : "Runtime attention needed";

    const orchestrator = titleCase(system.orchestrator?.status ?? system.orchestrator ?? "ready");
    const rails = finiteNumber(system.paymentRails?.online ?? system.railsOnline, 3);
    const railTotal = finiteNumber(system.paymentRails?.total ?? system.railsTotal, 3);
    const quorum = titleCase(system.verifiers?.status ?? system.quorum?.status ?? "online");
    elements.protocolList.innerHTML = `
      <div><dt>Orchestrator</dt><dd><i></i>${escapeHtml(orchestrator)}</dd></div>
      <div><dt>Configured rails</dt><dd><i></i>${rails} / ${railTotal}</dd></div>
      <div><dt>Verifier quorum</dt><dd><i></i>${escapeHtml(quorum)}</dd></div>
    `;
  }

  function renderMissionNavigation() {
    const missions = asArray(app.data.missions);
    elements.missionCount.textContent = String(missions.length);

    if (!missions.length) {
      elements.missionList.innerHTML = `
        <div class="audit-empty" style="min-height:70px;padding:12px">
          <strong>No missions yet</strong>
          <p>Create a bounded recovery mission to begin.</p>
        </div>
      `;
      return;
    }

    elements.missionList.innerHTML = missions.map((mission) => {
      const stage = normalizeStage(mission);
      const progress = Math.round(missionProgress(mission));
      const id = String(mission.id ?? "unknown");
      const selected = String(id) === String(app.selectedMissionId);
      return `
        <button
          class="mission-nav-item${selected ? " is-active" : ""}"
          type="button"
          data-mission-id="${escapeHtml(id)}"
          aria-current="${selected ? "page" : "false"}"
        >
          <span class="mission-nav-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24"><path d="M12 3 4 7v10l8 4 8-4V7l-8-4Z"></path><path d="m4 7 8 4 8-4M12 11v10"></path></svg>
          </span>
          <span class="mission-nav-copy">
            <strong>${escapeHtml(mission.title ?? "Untitled artifact")}</strong>
            <span title="${escapeHtml(mission.statusLabel ?? stage)}">${escapeHtml(mission.statusLabel ?? stage.toLowerCase())}</span>
          </span>
          <span class="mission-nav-progress" style="--mission-progress:${progress}%" aria-label="${progress}% complete">
            <span>${progress}</span>
          </span>
        </button>
      `;
    }).join("");
  }

  function renderMissionHeader(mission) {
    const stage = normalizeStage(mission);
    const id = String(mission.id ?? "—");
    const root = String(mission.contentRoot ?? mission.contentRootSha256 ?? mission.root ?? "Not committed");

    $("#mission-status").textContent = stage;
    $("#mission-status").dataset.stage = stage;
    $("#mission-id").textContent = `MISSION ${shorten(id, 6, 4)}`;
    $("#mission-title").textContent = String(mission.title ?? "Untitled recovery mission");
    $("#content-root").textContent = root;
    $("#content-root").title = root;
    $("#copy-root").disabled = !root || root === "Not committed";

    const terminal = ["COMPLETED", "COMPLETE"].includes(String(mission.status ?? "").toUpperCase());
    const authorityMission = asArray(app.data.missions).find((candidate) => {
      const card = asObject(candidate.rainCard);
      const state = String(card.state ?? "").toLowerCase();
      const expiry = Date.parse(card.expiresAt ?? "");
      return ["active", "expiry_scheduled"].includes(state) && Number.isFinite(expiry) && expiry > Date.now();
    });
    const resetButton = $("#reset-demo");
    $("#next-step").disabled = app.busy.size > 0 || terminal;
    $("#run-demo").disabled = app.busy.size > 0 || terminal;
    $("#blocked-purchase").disabled = app.busy.size > 0;
    resetButton.disabled = app.busy.size > 0 || Boolean(authorityMission);
    if (authorityMission) {
      const resetMessage = `Reset unavailable until the scoped Rain sandbox card expires ${formatInstant(authorityMission.rainCard.expiresAt)}.`;
      resetButton.title = resetMessage;
      resetButton.setAttribute("aria-label", resetMessage);
    } else {
      resetButton.title = "Reset demo";
      resetButton.setAttribute("aria-label", "Reset demo");
    }
    $("#run-demo").lastChild.textContent = terminal ? " Recovery complete" : " Run full recovery";
  }

  function renderLifecycle(mission) {
    const stage = normalizeStage(mission);
    const currentIndex = Math.max(0, STAGES.indexOf(stage));
    const track = $("#stage-track");
    track.style.setProperty("--stage-progress", String(currentIndex));
    $$("li", track).forEach((item, index) => {
      item.classList.toggle("is-complete", index < currentIndex || (currentIndex === STAGES.length - 1 && index === currentIndex));
      item.classList.toggle("is-current", index === currentIndex);
      if (index === currentIndex) item.setAttribute("aria-current", "step");
      else item.removeAttribute("aria-current");
    });

    $("#agent-state").textContent = mission.statusLabel ?? STAGE_COPY[stage] ?? "Mission state synchronized";
    $(".live-agent-chip").classList.toggle("is-active", stage !== "DEAD" && stage !== "RESEEDED");
  }

  function renderMetrics(mission) {
    const pieces = piecesFor(mission);
    const availability = Math.round(availabilityFor(mission));
    const seeders = seedersFor(mission);
    const budget = budgetFor(mission);
    const remaining = Math.max(0, budget.total - budget.spent);
    const stage = normalizeStage(mission);

    $("#availability-value").textContent = `${availability}%`;
    $("#availability-bar").style.width = `${availability}%`;
    $("#pieces-value").textContent = `${pieces.verified} / ${pieces.total}`;
    $("#pieces-detail").textContent = pieces.recovered > pieces.verified
      ? `${pieces.recovered - pieces.verified} awaiting verification`
      : pieces.total && pieces.verified === pieces.total
        ? "Root fully reconstructed"
        : "Awaiting recovery";
    $("#seeders-value").textContent = String(seeders);
    $("#seeders-detail").textContent = seeders > 1
      ? "Resilient mesh online"
      : seeders === 1
        ? "Single recovery source"
        : "Artifact offline";
    $("#budget-value").textContent = displayMoney(remaining);
    $("#budget-detail").textContent = `${displayMoney(budget.spent)} spent · ${displayMoney(budget.reward)} bounty`;

    if (stage === "RESEEDED") {
      $("#availability-value").textContent = "100%";
      $("#availability-bar").style.width = "100%";
    }
  }

  function renderPieceMap(mission) {
    const pieces = piecesFor(mission);
    const total = pieces.total || 16;
    const visualTotal = Math.min(total, 96);
    const recovered = pieces.total
      ? Math.round((pieces.recovered / pieces.total) * visualTotal)
      : 0;
    const verified = pieces.total
      ? Math.round((pieces.verified / pieces.total) * visualTotal)
      : 0;
    const columns = visualTotal <= 16 ? 8 : visualTotal <= 36 ? 9 : visualTotal <= 64 ? 8 : 12;
    const grid = $("#piece-grid");
    grid.style.setProperty("--piece-columns", String(columns));

    const cells = [];
    const bitmap = asArray(mission?.pieces?.bitmap);
    for (let index = 0; index < visualTotal; index += 1) {
      const bitmapEntry = bitmap.length
        ? bitmap[Math.min(bitmap.length - 1, Math.floor((index / visualTotal) * bitmap.length))]
        : null;
      const bitmapState = String(bitmapEntry?.state ?? "").toLowerCase();
      const isVerified = bitmapEntry ? bitmapState === "verified" : index < verified;
      const isRecovered = bitmapEntry
        ? !isVerified && bitmapState === "recovered"
        : !isVerified && index < recovered;
      const state = isVerified ? "Verified" : isRecovered ? "Recovered" : "Missing";
      const representedIndex = Math.floor((index / visualTotal) * total) + 1;
      cells.push(`
        <span
          class="piece${isVerified ? " is-verified" : isRecovered ? " is-recovered" : ""}"
          style="--piece-delay:${Math.min(index * 12, 360)}ms"
          title="Piece ${representedIndex}: ${state}"
          aria-hidden="true"
        ><span>${String(representedIndex).padStart(2, "0")}</span></span>
      `);
    }
    grid.innerHTML = cells.join("");

    const actualTotal = pieces.total;
    const percent = actualTotal ? Math.round((pieces.recovered / actualTotal) * 100) : 0;
    grid.setAttribute(
      "aria-label",
      `${pieces.recovered} of ${actualTotal} pieces recovered; ${pieces.verified} verified`,
    );
    $("#piece-progress-label").textContent = `${pieces.recovered} of ${actualTotal} pieces recovered`;
    $("#piece-progress-percent").textContent = `${percent}%`;
    $("#piece-progress").setAttribute("aria-valuenow", String(percent));
    $("#piece-progress-bar").style.width = `${percent}%`;
    $(".piece-map-glow").style.setProperty("--map-glow-opacity", String(percent / 180));
  }

  function recordSearch(record) {
    return [
      record?.rail,
      record?.provider,
      record?.network,
      record?.method,
      record?.type,
      record?.kind,
      record?.source,
      record?.id,
      record?.cardId,
      record?.receiptId,
      record?.operation,
    ].filter(Boolean).join(" ").toLowerCase();
  }

  function latestMatching(records, terms) {
    const list = asArray(records);
    const matches = list.filter((record) => {
      const haystack = recordSearch(record);
      return terms.some((term) => haystack.includes(term));
    });
    if (matches.length < 2) return matches[0] ?? null;
    return matches.reduce((latest, record) => recordTimestamp(record) > recordTimestamp(latest) ? record : latest);
  }

  function recordAmount(record) {
    if (record?.amountMinor !== undefined) return finiteNumber(record.amountMinor) / 100;
    return finiteNumber(
      record?.amountUsd ?? record?.amountUSD ?? record?.amount ?? record?.value ?? record?.total,
      0,
    );
  }

  function recordTimestamp(record) {
    const value = record?.timestamp ?? record?.checkedAt ?? record?.createdAt ?? record?.time;
    const parsed = value ? new Date(value).getTime() : 0;
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function recordReference(record) {
    return record?.txHash
      ?? record?.transactionHash
      ?? record?.transactionId
      ?? record?.receiptId
      ?? record?.receipt
      ?? record?.id
      ?? record?.reference
      ?? "No receipt";
  }

  function recordStatus(record, fallback) {
    return titleCase(record?.status ?? record?.state ?? record?.result ?? fallback);
  }

  function statusIsFailure(record) {
    return /block|declin|deni|fail|reject|error/.test(recordSearch({ type: record?.status ?? record?.state ?? record?.result }));
  }

  function renderRails(mission) {
    const payments = asArray(mission.payments);
    const transactions = asArray(mission.transactions);
    const allRecords = [...payments, ...transactions];
    const system = asObject(app.data.system);
    const healthAdapters = asObject(app.health?.adapters);
    const monadRuntime = asObject(system.monad ?? system.integrations?.monad ?? system.adapters?.monad);
    const x402Runtime = asObject(system.x402 ?? system.integrations?.x402 ?? system.adapters?.x402);
    const monadWrites = monadRuntime.writesEnabled === true || healthAdapters.monad?.writesEnabled === true;
    const x402Live = x402Runtime.liveSettlementEnabled === true || healthAdapters.x402?.liveSettlementEnabled === true;
    const rain = latestMatching(allRecords, ["rain", "card"]);
    const x402 = latestMatching(allRecords, ["x402"]);
    const monad = latestMatching(transactions, ["monad", "escrow", "contract", "chain"])
      ?? latestMatching(payments, ["monad", "escrow"]);
    const budget = budgetFor(mission);
    const stage = normalizeStage(mission);

    updateRail("rain", rain, {
      idleState: "Standby",
      activeState: "Card authorized",
      description: "Scoped card for legacy archive access",
      idleAmount: "$0.00 spent",
      amountSuffix: " spent",
      failedSuffix: " blocked",
    });
    const rainCardState = String(mission.rainCard?.state ?? "").trim().toLowerCase();
    if (rainCardState === "retired") {
      $("#rain-card").classList.remove("is-failed");
      $("#rain-state").textContent = "Card retired";
    } else if (rainCardState === "expiry_scheduled") {
      $("#rain-card").classList.add("is-active");
      $("#rain-card").classList.remove("is-failed");
      $("#rain-state").textContent = "Expiry scheduled";
      if (mission.rainCard?.expiresAt) {
        $("#rain-description").textContent = `Scoped card expires ${formatInstant(mission.rainCard.expiresAt)}`;
      }
    }
    updateRail("x402", x402, {
      idleState: stage === "DISCOVERING" ? "Buying discovery" : "Awaiting discovery",
      activeState: x402Live ? "Settled" : "Simulated locally",
      activeStateOverride: x402Live ? null : "Simulated locally",
      description: x402Live
        ? "Machine-native discovery micropayments"
        : "Local HTTP 402 handshake · no funds settled",
      idleAmount: x402Live ? "$0.00 settled" : "$0.00 simulated",
      amountSuffix: x402Live ? " settled" : " simulated",
    });

    const monadCard = $("#monad-card");
    const monadActive = Boolean(monad) || stage !== "DEAD";
    monadCard.classList.toggle("is-active", monadActive);
    $("#monad-state").textContent = monad
      ? monadWrites ? recordStatus(monad, "Confirmed") : "Simulated locally"
      : stage === "DEAD"
        ? monadWrites ? "Escrow ready" : "Local ledger ready"
        : monadWrites ? "Escrow funded" : "Local ledger funded";
    $("#monad-description").textContent = monad?.description ?? monad?.message ?? (monadWrites
      ? "Onchain bounty, collateral, and finality"
      : "Local bounty ledger · no blockchain writes");
    $("#monad-amount").textContent = `${displayMoney(budget.reward)} bounty`;
    $("#monad-reference").textContent = shorten(recordReference(monad) === "No receipt" ? (monadWrites ? "Monad network" : "Local simulation") : recordReference(monad), 9, 6);
    $("#monad-reference").title = String(recordReference(monad));
  }

  function updateRail(prefix, record, options) {
    const card = $(`#${prefix}-card`);
    const failed = record ? statusIsFailure(record) : false;
    card.classList.toggle("is-active", Boolean(record));
    card.classList.toggle("is-failed", failed);
    $(`#${prefix}-state`).textContent = record
      ? failed ? "Policy blocked" : options.activeStateOverride ?? recordStatus(record, options.activeState)
      : options.idleState;
    $(`#${prefix}-description`).textContent = record?.description ?? record?.message ?? options.description;
    $(`#${prefix}-amount`).textContent = record
      ? `${displayMoney(recordAmount(record))}${failed ? options.failedSuffix ?? options.amountSuffix : options.amountSuffix}`
      : options.idleAmount;
    const reference = recordReference(record);
    $(`#${prefix}-reference`).textContent = shorten(reference, 9, 5);
    $(`#${prefix}-reference`).title = String(reference);
  }

  function eventParts(event, index) {
    if (typeof event === "string") {
      return { title: "Agent update", description: event, time: `#${index + 1}`, category: eventCategory(event) };
    }
    const type = event?.type ?? event?.kind ?? event?.name ?? event?.status ?? "Agent update";
    const title = event?.title ?? titleCase(type);
    let description = event?.message ?? event?.description ?? event?.detail ?? event?.reason ?? "Mission state updated.";
    if (typeof description === "object") {
      try { description = JSON.stringify(description); } catch { description = "Structured mission event"; }
    }
    return {
      title,
      description,
      time: eventTime(event?.timestamp ?? event?.createdAt ?? event?.time, index),
      category: eventCategory(`${type} ${title} ${description}`),
    };
  }

  function eventTime(value, index) {
    if (!value) return `#${String(index + 1).padStart(2, "0")}`;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return shorten(value, 5, 0);
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  }

  function eventCategory(value) {
    const text = String(value).toLowerCase();
    if (/block|declin|deni|reject|fail/.test(text)) return "blocked";
    if (/verif|attest|quorum|proof|root/.test(text)) return "verified";
    if (/rain|card|payment|purchase|x402|quote|counter|offer|negotiat/.test(text)) return "payment";
    if (/monad|chain|escrow|contract|transaction|tx/.test(text)) return "chain";
    if (/piece|recover|seed|provider|download|discover/.test(text)) return "recovery";
    return "default";
  }

  function renderTimeline(mission) {
    const allEvents = asArray(mission.events);
    const events = [...allEvents]
      .sort((left, right) => {
        const leftTime = recordTimestamp(left);
        const rightTime = recordTimestamp(right);
        return leftTime && rightTime ? leftTime - rightTime : allEvents.indexOf(right) - allEvents.indexOf(left);
      })
      .slice(-14);
    const timeline = $("#timeline");
    if (!events.length) {
      timeline.innerHTML = `
        <div class="timeline-empty">
          <span class="tiny-spinner" aria-hidden="true"></span>
          Mission ready. Run the first autonomous step.
        </div>
      `;
      return;
    }

    timeline.innerHTML = events.map((event, index) => {
      const parts = eventParts(event, index);
      return `
        <article class="timeline-event is-${parts.category}" style="animation-delay:${Math.min(index * 24, 180)}ms">
          <span class="event-dot" aria-hidden="true"></span>
          <div class="event-copy">
            <strong>${escapeHtml(parts.title)}</strong>
            <p>${escapeHtml(parts.description)}</p>
          </div>
          <time class="event-time">${escapeHtml(parts.time)}</time>
        </article>
      `;
    }).join("");
    requestAnimationFrame(() => { timeline.scrollTop = timeline.scrollHeight; });
  }

  function renderAudit(mission) {
    $$("[data-audit-tab]").forEach((button) => {
      button.setAttribute("aria-selected", String(button.dataset.auditTab === app.auditTab));
      button.tabIndex = button.dataset.auditTab === app.auditTab ? 0 : -1;
    });
    $("#audit-content").setAttribute("aria-labelledby", `audit-tab-${app.auditTab}`);

    if (app.auditTab === "deal") renderDealAudit(mission);
    else if (app.auditTab === "verifiers") renderVerifierAudit(mission);
    else if (app.auditTab === "policy") renderPolicyAudit(mission);
    else renderReceiptAudit(mission);
  }

  function negotiationTranscript(negotiation, acceptedQuote) {
    const transcript = [];
    const offers = asArray(negotiation.offers);
    const initialAmount = firstMinor(
      negotiation.initialAmountMinor,
      offers[0]?.amountMinor,
      offers[0]?.priceMinor,
    );

    if (offers.length) {
      offers.forEach((offer, index) => {
        const amountMinor = firstMinor(offer?.amountMinor, offer?.priceMinor, index === 0 ? initialAmount : null);
        transcript.push({
          party: "merchant",
          speaker: offer?.merchantName ?? offer?.merchant?.name ?? `Merchant ${index + 1}`,
          message: index === 0 ? "Initial archival-egress offer" : "Alternative provider offer",
          amountMinor,
          timestamp: offer?.issuedAt ?? offer?.createdAt ?? offer?.timestamp,
        });
      });
    } else if (initialAmount !== null) {
      transcript.push({
        party: "merchant",
        speaker: acceptedQuote?.merchantName ?? "Merchant",
        message: "Initial archival-egress offer",
        amountMinor: initialAmount,
      });
    }

    asArray(negotiation.rounds).forEach((round, index) => {
      const buyerSource = round?.buyer && typeof round.buyer === "object"
        ? round.buyer
        : round?.counterOffer && typeof round.counterOffer === "object"
          ? round.counterOffer
          : {};
      const sellerCandidate = round?.seller ?? round?.merchantResponse ?? round?.response ?? round?.merchant;
      const sellerSource = sellerCandidate && typeof sellerCandidate === "object"
        ? sellerCandidate
        : { action: sellerCandidate };
      const roundNumber = round?.roundNumber ?? round?.number ?? round?.round ?? index + 1;
      const buyerAmount = firstMinor(
        buyerSource.amountMinor,
        buyerSource.priceMinor,
        round?.buyerAmountMinor,
        round?.counterAmountMinor,
        round?.offerAmountMinor,
      );
      const sellerAmount = firstMinor(
        sellerSource.amountMinor,
        sellerSource.priceMinor,
        round?.sellerAmountMinor,
        round?.merchantAmountMinor,
        round?.merchantCounterMinor,
        round?.resultingAmountMinor,
      );
      const sellerAction = sellerSource.action ?? sellerSource.status ?? round?.result ?? round?.status ?? "response";

      if (buyerAmount !== null) {
        transcript.push({
          party: "agent",
          speaker: "Recovery agent",
          message: `Round ${roundNumber} counter · ${titleCase(buyerSource.reasonCode ?? round?.reasonCode ?? "bounded policy")}`,
          amountMinor: buyerAmount,
          timestamp: buyerSource.timestamp ?? buyerSource.sentAt ?? round?.createdAt ?? round?.timestamp,
        });
      }
      if (sellerAmount !== null || sellerAction) {
        transcript.push({
          party: "merchant",
          speaker: sellerSource.merchantName ?? acceptedQuote?.merchantName ?? "Merchant",
          message: `Round ${roundNumber} · ${titleCase(sellerAction)}`,
          amountMinor: sellerAmount,
          timestamp: sellerSource.timestamp ?? sellerSource.respondedAt ?? round?.updatedAt,
        });
      }
    });

    if (acceptedQuote) {
      transcript.push({
        party: "policy",
        speaker: "Policy engine",
        message: "Binding quote accepted inside the approved envelope",
        amountMinor: firstMinor(acceptedQuote.amountMinor),
        timestamp: acceptedQuote.acceptedAt ?? negotiation.completedAt,
      });
    }
    return transcript;
  }

  function dealTermEntries(negotiation, acceptedQuote) {
    const quoteTerms = acceptedQuote?.terms;
    const fallbackTerms = negotiation?.policy?.requiredTerms ?? negotiation?.requiredTerms;
    const terms = quoteTerms && typeof quoteTerms === "object" && !Array.isArray(quoteTerms)
      ? quoteTerms
      : fallbackTerms && typeof fallbackTerms === "object" && !Array.isArray(fallbackTerms)
        ? fallbackTerms
        : {};
    const entries = Object.entries(terms).map(([key, value]) => [titleCase(key), value]);
    const extraTerms = [
      ["Purpose", acceptedQuote?.purpose],
      ["Merchant category", acceptedQuote?.mcc ? `MCC ${acceptedQuote.mcc}` : null],
      ["Currency", acceptedQuote?.currency],
    ];
    for (const [label, value] of extraTerms) {
      if (value !== undefined && value !== null && value !== "" && !entries.some(([key]) => key === label)) {
        entries.push([label, value]);
      }
    }
    return entries;
  }

  function displayTerm(value) {
    if (typeof value === "boolean") return value ? "Yes" : "No";
    if (Array.isArray(value)) return value.map(titleCase).join(" · ");
    if (value && typeof value === "object") {
      return Object.entries(value).map(([key, item]) => `${titleCase(key)}: ${displayTerm(item)}`).join(" · ");
    }
    return titleCase(value ?? "Specified");
  }

  function renderDealAudit(mission) {
    const negotiation = mission.negotiation;
    const content = $("#audit-content");
    if (!negotiation || typeof negotiation !== "object") {
      content.innerHTML = auditEmpty(
        "No merchant session yet",
        "The bounded offer and counteroffer transcript appears after availability discovery.",
      );
      return;
    }

    const offers = asArray(negotiation.offers);
    const rounds = asArray(negotiation.rounds);
    const quote = negotiation.acceptedQuote ?? negotiation.proposedQuote ?? null;
    const askMinor = firstMinor(
      negotiation.initialAmountMinor,
      offers[0]?.amountMinor,
      offers[0]?.priceMinor,
      negotiation.maximumAmountMinor,
    );
    const acceptedMinor = firstMinor(
      quote?.amountMinor,
      negotiation.acceptedAmountMinor,
      negotiation.finalAmountMinor,
    );
    const savingsMinor = acceptedMinor === null ? null : firstMinor(
      negotiation.savingsMinor,
      askMinor !== null ? Math.max(0, askMinor - acceptedMinor) : null,
    );
    const savingsBps = acceptedMinor === null ? null : firstMinor(
      negotiation.savingsBps,
      askMinor && savingsMinor !== null ? Math.round((savingsMinor / askMinor) * 10_000) : null,
    );
    const savingsPercent = savingsBps === null
      ? "—"
      : `${(savingsBps / 100).toFixed(savingsBps % 100 === 0 ? 0 : 2)}%`;
    const status = String(negotiation.status ?? negotiation.state ?? (quote ? "accepted" : "pending"));
    const failed = /fail|reject|declin|expired/.test(status.toLowerCase());
    const pending = !failed && !/accept|consum|complete/.test(status.toLowerCase());
    const maximumRounds = firstMinor(
      negotiation.maximumRounds,
      negotiation.policy?.maximumRounds,
      negotiation.policy?.maxRounds,
    );
    const merchantName = quote?.merchantName
      ?? quote?.merchant?.name
      ?? offers[0]?.merchantName
      ?? offers[0]?.merchant?.name
      ?? "Awaiting merchant";
    const transcript = negotiationTranscript(negotiation, quote);
    const terms = dealTermEntries(negotiation, quote);
    const decision = negotiation.decision && typeof negotiation.decision === "object"
      ? negotiation.decision.code ?? negotiation.decision.reasonCode ?? negotiation.decision.status
      : negotiation.decision;
    const sessionId = negotiation.sessionId ?? "Not opened";
    const quoteId = quote?.quoteId ?? "Not issued";

    const transcriptHtml = transcript.length
      ? `<ol class="deal-transcript" aria-label="Merchant offer transcript">${transcript.map((entry) => `
          <li class="deal-transcript-entry is-${escapeHtml(entry.party)}">
            <span class="deal-speaker"><i aria-hidden="true"></i>${escapeHtml(entry.speaker)}</span>
            <span class="deal-message">${escapeHtml(entry.message)}</span>
            <strong>${displayMinor(entry.amountMinor)}</strong>
          </li>
        `).join("")}</ol>`
      : `<p class="deal-placeholder">No offers have been recorded.</p>`;
    const termsHtml = terms.length
      ? `<dl class="deal-terms">${terms.map(([label, value]) => `
          <div><dt>${escapeHtml(label)}</dt><dd title="${escapeHtml(displayTerm(value))}">${escapeHtml(displayTerm(value))}</dd></div>
        `).join("")}</dl>`
      : `<p class="deal-placeholder">Exact checkout terms are pending.</p>`;

    content.innerHTML = `
      <div class="deal-audit">
        <section class="deal-summary" aria-label="Negotiated deal summary">
          <div class="deal-status-row">
            <span>Merchant session</span>
            <em class="audit-state${failed ? " is-blocked" : pending ? " is-pending" : ""}">${escapeHtml(titleCase(status))}</em>
          </div>
          <div class="deal-price-flow" aria-label="Initial ask ${escapeHtml(displayMinor(askMinor))}, accepted amount ${escapeHtml(displayMinor(acceptedMinor))}, savings ${escapeHtml(displayMinor(savingsMinor))} or ${escapeHtml(savingsPercent)}">
            <div><small>Initial ask</small><strong>${displayMinor(askMinor)}</strong></div>
            <span class="deal-arrow" aria-hidden="true">→</span>
            <div class="is-accepted"><small>Accepted</small><strong>${displayMinor(acceptedMinor)}</strong></div>
            <div class="deal-savings"><small>Savings</small><strong>${displayMinor(savingsMinor)} <span>· ${escapeHtml(savingsPercent)}</span></strong></div>
          </div>
          <dl class="deal-meta">
            <div><dt>Merchant</dt><dd>${escapeHtml(merchantName)}</dd></div>
            <div><dt>Rounds</dt><dd>${rounds.length}${maximumRounds === null ? "" : ` / ${maximumRounds}`}</dd></div>
            <div><dt>Session</dt><dd title="${escapeHtml(sessionId)}">${escapeHtml(shorten(sessionId, 9, 6))}</dd></div>
            <div><dt>Quote</dt><dd title="${escapeHtml(quoteId)}">${escapeHtml(shorten(quoteId, 9, 6))}</dd></div>
            <div><dt>Expires</dt><dd>${escapeHtml(formatInstant(quote?.expiresAt, "Pending"))}</dd></div>
            <div><dt>Decision</dt><dd>${escapeHtml(titleCase(decision ?? (quote ? "policy approved" : "pending")))}</dd></div>
          </dl>
        </section>
        <section class="deal-section" aria-labelledby="deal-transcript-heading">
          <div class="deal-section-heading"><strong id="deal-transcript-heading">Offer transcript</strong><span>${transcript.length} entries</span></div>
          ${transcriptHtml}
        </section>
        <section class="deal-section" aria-labelledby="deal-terms-heading">
          <div class="deal-section-heading"><strong id="deal-terms-heading">Exact terms</strong><span>Binding quote</span></div>
          ${termsHtml}
        </section>
      </div>
    `;
  }

  function renderReceiptAudit(mission) {
    const payments = asArray(mission.payments).map((record) => ({ ...record, __origin: "Payment" }));
    const transactions = asArray(mission.transactions).map((record) => ({ ...record, __origin: "Transaction" }));
    const records = [...payments, ...transactions]
      .sort((left, right) => recordTimestamp(right) - recordTimestamp(left))
      .slice(0, 7);
    const content = $("#audit-content");

    if (!records.length) {
      content.innerHTML = auditEmpty(
        "No receipts issued",
        "Payment and onchain receipts appear here as the agent executes the mission.",
      );
      return;
    }

    const system = asObject(app.data.system);
    const healthAdapters = asObject(app.health?.adapters);
    const monadRuntime = asObject(system.monad ?? system.integrations?.monad ?? system.adapters?.monad);
    const x402Runtime = asObject(system.x402 ?? system.integrations?.x402 ?? system.adapters?.x402);
    const monadWrites = monadRuntime.writesEnabled === true || healthAdapters.monad?.writesEnabled === true;
    const x402Live = x402Runtime.liveSettlementEnabled === true || healthAdapters.x402?.liveSettlementEnabled === true;

    content.innerHTML = `<dl class="audit-list">${records.map((record) => {
      const recordText = recordSearch(record);
      const isX402 = /x402/.test(recordText);
      const isMonad = /monad|escrow|contract|chain/.test(recordText);
      const locallySimulated = (isX402 && !x402Live) || (isMonad && !monadWrites);
      const label = locallySimulated
        ? isX402 ? "x402 local simulation" : "Monad local ledger"
        : titleCase(record.rail ?? record.provider ?? record.type ?? record.__origin);
      const reference = recordReference(record);
      const failed = statusIsFailure(record);
      const reportedStatus = recordStatus(record, failed ? "Blocked" : "Confirmed");
      const pending = /pending|created|requested|processing/i.test(reportedStatus);
      const status = locallySimulated && !failed && !pending ? "Simulated" : reportedStatus;
      return `
        <div class="audit-row">
          <dt>${escapeHtml(label)}</dt>
          <dd title="${escapeHtml(reference)}">${escapeHtml(shorten(reference, 13, 8))}</dd>
          <em class="audit-state${failed ? " is-blocked" : pending ? " is-pending" : ""}">${escapeHtml(status)}</em>
        </div>
      `;
    }).join("")}</dl>`;
  }

  function renderVerifierAudit(mission) {
    const verifiers = asArray(mission.verifiers);
    const content = $("#audit-content");
    if (!verifiers.length) {
      content.innerHTML = auditEmpty(
        "Quorum awaiting assignment",
        "Independent verifier agents will challenge pieces and attest to the content root.",
      );
      return;
    }

    content.innerHTML = `<div class="verifier-list">${verifiers.map((verifier, index) => {
      const value = typeof verifier === "string" ? { address: verifier } : verifier ?? {};
      const name = value.name ?? value.agent ?? value.id ?? `Verifier ${index + 1}`;
      const identity = value.address ?? value.identity ?? value.did ?? value.publicKey ?? "Local agent";
      const status = titleCase(value.status ?? value.state ?? (value.verified || value.attested ? "attested" : "ready"));
      const passed = /attest|verified|pass|complete|signed|ready/i.test(status);
      return `
        <div class="verifier-row">
          <span class="verifier-avatar" aria-hidden="true">V${index + 1}</span>
          <span class="verifier-copy"><strong>${escapeHtml(name)}</strong><span title="${escapeHtml(identity)}">${escapeHtml(shorten(identity, 12, 7))}</span></span>
          <em class="audit-state${passed ? "" : " is-pending"}">${escapeHtml(status)}</em>
        </div>
      `;
    }).join("")}</div>`;
  }

  function renderPolicyAudit(mission) {
    const policy = mission.policy && typeof mission.policy === "object" ? mission.policy : {};
    const budget = budgetFor(mission);
    const rows = [
      ["Rights basis", policy.license ?? policy.rightsBasis ?? policy.licenseClass ?? "Authorized content"],
      ["Rights attestation", policy.rightsAttested ?? policy.rightsConfirmed ?? mission.rightsConfirmed ?? true ? "Present" : "Required"],
      ["Maximum exposure", displayMoney(policy.maxSpend ?? policy.maximumAmount ?? budget.total)],
      ["Allowed rails", policy.allowedRails ?? ["Rain", "Monad", "x402"]],
      ["Merchant scope", policy.allowedMerchants ?? policy.allowedMerchantIds ?? "Approved archives only"],
      ["Card lifecycle", policy.cardLifecycle ?? "Single use · auto-freeze"],
      ["Content root", shorten(mission.contentRoot ?? mission.contentRootSha256 ?? "Not committed", 13, 8)],
    ];
    $("#audit-content").innerHTML = `<dl class="policy-list">${rows.map(([key, rawValue]) => {
      const value = Array.isArray(rawValue) ? rawValue.join(" · ") : rawValue;
      return `<div><dt>${escapeHtml(key)}</dt><dd title="${escapeHtml(value)}">${escapeHtml(value)}</dd></div>`;
    }).join("")}</dl>`;
  }

  function auditEmpty(title, description) {
    return `
      <div class="audit-empty">
        <span class="audit-empty-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24"><path d="M5 3h10l4 4v14H5V3Z"></path><path d="M15 3v5h5M8 13h8M8 17h5"></path></svg>
        </span>
        <strong>${escapeHtml(title)}</strong>
        <p>${escapeHtml(description)}</p>
      </div>
    `;
  }

  function setConnection(state, label) {
    elements.connectionChip.dataset.state = state;
    elements.connectionLabel.textContent = label;
    elements.connectionChip.setAttribute("aria-label", `Application sync: ${label.toLowerCase()}`);
  }

  async function parseResponse(response) {
    if (response.status === 204) return null;
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) return response.json();
    const text = await response.text();
    if (!text) return null;
    try { return JSON.parse(text); } catch { return { message: text }; }
  }

  async function request(path, options = {}) {
    const response = await fetch(path, {
      cache: "no-store",
      credentials: "same-origin",
      ...options,
      headers: {
        Accept: "application/json",
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...(options.headers ?? {}),
      },
    });
    const payload = await parseResponse(response);
    if (!response.ok) {
      const error = new Error(payload?.message ?? payload?.error ?? `Request failed (${response.status})`);
      error.status = response.status;
      error.payload = payload;
      throw error;
    }
    return payload;
  }

  async function loadHealth({ force = false } = {}) {
    const checkedRecently = app.healthCheckedAt && Date.now() - app.healthCheckedAt < 15_000;
    if ((!force && checkedRecently) || app.healthRequest) return app.healthRequest;
    app.healthRequest = (async () => {
      try {
        const response = await fetch("/api/health", {
          cache: "no-store",
          credentials: "same-origin",
          headers: { Accept: "application/json" },
        });
        const payload = await parseResponse(response);
        app.health = payload && typeof payload === "object"
          ? { ...payload, httpStatus: response.status }
          : { ok: false, unavailable: true, httpStatus: response.status };
      } catch (error) {
        app.health = {
          ok: false,
          unavailable: true,
          message: error?.message || "Health check unavailable",
        };
      } finally {
        app.healthCheckedAt = Date.now();
        app.healthRequest = null;
        renderSystem();
      }
      return app.health;
    })();
    return app.healthRequest;
  }

  async function loadState({ quiet = false } = {}) {
    if (!quiet) setConnection("connecting", "Syncing");
    try {
      const payload = await request("/api/state");
      if (!applyState(payload)) throw new Error("The state response was not recognized.");
      setConnection("online", "Sync connected");
      app.hasShownConnectionError = false;
      return true;
    } catch (error) {
      setConnection("offline", "Offline");
      if (!quiet || !app.hasShownConnectionError) {
        showToast("Service unavailable", error.message, "error", 6000);
        app.hasShownConnectionError = true;
      }
      if (!app.data.missions.length) render();
      return false;
    }
  }

  function setButtonBusy(button, busy) {
    if (!button) return;
    button.classList.toggle("is-busy", busy);
    button.dataset.busy = String(busy);
    const creationUnavailable = button === elements.createMissionButton && !app.missionCreationPolicy.available;
    button.disabled = busy || creationUnavailable;
    button.setAttribute("aria-busy", String(busy));
    if (button === elements.createMissionButton) {
      button.setAttribute("aria-disabled", String(busy || creationUnavailable));
      elements.createMissionLabel.textContent = busy
        ? "Creating mission…"
        : creationUnavailable
          ? "Mission creation unavailable"
          : "Create secured mission";
    }
  }

  async function runMissionAction(action, button, successTitle) {
    const mission = activeMission();
    if (!mission || app.busy.size) return;
    const id = encodeURIComponent(String(mission.id));
    const actionKey = `${id}:${action}`;
    app.busy.add(actionKey);
    setButtonBusy(button, true);
    renderMissionHeader(mission);
    try {
      const payload = await request(`/api/missions/${id}/${action}`, { method: "POST" });
      if (!applyState(payload)) await loadState({ quiet: true });
      showToast(successTitle, action === "blocked-purchase"
        ? "Rain policy rejected the out-of-scope purchase as designed."
        : "Mission state synchronized with the recovery orchestrator.");
    } catch (error) {
      showToast("Mission action failed", error.message, "error", 6000);
    } finally {
      app.busy.delete(actionKey);
      setButtonBusy(button, false);
      const current = activeMission();
      if (current) renderMissionHeader(current);
    }
  }

  async function resetDemo() {
    if (app.busy.size) return;
    const button = $("#reset-demo");
    app.busy.add("reset");
    setButtonBusy(button, true);
    try {
      const payload = await request("/api/demo/reset", { method: "POST" });
      app.selectedMissionId = null;
      if (!applyState(payload)) await loadState({ quiet: true });
      showToast("Demo reset", "The recovery sandbox is back at its initial dead-artifact state.");
      announce("Recovery demo reset");
    } catch (error) {
      showToast("Reset failed", error.message, "error", 6000);
    } finally {
      app.busy.delete("reset");
      setButtonBusy(button, false);
      render();
    }
  }

  function updateCostPreview() {
    if (!elements.budgetInput || !elements.rewardInput) return;
    const total = Math.max(0, finiteNumber(elements.budgetInput.value));
    const reward = Math.max(0, finiteNumber(elements.rewardInput.value));
    const maximumExposure = total + reward;
    elements.costTotal.textContent = displayMoney(maximumExposure);
    elements.costReward.textContent = displayMoney(reward);
    elements.costReserve.textContent = `Up to ${displayMoney(total)}`;
  }

  function fieldElement(name) {
    return elements.missionForm.elements.namedItem(name);
  }

  function fieldErrorElement(name) {
    return $(`#${name === "rightsConfirmed" ? "rights" : name}-error`);
  }

  function clearFieldError(name) {
    const field = fieldElement(name);
    const message = fieldErrorElement(name);
    field?.removeAttribute("aria-invalid");
    if (message) {
      message.textContent = "";
      message.hidden = true;
    }
  }

  function setFieldError(name, message) {
    const field = fieldElement(name);
    const errorElement = fieldErrorElement(name);
    field?.setAttribute("aria-invalid", "true");
    if (errorElement) {
      errorElement.textContent = message;
      errorElement.hidden = false;
    }
  }

  function clearMissionFormError() {
    elements.missionFormError.hidden = true;
    elements.missionFormErrorTitle.textContent = "Mission needs attention";
    elements.missionFormErrorMessage.textContent = "";
  }

  function showMissionFormError(message, { title = "Mission needs attention", focus = false } = {}) {
    elements.missionFormErrorTitle.textContent = title;
    elements.missionFormErrorMessage.textContent = message;
    elements.missionFormError.hidden = false;
    if (focus) elements.missionFormError.focus({ preventScroll: false });
  }

  function clearMissionValidation() {
    ["title", "budget", "reward", "rightsConfirmed"].forEach(clearFieldError);
    clearMissionFormError();
  }

  function validateMissionForm() {
    clearMissionValidation();
    const policy = app.missionCreationPolicy;
    if (!policy.available) {
      showMissionFormError(policy.unavailableReason, { title: "Mission creation unavailable", focus: true });
      return null;
    }

    const formData = new FormData(elements.missionForm);
    const title = String(formData.get("title") ?? "").trim();
    const budgetValue = Number(formData.get("budget"));
    const rewardValue = Number(formData.get("reward"));
    const budgetMinor = Number.isFinite(budgetValue) ? Math.round(budgetValue * 100) : Number.NaN;
    const rewardMinor = Number.isFinite(rewardValue) ? Math.round(rewardValue * 100) : Number.NaN;
    const rightsConfirmed = formData.get("rightsConfirmed") === "on";
    const issues = [];

    if (!title) issues.push(["title", "Enter a short, recognizable artifact title."]);
    if (!Number.isSafeInteger(budgetMinor)) {
      issues.push(["budget", "Enter a valid mission budget in USD."]);
    } else if (Math.abs(budgetValue * 100 - budgetMinor) > 0.0001) {
      issues.push(["budget", "Use no more than two decimal places for USD."]);
    } else if (budgetMinor < policy.minimumBudgetMinor || budgetMinor > policy.maximumBudgetMinor) {
      issues.push(["budget", `Budget must be between ${displayMinor(policy.minimumBudgetMinor)} and ${displayMinor(policy.maximumBudgetMinor)}.`]);
    }
    if (!Number.isSafeInteger(rewardMinor)) {
      issues.push(["reward", "Enter a valid recovery bounty in USD."]);
    } else if (Math.abs(rewardValue * 100 - rewardMinor) > 0.0001) {
      issues.push(["reward", "Use no more than two decimal places for USD."]);
    } else if (rewardMinor < policy.minimumRewardMinor || rewardMinor > policy.maximumRewardMinor) {
      issues.push(["reward", `Recovery bounty must be between ${displayMinor(policy.minimumRewardMinor)} and ${displayMinor(policy.maximumRewardMinor)}.`]);
    }
    if (!rightsConfirmed) issues.push(["rightsConfirmed", "Confirm that you have the right to recover and reseed this artifact."]);

    if (issues.length) {
      issues.forEach(([name, message]) => setFieldError(name, message));
      showMissionFormError(`Review ${issues.length} ${issues.length === 1 ? "field" : "fields"} below and try again.`, {
        title: "Review mission details",
      });
      fieldElement(issues[0][0])?.focus({ preventScroll: false });
      return null;
    }

    return {
      formData,
      title,
      totalBudget: budgetMinor / 100,
      reward: rewardMinor / 100,
      budgetMinor,
      rewardMinor,
      rightsConfirmed,
    };
  }

  function missionCreationIssue(error) {
    const payload = asObject(error?.payload);
    const errorObject = asObject(payload.error);
    const rawError = typeof payload.error === "string" ? payload.error : "";
    const code = String(payload.code ?? errorObject.code ?? rawError ?? "").toUpperCase();
    const serverMessage = typeof payload.message === "string" && payload.message.trim()
      ? payload.message.trim()
      : typeof errorObject.message === "string" && errorObject.message.trim()
        ? errorObject.message.trim()
        : "";
    const explicitField = payload.field ?? errorObject.field;
    if (serverMessage) return { message: serverMessage, field: explicitField || null };
    if (/RIGHTS.*ATTESTATION|RIGHTS.*REQUIRED/.test(code)) {
      return { field: "rightsConfirmed", message: "Confirm that you have the right to recover and reseed this artifact." };
    }
    if (/MINIMUM.*BUDGET|BUDGET.*MINIMUM|BUDGET.*BELOW/.test(code)) {
      return { field: "budget", message: `Mission budget must be at least ${displayMinor(app.missionCreationPolicy.minimumBudgetMinor)}.` };
    }
    if (/MAXIMUM.*BUDGET|BUDGET.*MAXIMUM|BUDGET.*ABOVE/.test(code)) {
      return { field: "budget", message: `Mission budget cannot exceed ${displayMinor(app.missionCreationPolicy.maximumBudgetMinor)}.` };
    }
    if (error?.status === 403) {
      return { field: null, message: "This request was blocked by the local security policy. Reload the app from its server URL and retry." };
    }
    if (error?.status === 413) return { field: null, message: "The mission request was too large. Reduce the submitted metadata and retry." };
    if (error?.status === 503) return { field: null, message: "Mission services are temporarily unavailable. Check deployment readiness and retry." };
    if (/FAILED TO FETCH|NETWORKERROR|LOAD FAILED/.test(String(error?.message ?? "").toUpperCase())) {
      return { field: null, message: "The server connection was interrupted. Your entries are preserved; reconnect and retry." };
    }
    return {
      field: explicitField || null,
      message: code && !/^[A-Z0-9_]+$/.test(code)
        ? code
        : "The server could not accept this mission. Your entries are preserved; review deployment readiness and retry.",
    };
  }

  async function createMission(event) {
    event.preventDefault();
    if (app.busy.size) return;
    const values = validateMissionForm();
    if (!values) return;

    const pieceCount = Math.round(finiteNumber(values.formData.get("pieceCount"), 24));
    const license = String(values.formData.get("license") ?? "CC0-1.0");
    const environment = objectLabel(app.data.system?.mode) ?? "local";
    const payload = {
      title: values.title,
      contentRoot: String(values.formData.get("contentRoot") ?? "").trim(),
      pieceCount,
      totalPieces: pieceCount,
      pieces: { total: pieceCount, recovered: 0, verified: 0 },
      budget: { total: values.totalBudget, spent: 0, reward: values.reward },
      reward: values.reward,
      license,
      rightsConfirmed: values.rightsConfirmed,
      rightsAttestation: values.rightsConfirmed,
      rewardMinor: values.rewardMinor,
      totalBudgetMinor: values.budgetMinor,
      policy: {
        license,
        rightsBasis: license,
        rightsAttested: values.rightsConfirmed,
        allowedRails: ["rain", "monad", "x402"],
        allowedMerchants: ["approved-archives", "approved-storage"],
        maxSpend: values.totalBudget,
        maximumAmount: values.totalBudget,
        currency: "USD",
        cardLifecycle: "single-use-auto-freeze",
        environment,
      },
    };

    const button = elements.createMissionButton;
    app.busy.add("create");
    setButtonBusy(button, true);
    try {
      const response = await request("/api/missions", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      const newId = response?.mission?.id ?? response?.id ?? response?.activeMissionId;
      if (newId !== undefined) app.selectedMissionId = newId;
      if (!applyState(response)) await loadState({ quiet: true });
      if (newId !== undefined) app.selectedMissionId = newId;
      render();
      closeMissionDialog();
      elements.missionForm.reset();
      clearMissionValidation();
      updateCostPreview();
      showToast("Mission secured", "Artifact commitment accepted. The bounded recovery budget is ready.");
      announce("New recovery mission created");
    } catch (error) {
      const issue = missionCreationIssue(error);
      if (issue.field && fieldElement(issue.field)) setFieldError(issue.field, issue.message);
      showMissionFormError(issue.message, { title: "Mission could not be created", focus: !issue.field });
      if (issue.field) fieldElement(issue.field)?.focus({ preventScroll: false });
      showToast("Mission needs attention", "Your entries are preserved in the mission form.", "warning", 5000);
    } finally {
      app.busy.delete("create");
      setButtonBusy(button, false);
      const current = activeMission();
      if (current) renderMissionHeader(current);
    }
  }

  function queueRefresh() {
    window.clearTimeout(app.refreshTimer);
    app.refreshTimer = window.setTimeout(() => loadState({ quiet: true }), 80);
  }

  function handleStreamPayload(raw) {
    if (!raw) return queueRefresh();
    let payload;
    try { payload = JSON.parse(raw); } catch { return queueRefresh(); }
    if (applyState(payload)) return;
    if (payload?.state && applyState(payload.state)) return;
    queueRefresh();
  }

  function connectEventStream() {
    if (app.data.system?.deployment?.eventTransport === "polling") {
      app.eventSource?.close();
      app.eventSource = null;
      startPolling();
      setConnection("online", "Polling every 5 seconds");
      loadHealth();
      return;
    }
    if (!("EventSource" in window)) {
      startPolling();
      return;
    }
    if (app.eventSource) app.eventSource.close();

    const stream = new EventSource("/api/events");
    app.eventSource = stream;
    stream.onopen = () => {
      setConnection("online", "Sync connected");
      loadHealth();
    };
    stream.onmessage = (event) => handleStreamPayload(event.data);
    ["state", "mission", "mission-update", "payment", "recovery", "audit", "reset"].forEach((eventName) => {
      stream.addEventListener(eventName, (event) => handleStreamPayload(event.data));
    });
    stream.onerror = () => {
      setConnection("connecting", "Reconnecting");
      startPolling();
    };
  }

  function startPolling() {
    if (app.pollingTimer) return;
    app.pollingTimer = window.setInterval(() => loadState({ quiet: true }), 5000);
  }

  function openMissionDialog() {
    const mission = activeMission();
    const rootInput = $("[name='contentRoot']", elements.dialog);
    if (rootInput) {
      const configuredRoot = app.data.system?.missionCreation?.contentRoot
        ?? app.data.system?.fixture?.contentRoot
        ?? "";
      if (!rootInput.value) {
        rootInput.value = String(mission?.contentRoot ?? mission?.contentRootSha256 ?? configuredRoot);
      }
    }
    configureMissionForm(app.data.system ?? {});
    updateCostPreview();
    if (typeof elements.dialog.showModal === "function") elements.dialog.showModal();
    else elements.dialog.setAttribute("open", "");
    if (!app.missionCreationPolicy.available) {
      showMissionFormError(app.missionCreationPolicy.unavailableReason, { title: "Mission creation unavailable" });
    }
    window.setTimeout(() => $("[name='title']", elements.dialog)?.focus(), 50);
  }

  function closeMissionDialog() {
    if (typeof elements.dialog.close === "function" && elements.dialog.open) elements.dialog.close();
    else elements.dialog.removeAttribute("open");
  }

  async function copyContentRoot() {
    const root = $("#content-root").textContent;
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(root);
      else {
        const area = document.createElement("textarea");
        area.value = root;
        area.style.position = "fixed";
        area.style.opacity = "0";
        document.body.append(area);
        area.select();
        document.execCommand("copy");
        area.remove();
      }
      showToast("Content root copied", shorten(root, 16, 10));
    } catch {
      showToast("Copy unavailable", "Select the content root and copy it manually.", "warning");
    }
  }

  function exportAudit() {
    const mission = activeMission();
    if (!mission) return;
    const id = encodeURIComponent(String(mission.id));
    const link = document.createElement("a");
    link.href = `/api/missions/${id}/export`;
    link.download = `${mission.id}-audit.json`;
    document.body.append(link);
    link.click();
    link.remove();
    showToast("Audit exported", "Mission receipts, policy decisions, and verification proofs saved as JSON.");
  }

  function showToast(title, message, type = "success", duration = 4000) {
    const existing = Array.from(elements.toastRegion.querySelectorAll(".toast"));
    while (existing.length >= 3) existing.shift().remove();
    const toast = document.createElement("div");
    toast.className = `toast${type !== "success" ? ` is-${type}` : ""}`;
    toast.setAttribute("role", type === "error" ? "alert" : "status");
    toast.innerHTML = `
      <span class="toast-icon" aria-hidden="true">${type === "error" ? "!" : type === "warning" ? "i" : "✓"}</span>
      <span class="toast-copy"><strong>${escapeHtml(title)}</strong><span>${escapeHtml(message)}</span></span>
      <button class="toast-close" type="button" aria-label="Dismiss notification">×</button>
    `;
    const remove = () => {
      if (!toast.isConnected) return;
      toast.classList.add("is-leaving");
      window.setTimeout(() => toast.remove(), 210);
    };
    $(".toast-close", toast).addEventListener("click", remove);
    elements.toastRegion.append(toast);
    window.setTimeout(remove, duration);
  }

  function announce(message) {
    elements.srStatus.textContent = "";
    window.setTimeout(() => { elements.srStatus.textContent = message; }, 20);
  }

  function applyTheme(theme) {
    const next = theme === "light" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    elements.themeToggle.setAttribute("aria-label", `Switch to ${next === "dark" ? "light" : "dark"} theme`);
    try { localStorage.setItem("lazarus-theme", next); } catch { /* local storage can be disabled */ }
  }

  function initializeTheme() {
    let stored;
    try { stored = localStorage.getItem("lazarus-theme"); } catch { stored = null; }
    const preferred = window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark";
    applyTheme(stored || preferred);
  }

  function bindEvents() {
    $("#new-mission-button").addEventListener("click", openMissionDialog);
    $$('[data-open-mission]').forEach((button) => button.addEventListener("click", openMissionDialog));
    $("#close-dialog").addEventListener("click", closeMissionDialog);
    $("#cancel-dialog").addEventListener("click", closeMissionDialog);
    elements.missionForm.addEventListener("submit", createMission);
    elements.missionForm.addEventListener("input", (event) => {
      const fieldName = event.target?.name;
      if (fieldName) clearFieldError(fieldName);
      clearMissionFormError();
      if (fieldName === "budget" || fieldName === "reward") updateCostPreview();
    });
    elements.missionForm.addEventListener("change", (event) => {
      const fieldName = event.target?.name;
      if (fieldName) clearFieldError(fieldName);
      clearMissionFormError();
      if (fieldName === "budget" || fieldName === "reward") updateCostPreview();
    });

    elements.dialog.addEventListener("click", (event) => {
      if (event.target !== elements.dialog) return;
      const rect = elements.dialog.getBoundingClientRect();
      const inside = event.clientX >= rect.left && event.clientX <= rect.right
        && event.clientY >= rect.top && event.clientY <= rect.bottom;
      if (!inside) closeMissionDialog();
    });

    elements.missionList.addEventListener("click", (event) => {
      const button = event.target.closest("[data-mission-id]");
      if (!button) return;
      app.selectedMissionId = button.dataset.missionId;
      render();
      $("#main-content").focus({ preventScroll: true });
    });

    $("#run-demo").addEventListener("click", (event) => runMissionAction("run", event.currentTarget, "Autonomous recovery started"));
    $("#next-step").addEventListener("click", (event) => runMissionAction("step", event.currentTarget, "Mission advanced"));
    $("#blocked-purchase").addEventListener("click", (event) => runMissionAction("blocked-purchase", event.currentTarget, "Policy guardrail proved"));
    $("#reset-demo").addEventListener("click", resetDemo);
    $("#copy-root").addEventListener("click", copyContentRoot);
    $("#export-audit").addEventListener("click", exportAudit);

    $(".tab-list").addEventListener("click", (event) => {
      const tab = event.target.closest("[data-audit-tab]");
      if (!tab) return;
      app.auditTab = tab.dataset.auditTab;
      const mission = activeMission();
      if (mission) renderAudit(mission);
    });
    $(".tab-list").addEventListener("keydown", (event) => {
      if (!/ArrowLeft|ArrowRight|Home|End/.test(event.key)) return;
      event.preventDefault();
      const tabs = $$("[data-audit-tab]");
      let index = tabs.indexOf(document.activeElement);
      if (event.key === "Home") index = 0;
      else if (event.key === "End") index = tabs.length - 1;
      else index = (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
      tabs[index].click();
      tabs[index].focus();
    });

    elements.themeToggle.addEventListener("click", () => {
      applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
    });

    window.addEventListener("online", () => {
      setConnection("connecting", "Reconnecting");
      loadState({ quiet: true });
      loadHealth({ force: true });
      connectEventStream();
    });
    window.addEventListener("offline", () => setConnection("offline", "Offline"));
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) loadState({ quiet: true });
    });
    window.addEventListener("beforeunload", () => {
      app.eventSource?.close();
      window.clearInterval(app.pollingTimer);
    });
  }

  async function init() {
    initializeTheme();
    bindEvents();
    updateCostPreview();
    render();
    await loadState();
    loadHealth({ force: true });
    connectEventStream();
  }

  init();
})();
