# Connecting Tab Zero to Weaviate Engram

Tab Zero works **without any key** — local trails, keyword search, categories, and "your week in tabs" all run offline. A Weaviate Engram key is optional and unlocks two things:

- **Semantic search** — resurrect a trail by meaning (*"that GPU I was looking at"*), not just keywords.
- **Cross-agent memory** — the same reconciled memory any MCP agent (Claude Code, Codex, opencode…) can query.

Setup takes ~2 minutes and the free tier is plenty for personal use.

---

## 1. Create an Engram project

1. Go to the **[Weaviate Cloud console → Engram](https://console.weaviate.cloud/engram)** and sign in (free account).
2. **Create an Engram project.** Give it any name (e.g. `tabzero`).

## 2. Create the topic Tab Zero writes to

Engram organizes memories into **topics**. Tab Zero pushes one reconciled memory per research trail, so create a single topic:

| Field | Value |
|---|---|
| **Name** | `TrailSummary` |
| **Description** | `A summary of one browsing research trail: what the user was investigating and the pages involved.` |
| **User-scoped** | **On** (memories are per-user) |
| **Property scope** | add one: `trail_id` |
| **Bounded** | **On** — keeps exactly one memory per trail and rewrites it as the trail grows |

> The name **must be `TrailSummary`** (or set `TABZERO_TRAIL_TOPIC` to match a different name). The `trail_id` property scope + **Bounded** are what let Engram maintain one evolving memory per trail instead of piling up duplicates.

## 3. Copy your API key

In the project settings, copy the **API key** (starts with `eng_…`).

## 4. Give it to Tab Zero

```bash
npx tabzero key      # paste the eng_… key when prompted
```

That's it — restart the daemon (`npx tabzero start`) and semantic search + agent memory light up. You can confirm it worked: the popup's status dot tooltip shows `engram on`, and search results tagged **MEMORY** (green) are coming from Engram.

---

## Notes

- **Free tier:** 1,000 pipeline runs/month — comfortably enough for personal browsing.
- **Privacy:** only the reconciled *trail summary* (label + a list of page titles/domains) is sent to Engram — never full page content, never screenshots. Raw URLs stay local.
- **Rebuildable:** the local DB (`~/.tabzero/tabzero.db`) is the source of truth, so your Engram memories can be fully replayed from it if needed.
- **Change the key later:** rerun `npx tabzero key`. It's stored in `~/.tabzero/.env`.
