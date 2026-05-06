# Evaluation

## Real Product Evaluation Path

Primary command:

```bash
npm run cartograph -- view
```

Then enter the target app URL in the UI, for example:

```text
http://localhost:3000
```

Expected evidence after a scan:

- Findings are visible in the findings-first UI.
- Each finding has screenshot evidence and replay steps.
- States, transitions, and actions are visible in the artifact explorer.
- `findings-export.json` exists for structured downstream use.
- `findings-report.md` exists for human review.

## Fixture Bug Inventory

Atlas CRM:

| Bug | Expected detector signal |
| --- | --- |
| Create modal close button does nothing | `no-effect-click`, `modal-cannot-close` |
| Settings Billing tab throws console error | `console-error` |
| Mobile nav can overflow narrow viewport | `horizontal-overflow`, `mobile-only-breakage` |
| Settings save icon has no accessible name | `accessibility-smoke` |
| Pipeline card opens blank panel | `blank-render` |

Mini Checkout:

| Bug | Expected detector signal |
| --- | --- |
| Promo apply returns mocked 500 | `network-error`, `console-error` |
| Continue button becomes disabled after validation error | `form-dead-end` |
| Address preview overflows narrow viewport | `horizontal-overflow`, `offscreen-interactive`, `mobile-only-breakage` |
| Payment step hidden on mobile | Future comparable-state detector |
| Cart drawer focus trap incomplete | Future focus-cycle detector |

## Latest Fixture Run

Command:

```bash
npm run demo -- --no-open --no-view
```

Observed on May 5, 2026:

| Metric | Count |
| --- | ---: |
| States | 27 |
| Transitions | 110 |
| Findings | 155 |
| Actions attempted | 110 |
| Viewports | desktop, mobile |

Detector breakdown:

| Detector | Count |
| --- | ---: |
| `accessibility-smoke` | 15 |
| `blank-render` | 2 |
| `console-error` | 5 |
| `form-dead-end` | 7 |
| `horizontal-overflow` | 15 |
| `mobile-only-breakage` | 30 |
| `modal-cannot-close` | 3 |
| `network-error` | 4 |
| `no-effect-click` | 23 |
| `offscreen-interactive` | 30 |
| `text-overlap-candidate` | 21 |

## Expected vs Detected In Fixtures

Detected in the default run:

- Promo 500 from Mini Checkout.
- Console errors from demo interactions.
- Blank pipeline panel in Atlas CRM.
- Settings icon accessibility smoke failure.
- Create modal close failure.
- Checkout validation dead end.
- Mobile/narrow checkout overflow.

Partially covered or future work:

- Atlas mobile nav overflow is present in the demo app; depending on action budget, the default crawl may prioritize checkout mobile overflow first.
- Payment hidden on mobile needs a comparable desktop/mobile state detector rather than a generic overflow detector.
- Cart focus trap needs keyboard traversal/focus-cycle instrumentation.

## False Positives

Known noisy classes:

- `text-overlap-candidate` is intentionally heuristic.
- `no-effect-click` can fire on informational controls or already-open drawers.
- Repeated mobile overflow can appear from several actions in the same broken state.

## Runtime Metrics

The default demo is intentionally bounded for local repeatability. Increase coverage with:

```bash
npm run demo -- --max-actions 120 --max-depth 7 --max-duration-ms 240000
```

Use smaller budgets for quick smoke checks:

```bash
npm run demo -- --max-actions 25 --max-depth 4 --no-view --no-open
```
