/**
 * Site adapter for run.mjs — copy to site.mjs and rewrite for the site under
 * test. Illustrative example: a signed-in user uploads a file, publishes it,
 * and deletes it. Endpoints, labels, and fields below are placeholders; read
 * the site's auth and API code before writing the real versions.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { runJevClickLoop } from "./jev.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE_URL = process.env.TARGET_BASE_URL;
const API_URL = process.env.TARGET_API_URL;

/**
 * Signs the QA account in through the auth provider's API — never the login
 * UI — and returns what the browser needs to start signed in:
 * `{ cookies: PlaywrightCookie[], localStorage?: {key: value}, ...anything
 * cleanupTestData needs, e.g. a bearer token }`.
 */
export async function login() {
  const resp = await fetch(`${API_URL}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: process.env.QA_TEST_ACCOUNT_EMAIL,
      password: process.env.QA_TEST_ACCOUNT_PASSWORD,
    }),
  });
  if (!resp.ok) throw new Error(`Login failed (${resp.status}): ${await resp.text()}`);
  const { token } = await resp.json();
  const domain = new URL(BASE_URL).hostname;
  return {
    token,
    cookies: [{ name: "session", value: token, domain, path: "/", httpOnly: true, secure: true }],
  };
}

async function listMyItems(session) {
  const resp = await fetch(`${API_URL}/items/mine`, { headers: { Authorization: `Bearer ${session.token}` } });
  if (!resp.ok) throw new Error(`Failed to list items (${resp.status}): ${await resp.text()}`);
  return (await resp.json()).items;
}

/** Drives the flow; throws on any failure; returns a one-line success reason. */
export async function runSiteFlow({ page, session, runStart, progress }) {
  await page.goto(BASE_URL, { waitUntil: "domcontentloaded" });

  // Scripted: primitives the click loop doesn't offer (file input, typing, drags).
  progress.step = "upload";
  await page.locator('input[type="file"]').setInputFiles(path.join(__dirname, "fixture.png"));

  // Jev: click-only stretch, described in the UI's own visible words.
  progress.step = "publish";
  await runJevClickLoop(
    page,
    'Click "Publish", keep the Public option, and confirm. Done when the page says it was published.',
    { maxSteps: 10 },
  );

  // Verify through the API, not the page; refuse to go on unless the state is exact.
  progress.step = "verify publish";
  const items = await listMyItems(session);
  if (items.length !== 1 || new Date(items[0].created_at) < runStart || items[0].visibility !== "public") {
    throw new Error(`Expected exactly this run's public item, found ${JSON.stringify(items)}; refusing to delete.`);
  }
  const item = items[0];

  progress.step = "delete";
  const itemGone = async () => !(await listMyItems(session)).some((i) => i.id === item.id);
  await page.goto(`${BASE_URL}/account`, { waitUntil: "domcontentloaded" });
  await runJevClickLoop(page, 'Open the first item, click "Delete", then confirm. Done once deletion is confirmed.', {
    maxSteps: 10,
    stopWhen: itemGone,
  });
  // DONE can precede the request landing; poll within a deadline.
  for (const deadline = Date.now() + 15_000; !(await itemGone()); ) {
    if (Date.now() > deadline) throw new Error(`Item ${item.id} still exists after delete.`);
    await page.waitForTimeout(1000);
  }

  return "All steps completed: upload, publish, verify, delete.";
}

/** Deletes everything the QA account created at/after runStart; returns removed ids. Runs every time. */
export async function cleanupTestData(session, runStart) {
  const removed = [];
  for (const item of await listMyItems(session)) {
    if (new Date(item.created_at) < runStart) continue;
    const resp = await fetch(`${API_URL}/items/${item.id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${session.token}` },
    });
    if (!resp.ok && resp.status !== 404) throw new Error(`Failed to delete ${item.id} (${resp.status})`);
    removed.push(item.id);
  }
  return removed;
}
