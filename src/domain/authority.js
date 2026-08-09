"use strict";

function potentiallyLiveRainSandboxCard(card, now = Date.now()) {
  if (
    !card ||
    card.mode !== "rain-sandbox"
  ) return false;
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  const expiryMs = new Date(card.expiresAt).getTime();
  // Unknown expiry is authority we cannot prove has ended, so fail closed.
  if (!Number.isFinite(nowMs) || !Number.isFinite(expiryMs)) return true;
  return expiryMs > nowMs;
}

module.exports = { potentiallyLiveRainSandboxCard };
