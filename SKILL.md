---
name: prod-flow-check
description: Build or maintain a scheduled regression check that drives a real user flow on a production website or web app (sign in, click through the UI, create something, verify it, clean up) with Playwright plus TypeSafe's Jev model as a click-by-choice agent, run from GitHub Actions under a dedicated QA account. Use when asked for AI-agent / browser-use style userflow testing, a daily or weekly production smoke check, or to debug or rotate credentials for an existing one.
---

# prod-flow-check

Requirements: Node 22+, Playwright, a TypeSafe API key (console.typesafe.ai),
a GitHub repo with Actions, and a test user the check can sign in as.

## Files

| Path | Role | Reuse |
|---|---|---|
| `scripts/jev.mjs` | `runJevClickLoop(page, goal, {maxSteps, maxWaits, stopWhen})`: each step sends a DOM snapshot to TypeSafe's Jev model, which picks CLICK (and which element), SCROLL, WAIT, DONE, or BLOCKED; Playwright performs it | copy as-is |
| `scripts/snapshot.js` | vendored from browser-use/jev-ultrafast (MIT); indexes visible interactive elements plus page text | copy as-is, with `THIRD_PARTY_LICENSES.md` |
| `templates/run.mjs` | site-agnostic harness: login, signed-in browser, flow, always-run cleanup, GHA annotations + job summary, failure screenshot | copy as-is |
| `templates/site.example.mjs` | the site adapter: `login()`, `runSiteFlow()`, `cleanupTestData()` | rewrite as `site.mjs` |
| `templates/flow-check.yml`, `package.json`, `.env.example` | workflow, deps, local env | adjust URLs/secrets |

Lay out as `qa/flow_check/` in the target repo (the workflow assumes it);
add a small fixture file if the flow uploads one. Ignore `.env` and
`qa-results/`.

## Designing the flow

- **Hybrid driver.** Script with plain Playwright whatever the click loop
  can't do: file inputs (`setInputFiles`), typing, drags (raw `page.mouse`
  down/move/up — apps with custom drag handlers ignore `.dragTo()`). Hand the
  click-only stretches (buttons, menus, dialogs, checkboxes, confirmations)
  to `runJevClickLoop` on the same page; those keep working through label and
  markup changes a selector script would miss.
- **Write goals in the UI's visible words.** Name the buttons and dialog
  titles the user sees and say what "done" looks like on the page. Jev gets
  text and roles only: colours, icons, and positions produce BLOCKED.
- **Verify outcomes through the API, not Jev.** Jev can answer DONE before a
  request lands. Pass `stopWhen` (an API predicate), then poll the API against
  a deadline for the expected end state. For created files, fetch them and
  check status, content type, and size against what the backend recorded.
- **Gate destructive steps on an exact precondition.** Before driving a
  delete, assert the account holds exactly the item this run created.
- **Cleanup always runs**, through the API, deleting whatever the account
  created since run start — even when the flow failed midway. Anything the
  flow makes public is live on production until then.

## Making a page drivable

The snapshot only lists elements inside the viewport and visible without
hover. If Jev answers BLOCKED while the target is plainly there:
- it's off-screen → scroll before the loop (`window.scrollTo`), or let the
  loop use its SCROLL controls;
- it only appears on hover / is opacity-0 → make it visible (also an
  accessibility fix);
- the page is still loading → mark loading states `aria-busy="true"`; the
  loop waits for none to remain. A bare spinner reads as a dead end.

Keep `OPERATION_RULES` and `TARGET_RULES` in `jev.mjs` verbatim from
upstream; Jev is tuned on that wording and paraphrases skew it toward
BLOCKED. Every step logs `jev: <OPERATION> "<label>" {probabilities}` —
read those first when a run fails.

## Test user

- **Dedicated and least-privileged.** Never an admin or a real person's
  account: the check acts publicly under its identity every run, and "exactly
  one item after publish" only holds if nothing else uses it.
- **Sign in without the UI.** `login()` calls the auth provider's API with the
  test credentials and returns cookies (and any client-side storage the
  frontend reads to decide it's signed in) for the browser context. Find what
  the real sign-in flow ends with: a session cookie from the backend, a token
  in localStorage, or both. OAuth-only sites usually still allow a password
  grant for a user created with a password (e.g. Supabase
  `POST /auth/v1/token?grant_type=password` once the Email provider is
  enabled); otherwise a test-only credential or API-issued session. Avoid
  scripting a third-party login page — bot checks and 2FA make it flaky.
- **Create and rotate it with a stored script** (SQL, admin API call, or CLI)
  that creates the user if missing, otherwise changes only the password, and
  refuses to finish if the user is privileged. Rotate by re-running it; don't
  delete and recreate (new id, orphaned data). If it generates passwords,
  every run makes a new one — only the last is valid.
- **Test the login locally before touching CI:**
  `node -e 'import("./site.mjs").then(m=>m.login()).then(()=>console.log("ok"))'`

## CI

Secrets: `TYPESAFE_API_KEY`, `QA_TEST_ACCOUNT_EMAIL`,
`QA_TEST_ACCOUNT_PASSWORD`, plus whatever `login()` needs. Set them with
`gh secret set NAME --repo owner/repo` and paste at the prompt; `echo`
pipes add a trailing newline. When login fails in CI but works locally,
compare `gh secret list` update times with the run's `createdAt`.

Iterate:
```
gh workflow run flow-check.yml --repo owner/repo
gh run watch <id> --repo owner/repo --exit-status
gh run view <id> --repo owner/repo --log | grep -E 'jev:|Flow result|Reason:|Cleanup|rror'
```
Failures surface as an error annotation, a job summary naming the step
reached, and a `qa-results/` artifact with `failure.png`; GitHub's
failed-workflow email is the alert. Run locally with `.env` first.
