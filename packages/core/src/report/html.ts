import type { CartographRun } from "../types.js";

export function generateStaticHtmlReport(run: CartographRun): string {
  const data = JSON.stringify(run).replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Interaction Cartographer Report</title>
  <style>
    body { margin: 0; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #f7f8fb; color: #1d2430; }
    header { display: flex; justify-content: space-between; align-items: center; padding: 18px 24px; border-bottom: 1px solid #d9dee7; background: #fff; }
    main { display: grid; grid-template-columns: minmax(420px, 1fr) minmax(360px, 440px); gap: 16px; padding: 16px; height: calc(100vh - 74px); box-sizing: border-box; }
    .panel { border: 1px solid #d9dee7; background: #fff; border-radius: 8px; overflow: hidden; }
    .details { display: grid; grid-template-rows: repeat(3, minmax(0, 1fr)); gap: 12px; min-height: 0; background: transparent; border: 0; }
    .section { min-height: 0; overflow: auto; }
    .section h2 { margin: 0; padding: 12px 14px; border-bottom: 1px solid #e8ebf0; font-size: 14px; }
    .row { display: grid; gap: 3px; padding: 10px 14px; border-bottom: 1px solid #eef1f5; font-size: 13px; }
    .row strong { color: #252d3d; }
    .row span { color: #667085; overflow-wrap: anywhere; }
    .side { display: grid; grid-template-rows: auto 1fr 1fr; gap: 16px; min-height: 0; }
    .summary { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; padding: 12px; }
    .chip { border: 1px solid #d9dee7; border-radius: 6px; padding: 8px; font-size: 12px; }
    .chip strong { display: block; font-size: 20px; }
    img { max-width: 100%; display: block; }
    .findings { overflow: auto; padding: 12px; }
    .finding { border-bottom: 1px solid #e8ebf0; padding: 10px 0; }
  </style>
</head>
<body>
  <header>
    <strong>Interaction Cartographer</strong>
    <span>${run.summary.stateCount} states · ${run.summary.findingCount} findings</span>
  </header>
  <main id="app"></main>
  <script>
    const run = ${data};
    const app = document.getElementById("app");
    const details = document.createElement("section");
    details.className = "details";
    const sectionFor = (titleText) => {
      const section = document.createElement("section");
      section.className = "panel section";
      const heading = document.createElement("h2");
      heading.textContent = titleText;
      section.appendChild(heading);
      return section;
    };
    const states = sectionFor("States");
    run.states.forEach((state) => {
      const row = document.createElement("div");
      row.className = "row";
      const title = document.createElement("strong");
      title.textContent = state.id + " · " + state.label;
      const detail = document.createElement("span");
      detail.textContent = state.viewport + " · " + state.interactiveCount + " controls · " + state.url;
      row.append(title, detail);
      states.appendChild(row);
    });
    const transitions = sectionFor("Transitions");
    run.transitions.forEach((transition) => {
      const row = document.createElement("div");
      row.className = "row";
      const title = document.createElement("strong");
      title.textContent = transition.fromStateId + " -> " + transition.toStateId + " · " + transition.status;
      const detail = document.createElement("span");
      detail.textContent = transition.action.type + " · " + (transition.action.label || transition.action.selector);
      row.append(title, detail);
      transitions.appendChild(row);
    });
    const actions = sectionFor("Actions");
    const seenActions = new Set();
    run.transitions.map(transition => transition.action).forEach((action) => {
      const key = action.type + ":" + action.selector + ":" + (action.label || "");
      if (seenActions.has(key)) return;
      seenActions.add(key);
      const row = document.createElement("div");
      row.className = "row";
      const title = document.createElement("strong");
      title.textContent = action.type + " · " + (action.label || action.selector);
      const detail = document.createElement("span");
      detail.textContent = action.risk + " · " + action.selector;
      row.append(title, detail);
      actions.appendChild(row);
    });
    details.append(states, transitions, actions);
    const side = document.createElement("aside");
    side.className = "side";
    const summary = document.createElement("section");
    summary.className = "panel summary";
    [["states", run.summary.stateCount], ["transitions", run.summary.transitionCount], ["findings", run.summary.findingCount], ["actions", run.summary.actionsAttempted]].forEach(([label, value]) => {
      const chip = document.createElement("div");
      chip.className = "chip";
      const strong = document.createElement("strong");
      strong.textContent = String(value);
      chip.append(strong, document.createTextNode(String(label)));
      summary.appendChild(chip);
    });
    const screenshot = document.createElement("section");
    screenshot.className = "panel";
    const img = document.createElement("img");
    img.src = run.states[0]?.screenshotPath ?? "";
    screenshot.appendChild(img);
    const findings = document.createElement("section");
    findings.className = "panel findings";
    run.findings.forEach(f => {
      const item = document.createElement("div");
      item.className = "finding";
      const title = document.createElement("strong");
      title.textContent = f.title;
      item.append(title, document.createElement("br"), document.createTextNode(f.detector + " · " + f.severity), document.createElement("br"), document.createTextNode(f.detail));
      findings.appendChild(item);
    });
    side.append(summary, screenshot, findings);
    app.append(details, side);
  </script>
</body>
</html>`;
}
