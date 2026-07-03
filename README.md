# Sylo

> Re-entry briefs for humans. Context files for agents. Always know where you left off.

Sylo is a VS Code extension with two jobs.

**First:** when you return to your editor after an interruption, it shows you a 3-sentence brief — what you were working on, the last decision you made, and the next step.

**Second:** when you're about to start an AI agent session (Claude Code, Cursor, Copilot, ChatGPT), press one keyboard shortcut and Sylo writes `SYLO_CONTEXT.md` — a structured markdown file with your full working context, ready to paste into any agent. No more re-explaining yourself.

---

## Quick start

1. Install Sylo from the VS Code Marketplace.
2. Press **Cmd+Shift+Alt+S** (Mac) or **Ctrl+Shift+Alt+S** (Win/Linux).
   Paste `SYLO_CONTEXT.md` into your agent. Start working immediately.

That's it — no account, no API key, nothing to configure. Bonus: leave VS Code for 5 minutes and come back to a 3-sentence re-entry brief.

---

## Configuration

All settings live under the `sylo.*` namespace (Settings → Extensions → Sylo).

| Setting | Default | Description |
| --- | --- | --- |
| `sylo.agentContextPath` | `SYLO_CONTEXT.md` | Output path relative to workspace root. Set to `CLAUDE.md` to feed Claude Code directly. |
| `sylo.awayThresholdMinutes` | `5` | Minutes away before a re-entry brief is triggered (1–60). |
| `sylo.autoShow` | `true` | Show brief notification when you return to VS Code. |
| `sylo.apiBaseUrl` | `https://api.sylo.dev` | Sylo API URL. Only change this if you are self-hosting the Sylo server. |

### Commands

| Command | Keybinding | What it does |
| --- | --- | --- |
| Sylo: Generate agent context file | `Cmd/Ctrl+Shift+Alt+S` | Capture state, write `SYLO_CONTEXT.md`, copy to clipboard. |
| Sylo: Open context file | — | Open the generated context file in the editor. |
| Sylo: Show re-entry brief | — | Show the latest human brief in the panel. |
| Sylo: Clear snapshot history | — | Wipe stored briefs and context files. |

---

## Agent context file format

A generated `SYLO_CONTEXT.md` looks like this:

```markdown
# Sylo Context — myproject
> Generated 2026-07-01T14:32:00.000Z · Branch: fix/auth-race-condition

## What's being worked on
Fixing a race condition in the token refresh logic in `src/auth/middleware.ts`,
specifically the `refreshTokenIfExpired` function around line 84.

## Current state
- Token refresh works for a single request but two concurrent requests both
  trigger a refresh, invalidating each other's tokens.
- A mutex was sketched out but not yet wired in before the `await` on line 91.
- `src/auth/types.ts` has a type error blocking compilation.

## Key files
- `src/auth/middleware.ts` — request auth middleware; contains the buggy refresh.
- `src/auth/types.ts` — shared auth types; currently has a TS error on line 34.
- `src/auth/tokenStore.ts` — where refreshed tokens are persisted.

## Errors to address
- ERROR [typescript]: Type 'undefined' is not assignable to 'string' — `src/auth/types.ts:34`
- WARNING [eslint]: 'lock' is assigned but never used — `src/auth/middleware.ts:88`

## Uncommitted changes
 src/auth/middleware.ts | 22 ++++++++++++++--------
 src/auth/types.ts      |  4 ++--

## Next action
Your first task is to add a mutex lock around the `refreshTokenIfExpired` call on
line 91 of `middleware.ts`, ensuring concurrent requests await the same refresh.

## Do not touch
- `src/auth/tokenStore.ts` — persistence layer, unrelated to this fix.
```

---

## How it works (architecture)

```
VS Code extension
       │
       │  POST /generate  (redacted snapshot JSON, no auth required)
       ▼
Sylo API server  ──►  Anthropic API (Sylo's key, Sylo's cost)
       │
       │  { content: "# Sylo context...", tokenEstimate: 312 }
       ▼
VS Code extension → writes SYLO_CONTEXT.md, copies to clipboard
```

The extension makes no LLM API calls directly — everything goes through the hosted Sylo API. Power users can self-host `packages/api` and point `sylo.apiBaseUrl` at their own instance.

---

## Privacy

- Sylo sends only open file names, cursor context, git diff, and error messages to generate context.
- Secrets and API keys are **automatically redacted client-side** before anything leaves your machine — lines matching secret-assignment patterns are replaced with `[redacted by Sylo]`.
- No account, no user identifiers — the snapshot carries no email, no machine ID.
- No screen recording, no keystroke logging, no clipboard access without your action.
- Sylo never stores your code. All history is kept in VS Code's `globalState`, never on a server.
- `SYLO_CONTEXT.md` is automatically added to `.gitignore` (unless you point `agentContextPath` at `CLAUDE.md`).

---

## Local development

This is an npm-workspaces monorepo.

```bash
# install everything
npm install

# API server (the hosted backend)
cd packages/api
cp .env.example .env   # add your ANTHROPIC_API_KEY
npm run dev            # tsx watch on port 3456

# extension — point it at your local API
cd packages/extension
npm run build      # bundle with esbuild → dist/extension.js
npm run watch      # rebuild on change
# press F5 to launch an Extension Development Host, then set
# "sylo.apiBaseUrl": "http://localhost:3456" in its settings

# landing page
cd packages/web
npm run dev        # Vite dev server
npm run build      # production build → dist/
```

### Deploying the API to Railway

The repo ships with `railway.json` (root and `packages/api/`) and a `Procfile`. One env var is required: `ANTHROPIC_API_KEY`. Optional: `MAX_DAILY_COST_USD` (default 25), `KNOWN_EXTENSION_VERSIONS` (default `0.1.0`).

Packaging the extension: `cd packages/extension && npm run package` (requires `@vscode/vsce`).

---

## Roadmap

- [ ] JetBrains IDE support
- [ ] Calendar integration (auto-generate context when a meeting ends)
- [ ] Team handoff mode (share context file with a teammate via a link)
- [ ] Automatic CLAUDE.md management mode
- [ ] Neovim plugin
- [ ] Terminal output capture
- [ ] Watch mode: auto-regenerate SYLO_CONTEXT.md on every file save

---

## License

MIT — see [LICENSE](./LICENSE).
