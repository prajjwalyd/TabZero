<div align="center">

<img src="docs/images/logo.png" alt="Tab Zero logo — a cream ensō on a sage rounded tile" width="112" />

# Tab Zero

**Close every tab guilt-free. Your browser remembers _why_ each one was open — and any AI agent can resurrect the research on command.**

_Reconciled memory powered by [Weaviate Engram](https://weaviate.io/product/engram)._

<img src="docs/images/hero.png" alt="Tab Zero — a browser full of tabs collapsing into a calm 'Tab Zero. Nothing lost.' screen" width="820" />

</div>

---

Tab Zero watches your tab stream, reconciles it into semantic **research trails** — _"RTX 5090 GPU pricing research · 4 tabs · live"_ — and lets you:

- **Reach Tab Zero** — nuke every open tab in one click. Nothing is lost; every trail stays reconstructable.
- **Resurrect** — reopen the exact tab constellation of any past trail, with a recap of _where you left off and what you concluded_.
- **Query it from your agents** — a `tabzero` CLI exposes your browsing memory to Claude Code, Codex, opencode, or any agent with a shell. Nothing to install, nothing to restart.
- **Your week in tabs** — deepest rabbit hole, most-abandoned trail, 3am incident… screenshot bait.

The exact-reopen source of truth is a local SQLite log; the reconciled, evolving memory lives in **Weaviate Engram**.

<div align="center">
<img src="docs/images/popup-trails.png" alt="Tab Zero popup showing reconciled research trails with category pills" width="340" />
</div>

---

## How it works (30-second version)

```
Chrome extension (MV3)  ──localhost HTTP──▶  Node daemon  ──▶  SQLite (raw log + trails)
  capture + popup UI                          reconcile         └▶ Weaviate Engram (reconciled memory)
                                              decay + LLM        └▶ OpenRouter / local `claude -p`
        any agent (Claude Code / Codex / opencode) ──`tabzero` CLI──▶  same daemon, same DB
```

- **Local layer** (SQLite) = instant trails + exact-reopen truth + decay. Runs in real time, fully offline.
- **Engram** = cross-time reconciliation (one bounded, evolving memory per trail) + semantic recall + agent-queryable memory. Catches up asynchronously; the UI never waits on it.
- The **LLM** (OpenRouter, or your local `claude -p`) only names trails and writes recap summaries — never in the hot path.

Every heuristic — canonicalize, dedup, sessionize, cluster, decay — is math on-device.

---

## Prerequisites

- **Node ≥ 22.5** (uses the built-in `node:sqlite`) and **pnpm**.
- _Optional_ — a **Weaviate Engram** project + API key for the memory layer. Without it, Tab Zero runs in **local mode**: trails, keyword search, categories, gated interests, and "your week in tabs" all still work.
- _Optional_ — an **LLM** for prose. If `OPENROUTER_API_KEY` is set it's used; otherwise Tab Zero shells out to a local **`claude`** (`claude -p`) if installed; otherwise it falls back to heuristic labels/summaries.

---

## Quick start

```bash
npx tabzero
```

A guided wizard stages the extension, optionally takes a [Weaviate Engram key](docs/engram.md), and starts the daemon. Then:

1. Open `chrome://extensions` (Chrome, Edge, Brave, Arc…) and enable **Developer mode**.
2. **Load unpacked** → the folder the wizard printed (`~/.tabzero/extension`).
3. Pin **Tab Zero**, click it, and browse a bit — trails appear automatically.

No key needed to start. Add an Engram key anytime with `npx tabzero key`.
Other commands: `npx tabzero start` · `npx tabzero path` · `npx tabzero uninstall` · `npx tabzero help`.

### Run from source (dev)

```bash
pnpm install
pnpm build:server        # compiles the daemon + CLI -> server/dist
pnpm build:ext           # bundles the extension -> extension/dist
pnpm backend             # start the daemon (keep it running)
```

Load unpacked from `extension/dist`. Dev loop: `pnpm watch:ext` + `pnpm backend:dev`.

**Demo data** (for screenshots / a first look, run with the daemon stopped):

```bash
pnpm seed                # add realistic demo trails on top of what's there
pnpm seed --reset        # wipe events/pages/trails first, then seed
pnpm seed --reset --enrich   # also run the LLM label + recap pass inline
pnpm reset               # full fresh start: wipe the local DB (new user_id on next boot)
```

---

## Connect Engram

Engram turns Tab Zero's memory from local placeholders into a **reconciled, evolving, semantic** layer. Full setup (project + the two topics + descriptions to paste) is in **[docs/engram.md](docs/engram.md)** — the short version:

Create two topics at [console.weaviate.cloud/engram](https://console.weaviate.cloud/engram):

| Topic | User-scoped | Property scope | Bounded | Role |
|---|:---:|---|:---:|---|
| `TrailSummary` | ✅ | `trail_id` | ✅ | one evolving recap per trail |
| `ResearchInterest` | ✅ | _(none)_ | ✅ | durable cross-trail interests |

Then `npx tabzero key`, paste your `eng_…` key, and restart the daemon. The popup's status-dot tooltip will read `engram on`, and search results tagged **memory** (green) are coming from Engram.

---

## Use your browsing memory from any agent

There's no plugin to install and nothing to restart: any agent with shell access can query your
trails through the `tabzero` command. Point it at these once (a line in `CLAUDE.md`, `AGENTS.md`, or
your system prompt) and it can pull your browsing memory on demand.

| Command | What it does |
|---|---|
| `tabzero search [query]` | Natural-language search over your trails (empty query lists all) |
| `tabzero trails [--all]` | Every trail, newest first; `--all` also includes archived (quiet >30 days) |
| `tabzero trail <id\|query>` | One trail's recap + its page list |
| `tabzero resurrect <query>` | Recap + the exact URLs to reopen, from a query or id |
| `tabzero week` | The vanity stats (rabbit holes, abandoned trails, 3am incidents…) |
| `tabzero interests` | The durable themes you keep returning to across many trails |

Add `--json` to any of them for machine-readable output — that's the form an agent should use:

```bash
tabzero search "gpu pricing" --json
```

They query the running daemon over HTTP, so `tabzero start` has to be up (it needs to be anyway, to
capture anything). Exit code is non-zero with a message on stderr when it isn't.

Try it with any agent: _"resurrect my GPU pricing research"_ · _"what's my most abandoned trail this
week?"_ · _"what have I been into lately?"_

---

## Your week in tabs

Wrapped-style stats derived entirely from tab metadata — deepest rabbit hole, boomerang page, biggest time sink, most-abandoned trail, late-night incident, tab-hoarding peak. Screenshot bait for the launch follow-up.

---

## Configuration

Env vars (all optional). In dev they load from `.env` at the repo root; installed, from `~/.tabzero/.env`.

| Var | Default | Purpose |
|---|---|---|
| `ENGRAM_API_KEY` | — | Weaviate Engram key (reconciled memory) — [setup guide](docs/engram.md) |
| `OPENROUTER_API_KEY` | — | Use OpenRouter for the LLM instead of local `claude` |
| `OPENROUTER_MODEL` | `deepseek/deepseek-v4-flash` | Chat model when using OpenRouter |
| `TABZERO_CLAUDE_MODEL` | `haiku` | Model alias for the local `claude -p` path |
| `TABZERO_USER_ID` | _(generated)_ | Pin the user / Engram scope; bump it for a clean slate |
| `TABZERO_TRAIL_TOPIC` | `TrailSummary` | Match a differently-named recap topic |
| `TABZERO_INTEREST_TOPIC` | `ResearchInterest` | Match a differently-named interest topic |
| `TABZERO_PORT` | `8787` | Daemon port — also set `BACKEND` in `extension/src/config.ts` and rebuild |
| `TABZERO_TOKEN` | _(generated)_ | Pin the extension↔daemon secret; by default a random one is minted per install into `<data dir>/token` |
| `TABZERO_ENGRAM_TIMEOUT_MS` | `15000` | Hard cap on any Engram call so a slow endpoint can't hang the daemon |
| `TABZERO_DEBUG` | — | Set to `1` for verbose Engram retrieval logs |

Data lives in `./.tabzero/tabzero.db` (SQLite, WAL) in dev, or `~/.tabzero/tabzero.db` when installed. Because the raw log is the source of truth, your Engram project is fully rebuildable by replaying it.

The daemon guards that database with four things, and it needs all four:

- **binds `127.0.0.1` only** — never `0.0.0.0`, so nothing on your network can reach it;
- **a per-install random token** (`randomUUID`, stored `0600`) on every route but `/health` — not a shared constant, so one leaked token isn't every install;
- **no CORS headers**, so a web page can send a request but cannot read the reply;
- **a `Host` allowlist** rejecting anything but loopback. This is what stops **DNS rebinding**: a page on `evil.com` re-resolved to `127.0.0.1` arrives as *same-origin*, where CORS is never consulted — so "no CORS headers" alone would have let it read `/health` and take the token. `server/test/http.test.ts` pins this.

Bodies are capped at 4MB and malformed JSON is a `400`. Note that anything already holding the token can read and write your trails — treat it like a credential.

On disk, the data dir is `0700` and the database, its `-wal`/`-shm`, the token, and `.env` are all `0600`, re-applied on every start (the default umask would create them world-readable). `ENGRAM_BASE` must be `https://` — it's checked at boot, because every Engram request carries your API key alongside your page titles.

**Two privacy layers sit in front of anything leaving the device**, separate from URL canonicalization (which is only a dedup key, never a privacy filter):

- **Auth flows are never captured.** Sign-in, OAuth, password-reset, email-verification and checkout pages are dropped before anything is written.
- **Secrets are stripped from what is captured.** `?token=`, `?code=`, `?email=`, session ids, presigned signatures and high-entropy values become `REDACTED`. Your search queries are deliberately preserved — they're the most useful signal a trail has.
- **Titles and descriptions are scrubbed before they reach an LLM or Engram** — email addresses, JWTs, card-shaped numbers, encoded blobs. The topic itself is left intact, because a recap without specifics is worthless.
- Page titles are treated as **untrusted input** in every prompt, since a site chooses its own title and could otherwise attempt prompt injection against a recap that agents later read.

---

## Repo layout

```
server/         Node daemon + trail engine + Engram client + agent CLI (TypeScript)
  src/
    index.ts        daemon entrypoint (HTTP + scheduler)
    cli.ts          the `tabzero` command (setup + the agent-facing query surface)
    core/           config.ts, db.ts (schema + handle), types.ts, llm.ts (backend adapter)
    capture/        canonical.ts   URL canonicalization + embedding-free lexical vectors
                    pipeline.ts    ingestion: canonicalize -> dedup -> tokenize -> cluster
    trails/         trails.ts      read models, decay/liveness, LLM labels + recaps, search
                    categories.ts  growable, LLM-driven category vocabulary
                    checkpoint.ts  the "tab zero" moment: snapshot -> finalize -> flush
    engram/         client.ts      defensive REST client for Weaviate Engram
                    sync.ts        enrichment passes + Engram flush (settle-gated)
    daemon/         http.ts        localhost API the extension talks to
                    scheduler.ts   adaptive, backing-off enrichment scheduler
    scripts/        seed.ts (demo data) · reset.ts (clean slate)
  test/           hermetic units — canonicalization, decay, clustering, replay (`pnpm test`)
                  e2e.mts — full lifecycle vs a real daemon + LLM + Engram (`pnpm test:e2e`)
extension/      MV3 extension: capture (background) + popup UI (TypeScript, esbuild)
docs/           engram.md (Engram setup) · images/ (screenshots)
```

---

## Privacy

Tab **metadata + trails only — never screen recordings, never full page bodies.** Only page **titles**, **domains**, and the **public preview text** sites already publish (OpenGraph / meta description / the visible `h1`) are sent to Engram; raw URLs and the event log stay **local**.
