/**
 * Scheduled production flow check. Site-agnostic harness: everything specific
 * to the site under test lives in site.mjs (login, the flow, cleanup).
 *
 * Every run: sign the QA account in without the UI -> drive the flow in a
 * signed-in headless browser -> clean up whatever the account created since
 * run start, regardless of outcome -> report via GitHub Actions annotations,
 * job summary, and qa-results/ artifacts.
 */

import "dotenv/config";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { cleanupTestData, login, runSiteFlow } from "./site.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = path.join(__dirname, "qa-results");

/** Escapes a workflow-command message per GitHub's escaping rules. */
function escapeGhaMessage(s) {
  return s.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

function emitGhaAnnotation(level, title, message) {
  console.log(`::${level} title=${title}::${escapeGhaMessage(message)}`);
}

function writeJobSummary(result, cleanupError) {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) return;
  const status = result.success ? "PASSED" : "FAILED";
  let text = `## Flow check: ${status}\n\n- **Step reached:** ${result.stepReached}\n- **Reason:** ${result.reason}\n`;
  if (cleanupError) text += `- **Cleanup:** FAILED — ${cleanupError}\n`;
  appendFileSync(summaryPath, text);
}

async function runFlow(session, runStart) {
  mkdirSync(RESULTS_DIR, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ acceptDownloads: true });
  if (session.cookies?.length) await context.addCookies(session.cookies);
  // Seed client-side auth state the frontend reads to decide "signed in";
  // only when absent, so a token the app refreshed mid-run isn't clobbered.
  if (session.localStorage) {
    await context.addInitScript((entries) => {
      for (const [key, value] of Object.entries(entries)) {
        if (!window.localStorage.getItem(key)) window.localStorage.setItem(key, value);
      }
    }, session.localStorage);
  }
  const page = await context.newPage();

  // runSiteFlow advances `progress.step` before each step so a failure
  // reports where it happened.
  const progress = { step: "navigate" };
  let success = false;
  let reason = "";
  try {
    reason = await runSiteFlow({ page, context, session, runStart, progress, resultsDir: RESULTS_DIR });
    success = true;
  } catch (err) {
    reason = err instanceof Error ? err.message : String(err);
    try {
      await page.screenshot({ path: path.join(RESULTS_DIR, "failure.png"), fullPage: true });
    } catch {
      // best-effort; must not mask the real error
    }
  } finally {
    await browser.close();
  }

  const result = { success, stepReached: progress.step, reason };
  writeFileSync(path.join(RESULTS_DIR, "result.json"), JSON.stringify(result, null, 2));
  return result;
}

async function main() {
  const runStart = new Date();

  let session;
  try {
    session = await login();
  } catch (err) {
    emitGhaAnnotation("error", "Flow check failed", `Login failed: ${err.message}`);
    console.error(`Login failed: ${err.message}`);
    process.exit(1);
  }

  const result = await runFlow(session, runStart);

  let cleanupError = null;
  try {
    const removed = await cleanupTestData(session, runStart);
    console.log(`Cleanup: removed ${removed.length} item(s) created this run: ${JSON.stringify(removed)}`);
  } catch (err) {
    cleanupError = err instanceof Error ? err.message : String(err);
    console.error(`Cleanup FAILED: ${cleanupError}`);
  }

  console.log(`Flow result: success=${result.success} step_reached=${result.stepReached}`);
  console.log(`Reason: ${result.reason}`);
  writeJobSummary(result, cleanupError);

  if (!result.success) {
    emitGhaAnnotation("error", "Flow check failed", `Step "${result.stepReached}": ${result.reason}`);
  }
  if (cleanupError) {
    emitGhaAnnotation("warning", "Flow check cleanup failed", `Test data may still be live: ${cleanupError}`);
  }
  if (!result.success) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
