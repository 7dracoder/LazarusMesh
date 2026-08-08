"use strict";

const path = require("node:path");
const { chromium } = require("playwright");
const { createApplication } = require("../server");

const ROOT = path.resolve(__dirname, "..");

async function main() {
  const errors = [];
  const { server } = createApplication();
  let browser;

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    browser = await chromium.launch({
      headless: true,
      executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(`console: ${message.text()}`);
    });
    page.on("pageerror", (error) => errors.push(`page: ${error.message}`));

    await page.goto(baseUrl, { waitUntil: "networkidle" });
    const [runResponse] = await Promise.all([
      page.waitForResponse((response) => (
        response.request().method() === "POST" && /\/api\/missions\/[^/]+\/run$/.test(response.url())
      ), { timeout: 12_000 }),
      page.locator("#run-demo").click(),
    ]);
    if (!runResponse.ok()) errors.push(`run request: HTTP ${runResponse.status()}`);
    await page.waitForFunction(() => document.querySelector("#mission-status")?.textContent?.trim() === "RESEEDED", null, {
      timeout: 3_000,
    });
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.locator("#export-audit").click(),
    ]);
    if (!download.suggestedFilename().endsWith("-audit.json")) {
      errors.push(`download: unexpected filename ${download.suggestedFilename()}`);
    }
    await page.waitForTimeout(4_250);

    const state = await page.evaluate(() => fetch("/api/state").then((response) => response.json()));
    const mission = state.missions.find((item) => item.id === state.activeMissionId);
    const desktop = await page.evaluate(() => ({
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      status: document.querySelector("#mission-status")?.textContent?.trim(),
      pieces: document.querySelector("#pieces-value")?.textContent?.trim(),
      seeders: document.querySelector("#seeders-value")?.textContent?.trim(),
      rainState: document.querySelector("#rain-state")?.textContent?.trim(),
      x402State: document.querySelector("#x402-state")?.textContent?.trim(),
      x402Amount: document.querySelector("#x402-amount")?.textContent?.trim(),
      monadAmount: document.querySelector("#monad-amount")?.textContent?.trim(),
      unnamedButtons: Array.from(document.querySelectorAll("button")).filter((button) => (
        !button.textContent.trim() && !button.getAttribute("aria-label") && !button.getAttribute("title")
      )).length,
    }));
    await page.screenshot({
      path: path.join(ROOT, "qa", "lazarus-desktop-final.png"),
      fullPage: true,
    });

    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(200);
    const mobile = await page.evaluate(() => ({
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      width: document.documentElement.clientWidth,
    }));
    await page.screenshot({
      path: path.join(ROOT, "qa", "lazarus-mobile-final.png"),
      fullPage: true,
    });

    const blocked = mission.payments.find((payment) => payment.status === "declined");
    const result = {
      serverStatus: mission.status,
      step: mission.stepIndex,
      rootMatched: mission.audit.rootMatched,
      recovered: mission.pieces.recovered,
      verified: mission.pieces.verified,
      seeders: mission.seeders,
      releasedMinor: mission.budget.releasedMinor,
      rewardMinor: mission.budget.rewardMinor,
      rainCard: mission.rainCard?.state,
      blockedCode: blocked?.code,
      desktop,
      mobile,
      errors,
    };

    const valid = mission.status === "COMPLETED" &&
      mission.stepIndex === 9 &&
      mission.audit.rootMatched === true &&
      mission.pieces.verified === 24 &&
      mission.seeders === 2 &&
      mission.budget.releasedMinor === mission.budget.rewardMinor &&
      mission.rainCard?.state === "retired" &&
      blocked?.code === "MERCHANT_NOT_ALLOWED" &&
      desktop.x402State === "Settled" &&
      desktop.x402Amount === "$0.01 settled" &&
      desktop.overflow === 0 &&
      desktop.unnamedButtons === 0 &&
      mobile.overflow === 0 &&
      errors.length === 0;

    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (!valid) process.exitCode = 1;
  } finally {
    if (browser) await browser.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
