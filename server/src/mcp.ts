// Tab Zero MCP server (stdio) — lets any agent (Claude Code, Codex, opencode, …) query your
// browsing memory. Reads the same SQLite the daemon writes; talks to Engram directly.
// IMPORTANT: nothing may write to stdout except MCP protocol frames (logs go to stderr).
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { getUserId } from './db.js';
import { searchTrails, getTrailDetail, getTrail, resurrectUrls, summarizeTrail, weekInTabs, getInterests } from './trails.js';
import { categoryPromptList, coerceToExisting } from './categories.js';

function text(obj: unknown) {
  return { content: [{ type: 'text' as const, text: typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2) }] };
}

const server = new McpServer({ name: 'tabzero', version: '0.1.0' });

const CATEGORY_HELP = categoryPromptList();

server.tool(
  'search_trails',
  'Search the user\'s browsing "research trails" (reconciled clusters of the tabs they had open) by natural language. ' +
    'Returns matching trails with labels, category, size, and why each matched. ' +
    'Leave the query empty to list all trails (optionally within one category). ' +
    'Pass a category to restrict results, e.g. only "travel" trails.',
  {
    query: z.string().default('').describe('what to look for, e.g. "GPU pricing research" or "that trip planning". Empty = list all trails.'),
    category: z.string().optional().describe(`optional category filter, one of: ${CATEGORY_HELP}`),
  },
  async ({ query, category }) => {
    const cat = coerceToExisting(category) ?? undefined; // ignore an unrecognized category rather than erroring
    const hits = await searchTrails(getUserId(), query, 8, { category: cat });
    return text(
      hits.map((h) => ({
        id: h.trail.id,
        label: h.trail.label,
        category: h.trail.category,
        pages: h.trail.pageCount,
        status: h.trail.status,
        matched: h.why,
        snippet: h.snippet,
      })),
    );
  },
);

server.tool(
  'get_trail',
  'Get full detail for one research trail: its recap summary and the list of pages/URLs.',
  { trail_id: z.string().describe('a trail id like "t_1a2b3c4d"') },
  async ({ trail_id }) => {
    const d = await getTrailDetail(trail_id, { summarize: true });
    return d ? text(d) : text({ error: 'trail not found' });
  },
);

server.tool(
  'resurrect_trail',
  'Resurrect a past research trail from a natural-language description (or a trail id). Returns a recap of where the user left off plus the exact URLs to reopen.',
  { query: z.string().describe('a trail id (t_...) or a description like "the Postgres indexing rabbit hole"') },
  async ({ query }) => {
    let id: string | null = query.startsWith('t_') && getTrail(query) ? query : null;
    if (!id) {
      const hits = await searchTrails(getUserId(), query, 1);
      id = hits[0]?.trail.id ?? null;
    }
    if (!id) return text({ error: 'no matching trail found' });
    const t = getTrail(id)!;
    const summary = await summarizeTrail(id);
    return text({ id, label: t.label, summary, urls: resurrectUrls(id) });
  },
);

server.tool(
  'week_in_tabs',
  'Get fun stats about the user\'s recent browsing: deepest rabbit hole, most-abandoned trail, late-night incidents, biggest time sink, etc.',
  async () => text(weekInTabs()),
);

server.tool(
  'research_interests',
  'The user\'s durable, cross-trail interests and ongoing projects — the themes they keep returning to across many separate trails, as derived by Engram from their browsing memory. Use this to personalize, to recall long-running threads, or to answer "what have I been into lately?".',
  async () => text(await getInterests(getUserId())),
);

await server.connect(new StdioServerTransport());
