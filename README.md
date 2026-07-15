# Tab Zero

**Close every tab guilt-free. Your browser remembers *why* each one was open — and any AI agent can resurrect the research on command.**

Tab Zero watches your tab stream, reconciles it into semantic **research trails** ("RTX 5090 GPU pricing research · 4 tabs · live"), and lets you:

- **Reach Tab Zero** — nuke all your open tabs in one click. Nothing is lost; every trail stays reconstructable.
- **Resurrect** — reopen the exact tab constellation of any past trail, with a recap of *where you left off and what you concluded*.
- **Query it from your agents** — an MCP server exposes your browsing memory to Claude Code, Codex, opencode, and any MCP-aware harness.
- **Your week in tabs** — deepest rabbit hole, most-abandoned trail, 3am incident… screenshot bait.

Reconciled memory is backed by **[Weaviate Engram](https://weaviate.io/product/engram)**; the exact-reopen source of truth is a local SQLite log. Design details in [PLAN.md](PLAN.md).

---

## Architecture (30-second version)

```
Chrome extension (MV3)  ──localhost HTTP──▶  Node daemon ──▶  SQLite (raw log + trails)
  capture + popup UI                          reconcile        └▶ Weaviate Engram (reconciled memory)
                                              decay + LLM       └▶ OpenRouter / local `claude -p`
        any agent (Claude Code / Codex / opencode) ──stdio──▶  MCP server (same code, same DB)
```

- **Local layer** (SQLite) = instant trails + exact-reopen truth + decay.
- **Engram** = cross-time reconciliation (bounded per-trail memory) + semantic recall.
- The LLM (OpenRouter, or your local `claude -p`) only names trails and writes resurrect summaries — never in the hot path.

---

## Prerequisites

- **Node ≥ 22.5** (uses the built-in `node:sqlite`) and **pnpm**
- A **Weaviate Engram** project with an API key → put it in `.env` at the repo root:
  ```
  ENGRAM_API_KEY=eng_xxxxxxxx
  ```
- **LLM (optional):** if `OPENROUTER_API_KEY` is set it's used; otherwise Tab Zero shells out to a local **`claude`** (`claude -p`) if installed; otherwise it falls back to heuristic labels/summaries. Everything works offline except Engram sync and LLM prose.

### Engram project setup (one-time, in the console)

Create these two topics at [console.weaviate.cloud/engram](https://console.weaviate.cloud/engram):

| Topic | User scoped | Property scopes | Bounded |
|---|---|---|---|
| `TrailSummary` | ✅ | `trail_id` | ✅ |
| `ResearchInterest` | ✅ | — | ☐ |

`TrailSummary` (bounded + `trail_id`-scoped) holds one evolving memory per trail; `ResearchInterest` accrues cross-trail interests. See [PLAN.md](PLAN.md) for the reasoning.

---

## Quick start (anyone)

```bash
npx tabzero
```

A guided setup stages the extension, optionally takes a [Weaviate Engram key](docs/engram.md), offers to register the MCP into your AI tools, and starts the daemon. Then, once:

1. Open `chrome://extensions` (Chrome, Edge, Brave, Arc…) and enable **Developer mode**.
2. **Load unpacked** → the folder the wizard printed (`~/.tabzero/extension`).
3. Pin **Tab Zero** and click it. Browse a bit; trails appear automatically.

No key needed to start — Tab Zero runs in **local mode** and you can add an Engram key anytime with `npx tabzero key`. Other commands: `npx tabzero start` · `npx tabzero mcp install` · `npx tabzero path`.

## Run from source (dev)

```bash
pnpm install
pnpm build:server   # compiles the MCP entrypoint
pnpm build:ext      # bundles the extension -> extension/dist
pnpm backend        # start the daemon (keep running)
```

Load unpacked from `extension/dist`. Dev loop: `pnpm watch:ext` + `pnpm backend:dev`.

---

## Use your browsing memory from any agent (MCP)

The MCP server exposes four tools: `search_trails`, `get_trail`, `resurrect_trail`, `week_in_tabs`. Transport is **stdio** (works across every harness).

> Run `pnpm build:server` once so `server/dist/mcp.js` exists.

**Claude Code** — already wired via [`.mcp.json`](.mcp.json) in this repo. Just run `claude` here and try:
> *"resurrect my GPU pricing research"* · *"what's my most abandoned trail this week?"*

**Codex** — add to `~/.codex/config.toml`:
```toml
[mcp_servers.tabzero]
command = "node"
args = ["/ABSOLUTE/PATH/TO/TabZero/server/dist/mcp.js"]
```

**opencode** — add to `opencode.json`:
```jsonc
{ "mcp": { "tabzero": { "type": "local", "command": ["node", "/ABSOLUTE/PATH/TO/TabZero/server/dist/mcp.js"] } } }
```

---

## Configuration (env, all optional except the Engram key)

| Var | Default | Purpose |
|---|---|---|
| `ENGRAM_API_KEY` | — | Weaviate Engram key (reconciled memory) — [setup guide](docs/engram.md) |
| `OPENROUTER_API_KEY` | — | Use OpenRouter for LLM instead of local `claude` |
| `OPENROUTER_MODEL` | `deepseek/deepseek-v4-flash` | Chat model when using OpenRouter |
| `TABZERO_CLAUDE_MODEL` | `haiku` | Model alias for the local `claude -p` path |
| `TABZERO_PORT` | `8787` | Daemon port (also update `extension/src/config.ts`) |
| `TABZERO_TOKEN` | `tabzero-dev` | Shared secret between extension and daemon |

Data lives in `./.tabzero/tabzero.db` (SQLite, WAL). Because it's the source of truth, your Engram project is fully rebuildable by replaying it.

---

## Repo layout

```
server      Node daemon + trail engine + Engram client + MCP server (TypeScript)
extension   MV3 extension: capture (background) + popup UI (TypeScript, esbuild)
PLAN.md     Full design doc + research + sources
```

## Privacy

Tab **metadata + trails only — never screen recordings.** Reconciled memory (page titles/URLs) goes to Weaviate Cloud via Engram; the raw event log stays local. A fully-local mode is on the roadmap.
