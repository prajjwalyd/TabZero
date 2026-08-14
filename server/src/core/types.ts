// Domain types shared across the backend + MCP server.
// The extension talks to us over JSON so it keeps its own copy of the wire shapes.

export type EventType = 'open' | 'activate' | 'navigate' | 'close' | 'meta';

/** What the extension POSTs to /events. */
export interface TabEventInput {
  ts: number;
  type: EventType;
  tabId: number;
  openerTabId?: number | null;
  windowId?: number | null;
  url?: string | null;
  title?: string | null;
  favIconUrl?: string | null;
  description?: string | null;
  heading?: string | null;
}

export interface PageRow {
  canonical_url: string;
  url: string;
  title: string;
  domain: string;
  first_seen: number;
  last_seen: number;
  visit_count: number;
  total_dwell_ms: number;
  trail_id: string | null;
  tokens: string; // JSON string[]
  description: string | null;
}

export type TrailStatus = 'forming' | 'live' | 'dormant' | 'archived';

export interface TrailRow {
  id: string;
  label: string;
  one_liner: string | null;
  status: TrailStatus;
  created: number;
  last_active: number;
  liveness: number;
  summary: string | null;
  summary_source: string | null; // 'engram' | 'local' | 'heuristic' — local/heuristic are placeholders
  summary_dirty: number;
  label_dirty: number;
  engram_dirty: number;
  engram_ref: string | null;
  last_engram_push: number | null; // ts of last successful Engram push; gates background re-push cadence
  centroid: string; // JSON Record<string, number>
  page_count: number;
  session_count: number;
  category: string | null; // LLM-assigned category key; null falls back to the heuristic
}

/** Trail as returned to the extension / MCP callers. */
export interface TrailDTO {
  id: string;
  label: string;
  oneLiner: string | null;
  status: TrailStatus;
  liveness: number;
  pageCount: number;
  lastActive: number;
  createdAt: number;
  topDomain: string | null;
  category: string;
}

export interface PageDTO {
  url: string;
  title: string;
  domain: string;
  lastSeen: number;
  visitCount: number;
  dwellMs: number;
  description?: string | null;
}

export interface TrailDetail extends TrailDTO {
  summary: string | null;
  pages: PageDTO[];
}
