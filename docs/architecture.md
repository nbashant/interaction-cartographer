# Architecture

Glitchly is split into a TypeScript core package, a Node CLI, and a Vite React report app. The primary path is scanning a real localhost product through the report UI or CLI. The demo apps are optional fixtures.

## System Overview

```text
CLI
  -> starts crawl
  -> invokes core cartograph()
  -> writes artifacts
  -> serves report app and run files

Core
  -> launches Playwright
  -> captures states
  -> extracts actions
  -> registers transitions
  -> runs detectors
  -> exports reports

Report
  -> accepts localhost URL
  -> posts /api/scan
  -> renders findings, screenshot evidence, states, transitions, actions, replay evidence
```

## CLI Flow

`cartograph run <url>` normalizes flags into `CrawlOptions`, calls `cartograph()`, and writes the artifact folder.

`cartograph view [run-dir]` builds the report app, starts a local HTTP server, serves `/api/run`, screenshots, replay files, export files, and the static report bundle. Without a run directory, it starts as a scanner where the user enters a localhost URL.

`POST /api/scan` runs a real crawl from the report UI and updates the active run served by `/api/run`.

`cartograph demo` remains available for fixture testing, but it is not the primary product workflow.

## Browser Automation Flow

The crawler launches Chromium through Playwright with reduced motion and a fixed viewport. It instruments:

- Console errors.
- Request failures.
- HTTP responses with status `>= 400`.
- Screenshots after each captured state.

The crawler uses bounded breadth-first exploration. It restores the replay path to a state, executes one candidate action, captures the resulting state, records a transition, and queues actions from newly discovered states.

## State Fingerprinting

State fingerprints combine:

- Normalized URL shape.
- Visible heading/text hash.
- DOM structure hash.
- Role count hash.
- Screenshot hash.
- Viewport key.
- Overlay/dialog key.

Two states cluster when viewport and overlay match and URL/text/DOM/role signatures are compatible. This prevents obvious duplicate explosion while preserving distinct modals, tabs, blank states, and mobile states.

## Action Extraction

The crawler extracts visible enabled actions from:

- `button`, `a`, `input`, `select`, `textarea`.
- ARIA roles: `button`, `link`, `tab`, `menuitem`.
- Elements with `tabindex`.
- Elements with `data-cartograph-action`.

Actions receive stable CSS selectors, labels, roles, bounding boxes, risk classification, and a priority score.

## Safe Planner

Blocked by default:

- Delete/remove/purchase/pay/send/invite/publish/deploy/push/merge/logout/upload.
- Off-origin links unless `--allow-external`.

Caution:

- Submit-like controls such as save, continue, apply, checkout, confirm.

Localhost runs can allow submit-like actions through `--allow-submit` or the report UI's "Allow local submits" toggle.

## Detector Pipeline

Detectors run after every transition and state capture. The MVP detector IDs are:

- `no-effect-click`
- `console-error`
- `network-error`
- `blank-render`
- `horizontal-overflow`
- `offscreen-interactive`
- `text-overlap-candidate`
- `modal-cannot-close`
- `form-dead-end`
- `accessibility-smoke`
- `navigation-loop`
- `mobile-only-breakage`

Findings always include screenshot evidence and a replay path.

## Artifact Format

Each run folder contains:

```text
run.json
states.json
transitions.json
findings.json
report-data.json
report.md
findings-report.md
findings-export.json
report.html
screenshots/
replays/
```

The interactive report loads `report-data.json` through `/api/run`, serves screenshots from the same run directory, and exposes findings export endpoints:

- `/api/export/json`
- `/api/export/markdown`

## Limitations

- The action planner is heuristic and conservative.
- Visual bug detectors intentionally trade precision for useful evidence.
- Auth/session state, baseline comparison, and generated Playwright tests are future expansion points.
- The tool should not be used against third-party sites without permission.
