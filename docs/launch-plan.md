# Launch Plan

## LinkedIn Post

```text
I built Interaction Cartographer.

Give it a local web app URL and it explores the product like a user:
- clicks buttons
- opens modals
- switches tabs
- fills safe forms
- checks desktop and mobile
- captures screenshots
- captures reachable UI states, transitions, actions, screenshots, and findings
- reports broken interactions with replay paths

The interesting part is the state model underneath.

It fingerprints each screen with URL, DOM structure, visible text, roles, viewport, and screenshot similarity, then turns the crawl into actionable findings with evidence.

This is the kind of tool I want next to coding agents: not another generator, but something that verifies the product experience they created.
```

Short version:

```text
I built a tool that opens any local web app, explores it like a user, and generates a visual map of reachable screens, broken interactions, and UI bugs.

It is called Interaction Cartographer.

The goal: make product QA feel like looking at a map instead of hunting through random clicks.
```

## Video Storyboard

0-3 seconds:

- Show a real product running at `localhost:3000`.
- Open Interaction Cartographer and enter that URL.

3-8 seconds:

- Findings start appearing with screenshots and replay paths.

8-15 seconds:

- The finding list shows UI, console, network, and layout issues from the real app.

15-25 seconds:

- Select a finding.
- Screenshot evidence and replay path update.

25-35 seconds:

- Toggle desktop/mobile finding filters.

35-45 seconds:

- Export Markdown report.
- Show generated JSON findings export.

Closing frame:

- Interaction Cartographer - Map the product your users can actually reach.

## Screenshot Checklist

- Report UI with scan form, findings list, screenshot viewer, and replay path visible.
- Selected critical finding with replay path visible.
- Desktop/mobile filter state.
- Generated Markdown report.
- Terminal with `npm run demo` output.
- Real localhost app before scan.
- Findings detail view after scan.

## README Framing

Keep the README balanced:

- Recruiter-readable product hook.
- Senior-engineer-visible system core.
- Clear limitations and safety caveats.
- Evidence from a real local product scan.

## Repo Description

`Local-first browser crawler that maps reachable UI states and reports broken interactions with screenshots and replay paths.`

## Suggested Keywords

frontend QA, Playwright, browser automation, UI findings, visual QA, developer tools, local-first, interaction mapping, product verification, agentic UI testing.
