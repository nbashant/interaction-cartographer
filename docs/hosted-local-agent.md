# Hosted UI + Local Companion

The hosted product can live at a public URL, but it cannot directly scan a user's `localhost` app from the browser. Browser sandboxing prevents a public site from launching Playwright, inspecting local app internals, bypassing same-origin/CORS boundaries, or starting a local process on the user's machine.

The intended secure architecture is:

```text
Hosted UI <-> hosted backend <-> outbound secure connection <-> local companion <-> user's localhost app
```

First-time flow:

1. User opens the hosted UI.
2. Hosted UI creates a short-lived pairing session.
3. UI shows one command:

   ```bash
   npx -y glitchly@latest connect --pair 8K4P-JD91
   ```

4. User runs the command locally.
5. The local companion connects outbound to the hosted backend.
6. Hosted UI shows `Local agent connected`.
7. User enters `http://localhost:3000` and controls scans from the hosted UI.

Security constraints:

- Pairing codes are short-lived, high-entropy, and scoped to one hosted browser session.
- The local companion connects outbound only; it does not expose a public inbound port.
- The hosted backend can send only allowlisted scanner commands such as scan, stop, progress, export, and disconnect.
- The companion never runs arbitrary shell commands.
- Default targets are limited to `localhost`, `127.0.0.1`, and `::1`.
- Private LAN or external targets require explicit opt-in.
- The scanner uses an ephemeral browser profile by default.
- Stop and Disconnect controls stay visible while connected or scanning.
- Results upload only the evidence needed for the report: findings, screenshots, network/console evidence, replay paths, and export artifacts.

Implemented transport:

- Hosted UI calls `/api/agent/session` to create or resume a pairing session.
- Local companion calls `/api/agent/connect` with the pair code.
- The companion polls `/api/agent/tasks` for allowlisted `scan` and `stop` tasks.
- Scan progress streams back through `/api/agent/progress`.
- Finished runs upload through `/api/agent/result`, including report JSON, exports, screenshots, and replay scripts.
- Hosted UI reads paired results using `?sessionId=...` on run, export, screenshot, and progress endpoints.

This keeps the hosted UI as the main product while preserving the local machine boundary needed for real localhost scanning.
