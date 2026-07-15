# Connecting Tab Zero to Weaviate Engram

Tab Zero works **without any key** — local trails, keyword search, categories, gated research interests, and "your week in tabs" all run offline. A Weaviate Engram key is optional and turns Engram into the **memory layer**:

- **Engram authors your recaps** — instead of a local model, Engram's pipeline extracts and *reconciles* one evolving summary per trail from the raw browsing signal, and rewrites it as the trail grows.
- **Semantic search** — resurrect a trail by meaning (*"that GPU I was looking at"*), not just keywords.
- **Cross-trail research interests** — Engram synthesizes the durable themes you keep returning to (only the ones that clear the local durability gate are ever sent).
- **Cross-agent memory** — the same reconciled memory any MCP agent (Claude Code, Codex, opencode…) can query.

Setup takes ~3 minutes and the free tier is plenty for personal use.

---

## 1. Create an Engram project

1. Go to the **[Weaviate Cloud console → Engram](https://console.weaviate.cloud/engram)** and sign in (free account).
2. **Create an Engram project.** Give it any name (e.g. `tabzero`).

## 2. Create the two topics

Engram organizes memories into **topics**. Tab Zero uses two — one per-trail recap, one for durable interests. The **description of each topic is what sets its tone and rules**, so paste these verbatim (tweak to taste).

### Topic A — `TrailSummary` (one evolving recap per trail)

| Field | Value |
|---|---|
| **Name** | `TrailSummary` |
| **User-scoped** | **On** |
| **Property scope** | add one: `trail_id` |
| **Bounded** | **On** — one memory per trail, rewritten as it grows |

**Description:**

```
A single research trail: the related web pages a person browsed while pursuing one goal or
question (planning a trip, evaluating a tool, debugging an error, learning a topic). Maintain
ONE evolving summary per trail, written as a short recap — about three sentences — in the
second person ("you"), so the person can pick the thread back up later. Cover, in flowing prose:
(1) what you were trying to figure out or do, (2) what you found or concluded, (3) where you
left off or what's still unfinished. Be concrete about the actual topic and name notable sources
inline. No preamble, no headings, no bullet points — just the recap. Always update the existing
summary rather than creating new fragments. Base it on the page titles, domains, descriptions,
and visit patterns provided.
```

### Topic B — `ResearchInterest` (durable cross-trail interests)

| Field | Value |
|---|---|
| **Name** | `ResearchInterest` |
| **User-scoped** | **On** |
| **Property scope** | add one: `interest_key` |
| **Bounded** | **On** — one evolving memory per interest |

**Description:**

```
A durable, higher-level interest, project, or conclusion the user has formed across MULTIPLE
separate trails or sessions — the themes they keep returning to (e.g. "evaluating vector
databases for a local-first app", "planning a September trip to Lisbon", "concluded RQ
quantization beats PQ for their use case").
Form an interest ONLY when a theme is durable: it recurs across more than one trail/session, or
reflects a sustained, deep investigation. Do NOT create an interest from a single trail, a one-off
lookup, or ephemeral/transactional browsing (a quick search, a purchase, checking the news) —
those remain trail summaries, not interests.
For each interest, capture its CURRENT state: what the user is pursuing and where it stands — the
open question, current leaning, or conclusion reached — and refine that state as new sessions add
to it.
Keep each interest concise: a short phrase or single sentence led by the activity ("evaluating…",
"planning…", "learning…", "concluded…"), scannable as a list item — not a paragraph.
Merge aggressively: when new browsing matches an existing interest, UPDATE and sharpen it rather
than spawning a near-duplicate. One evolving memory per genuine interest.
```

> Both are **user-scoped + property-scoped + bounded**, so Engram keeps exactly one evolving memory per `trail_id` / `interest_key` instead of piling up duplicates. Tab Zero already gates interests locally (a theme must be *recurring* or *deep* and still recent) and only asserts the survivors — so this topic is never fed the firehose. Rename the topics freely if you also set `TABZERO_TRAIL_TOPIC` / `TABZERO_INTEREST_TOPIC` to match.

## 3. Copy your API key

In the project settings, copy the **API key** (starts with `eng_…`).

## 4. Give it to Tab Zero

```bash
npx tabzero key      # paste the eng_… key when prompted
```

Restart the daemon (`npx tabzero start`) and the memory layer lights up. Confirm it worked: the popup's status-dot tooltip shows `engram on`, and search results tagged **MEMORY** (green) are coming from Engram. Trail recaps show a local placeholder first, then **upgrade to Engram's `you`-toned recap** on the next read once its extraction lands (the pipeline is async).

### Environment variables

Stored in `~/.tabzero/.env` (or the repo `.env` in dev):

| Variable | Default | Purpose |
|---|---|---|
| `ENGRAM_API_KEY` | — | Your `eng_…` key. Absent = fully offline. |
| `TABZERO_TRAIL_TOPIC` | `TrailSummary` | Match a differently-named recap topic. |
| `TABZERO_INTEREST_TOPIC` | `ResearchInterest` | Match a differently-named interest topic. |
| `TABZERO_USER_ID` | *(generated)* | Pin the user/Engram scope. Set it to reuse a fixed identity across resets/machines, or bump it for a clean slate. Overrides the stored id at runtime and isn't persisted, so removing it reverts. |

---

## How the memory model works

- **Tab Zero pushes RAW signal, not a finished summary** — the trail label plus one atomic fact per page (title · description · domain). Engram's pipeline does the extraction and bounded reconciliation, so the memory *evolves* as the trail recurs instead of being a blob we overwrite.
- **Engram authors the recap.** `summarizeTrail` prefers Engram's reconciled memory; a local `claude -p` / heuristic recap is only a placeholder shown until Engram's version lands, then it's replaced.
- **Interests are gated locally.** A trail/theme becomes an interest only if it's *recurring* (returned across ≥2 sessions) **or** *deep* (a big rabbit hole), **and** still recent. Only qualifying themes are asserted to Engram (`interest_key`-scoped), which then names/reconciles them. The MCP `research_interests` tool and `GET /interests` return these.

## Fresh start / reset

To rebuild from scratch with new topic descriptions:

1. Paste the updated descriptions in the Engram console **first** (so the first extraction uses them).
2. Stop the daemon.
3. `pnpm reset` — wipes the local DB. A fresh `user_id` is generated on next start (or pin one with `TABZERO_USER_ID`), giving a clean Engram scope.
4. `pnpm seed` *(optional demo data)* → `pnpm backend`.

Engram has **no delete-all** in its REST API, so a new `user_id` is how you get a clean slate — old memories stay orphaned under the previous id (harmless; search skips trails that no longer exist locally). Purge them in the console if you want the storage/quota back.

## Notes

- **Free tier:** 1,000 pipeline runs/month. Tab Zero pushes at trail/session grain (settle-gated + a per-trail re-push guard), never per tab — comfortably within budget for personal browsing.
- **Privacy:** only page **titles**, **domains**, and the **public preview text** sites already publish (OpenGraph / meta description / the visible `h1`) are sent — never full page body, never anything you typed, never screenshots. Raw URLs stay local.
- **Rebuildable:** the local DB (`~/.tabzero/tabzero.db`) is the source of truth, so your Engram memories can be fully replayed from it.
- **Change the key later:** rerun `npx tabzero key`.
- **MCP tools exposed:** `search_trails`, `get_trail`, `resurrect_trail`, `week_in_tabs`, `research_interests`.
