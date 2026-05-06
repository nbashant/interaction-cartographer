# Interaction Cartographer

Scan a real local web app and export the findings.

Interaction Cartographer is a local-first browser crawler for products you are actively building on localhost. Point it at `http://localhost:3000`, let it explore safe interactions with Playwright, and review concrete findings with screenshots, DOM signals, network/console evidence, replay paths, states, transitions, and actions.

## Primary Workflow

Start your product first, for example:

```bash
npm run dev
```

Then start the scanner:

```bash
npm install
npm run build
npm run cartograph -- view
```

Open the report UI, enter the real app URL such as `http://localhost:3000`, and click **Scan real app**.

The scan writes a run folder under `.cartograph/runs/` and makes these artifacts available:

- `run.json`
- `states.json`
- `transitions.json`
- `findings.json`
- `findings-export.json`
- `findings-report.md`
- screenshots
- replay scripts

## Hosted Workflow

The hosted UI can pair with a local companion so a public site can still scan the app running on your own machine:

1. Open the hosted report UI.
2. Copy the one-line companion command shown in the UI.
3. Run it in the same local environment where your app is running.
4. Return to the hosted UI and scan `http://localhost:3000`.

The command looks like this:

```bash
npx -y @interaction-cartographer/cli@latest connect --pair 8K4P-JD91 --server https://interaction-cartographer.onrender.com
```

For local repo testing before the npm package is published:

```bash
npm run cartograph -- connect --pair 8K4P-JD91 --server https://interaction-cartographer.onrender.com
```

The companion connects outbound to the hosted server, receives only allowlisted scan/stop tasks, runs Playwright locally, and uploads the finished findings/screenshots back into the paired browser session.

## CLI Workflow

Run directly against a local product:

```bash
npm run cartograph -- run http://localhost:3000 --out .cartograph/runs/my-app
npm run cartograph -- view .cartograph/runs/my-app
```

Export findings:

```bash
npm run cartograph -- export .cartograph/runs/my-app --format json
npm run cartograph -- export .cartograph/runs/my-app --format markdown
```

JSON is the best default for agents, issue creation, and downstream processing. Markdown is better for pasting into a PR, ticket, or teammate note.

## What It Pulls From Real Apps

- Findings with severity, detector, detail, selector, screenshot, evidence, and replay path.
- States with URL, viewport, title, label, DOM summary, interactive count, console errors, and network errors.
- Transitions with from/to state, action, duration, status, and screenshots.
- Actions with selector, role, label, risk classification, reason, and bounding box.

## Detectors

- No-effect click.
- Console error.
- Network 4xx/5xx or request failure.
- Blank or near-blank render.
- Horizontal overflow.
- Offscreen interactive element.
- Possible text overlap/overflow.
- Modal cannot close.
- Form dead end.
- Accessibility smoke check.
- Navigation loop.
- Mobile breakage signal.

## Safety Defaults

This is meant for real local apps, not public-site crawling.

- The report scanner accepts localhost/127.0.0.1 targets by default.
- Destructive labels like delete, remove, purchase, pay, deploy, merge, logout, and upload are blocked by default.
- Same-origin navigation is enforced unless explicitly allowed.
- Submit-like actions are allowed for local scans because real product QA needs form coverage.

## Optional Demo Fixtures

The repo still includes demo fixtures for regression testing and recording controlled examples:

```bash
npm run demo
```

Those fixtures are not the main product path. The main product path is scanning the local app you are actually working on.

## Architecture

```text
Report UI
  -> user enters localhost URL
  -> /api/scan
  -> Playwright crawler
  -> states / transitions / actions / findings
  -> screenshots + replay scripts
  -> JSON and Markdown exports
```

Workspace layout:

```text
apps/report/              scanner and findings UI
packages/core/            crawler, state model, detectors, exports
packages/cli/             cartograph commands and local servers
apps/demo-atlas-crm/      optional fixture app
apps/demo-mini-checkout/  optional fixture app
docs/                     architecture and evaluation notes
tests/e2e/                browser tests for the report UI
```

## Limitations

- Exploration is best-effort and bounded by action/depth/time budgets.
- Visual detectors are heuristic and label uncertain findings as candidates.
- It does not bypass auth, CAPTCHA, payments, uploads, or destructive workflows.
- It does not prove a UI is bug-free; it produces evidence from the states it reached.
