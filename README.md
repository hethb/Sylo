# Sylo

> Re-entry briefs for humans. Context files for agents. Always know where you left off.

Sylo is a VS Code extension with two jobs.

**First:** when you return to your editor after an interruption, it shows you a 3-sentence brief — what you were working on, the last decision you made, and the next step.

**Second:** when you're about to start an AI agent session (Claude Code, Cursor, Copilot, ChatGPT), press one keyboard shortcut and Sylo writes `SYLO_CONTEXT.md` — a structured markdown file with your full working context, ready to paste into any agent. No more re-explaining yourself.

---

## Quick start

1. Install Sylo from the VS Code Marketplace.
2. Command Palette → **"Sylo: Configure"** → paste your OpenAI or Anthropic API key.
3. Leave VS Code for 5 minutes. Come back. See your brief.
4. Starting an agent? Press **Cmd+Shift+Alt+S** (Mac) or **Ctrl+Shift+Alt+S** (Win/Linux).
   Paste `SYLO_CONTEXT.md` into your agent. Start working immediately.

---

## Configuration

All settings live under the `sylo.*` namespace (Settings → Extensions → Sylo).

| Setting | Default | Description |
| --- | --- | --- |
| `sylo.apiKey` | `""` | Your OpenAI or Anthropic API key for generating briefs and context files. |
| `sylo.provider` | `openai` | LLM provider to use (`openai` or `anthropic`). |
| `sylo.model` | `gpt-4o-mini` | Model to use (e.g. `gpt-4o-mini`, `claude-3-5-haiku-20241022`). |
| `sylo.awayThresholdMinutes` | `5` | Minutes away before a re-entry brief is triggered (1–60). |
| `sylo.autoShow` | `true` | Automatically show the brief when you return to VS Code. |
| `sylo.maxContextLines` | `50` | Maximum lines of surrounding code to include in the context snapshot. |
| `sylo.agentContextPath` | `SYLO_CONTEXT.md` | Where to write the agent context file, relative to workspace root. Use `CLAUDE.md` to feed directly into Claude Code. |
| `sylo.agentContextMode` | `both` | Whether to write the context to a `file`, copy to `clipboard`, or `both`. |
| `sylo.autoGenerateOnLeave` | `false` | Automatically generate an agent context file every time you leave VS Code. |
| `sylo.includeFullDiff` | `false` | Include the full git diff in the agent context file (more tokens, more detail). |
| `sylo.agentContextTarget` | `generic` | Optimize the context file format for a specific agent (`claude-code`, `cursor`, `copilot`, `generic`). |

### Commands

| Command | Keybinding | What it does |
| --- | --- | --- |
| Sylo: Show re-entry brief | — | Show the latest human brief in the panel. |
| Sylo: Generate agent context file | `Cmd/Ctrl+Shift+Alt+S` | Capture state, write `SYLO_CONTEXT.md`, copy to clipboard. |
| Sylo: Copy agent context to clipboard | `Cmd/Ctrl+Shift+Alt+C` | Generate and copy only — no file written. |
| Sylo: Open SYLO_CONTEXT.md | — | Open the generated context file in the editor. |
| Sylo: Configure | — | Store your API key securely. |
| Sylo: Clear snapshot history | — | Wipe stored snapshots, briefs, and context files. |

---

## Agent context file format

A generated `SYLO_CONTEXT.md` (with `sylo.agentContextTarget = generic`) looks like this:

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

## Per-agent optimization

Set `sylo.agentContextTarget` to shape the file for your agent:

- **`claude-code`** — adds a `## CLAUDE.md note` section pointing back to Sylo, formats the "Next action" as a direct imperative, and omits "Do not touch" when only one file is open. Pair with `sylo.agentContextPath = CLAUDE.md` to drive Claude Code's context file directly (Sylo will **not** add `CLAUDE.md` to `.gitignore` in that case).
- **`cursor`** — starts the file with `<!-- @cursor-context -->`, formats errors as inline `TODO:` comments, and turns "Next action" into a numbered task list.
- **`copilot`** — trims to ~200 words, keeping only "What's being worked on" and "Next action" for Copilot Chat's smaller context window.
- **`generic`** — the full structured format shown above.

If a generated file exceeds ~1500 tokens, Sylo warns you in the panel and suggests the `copilot` target.

---

## Privacy

- Your code never leaves your machine (except to your own API).
- No screen recording, no keystroke logging, no clipboard access without your action.
- Sylo reads only open file metadata, cursor position, git diff, and error messages.
- The context snapshot goes directly from VS Code to your own API key — Sylo never sees it.
- All snapshot history is kept in VS Code's `globalState`, never on a server.
- `SYLO_CONTEXT.md` is automatically added to `.gitignore` (unless you point `agentContextPath` at `CLAUDE.md`).

---

## Local development

This is an npm-workspaces monorepo.

```bash
# install everything
npm install

# extension
cd packages/extension
npm run build      # bundle with esbuild → dist/extension.js
npm run watch      # rebuild on change
# then press F5 in VS Code to launch an Extension Development Host

# landing page
cd packages/web
npm run dev        # Vite dev server
npm run build      # production build → dist/
```

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
