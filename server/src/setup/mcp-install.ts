// Cleanup-only remnant of the MCP era.
//
// Tab Zero used to ship an MCP server and register it into every agent harness it could detect. The
// agent-facing surface is now the `tabzero` CLI instead (see cli.ts), so the install paths are gone —
// but the *removal* paths have to stay for a while: a harness that still has a `tabzero` entry
// pointing at the deleted server/dist/mcp.js reports a failed MCP server on every single launch.
// `tabzero mcp-cleanup` (and `tabzero uninstall`) purge those entries.
//
// Safe to delete this file entirely once the old registrations are gone from the wild.
import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir, platform } from 'node:os';
import { spawnSync } from 'node:child_process';

export interface CleanupResult {
  ok: boolean;
  detail: string;
}

export interface Target {
  id: string;
  name: string;
  uninstall: () => CleanupResult;
}

const NAME = 'tabzero';
const NOT_PRESENT = 'not present';
const home = (...p: string[]) => join(homedir(), ...p);

function appSupport(app: string): string {
  if (platform() === 'darwin') return home('Library', 'Application Support', app);
  if (platform() === 'win32') return join(process.env.APPDATA || home('AppData', 'Roaming'), app);
  return home('.config', app); // linux
}

function readJson(path: string): Record<string, any> | null {
  if (!existsSync(path)) return {};
  try {
    const raw = readFileSync(path, 'utf8').trim();
    return raw ? JSON.parse(raw) : {};
  } catch {
    return null; // malformed / JSONC we won't risk rewriting
  }
}

function writeJson(path: string, obj: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path)) copyFileSync(path, path + '.tabzero-bak'); // back up before every rewrite
  writeFileSync(path, JSON.stringify(obj, null, 2) + '\n');
}

/** Remove NAME from a nested key path in a JSON config, e.g. ['mcpServers'] or ['mcp','servers']. */
function removeJsonPath(path: string, keys: string[]): CleanupResult {
  if (!existsSync(path)) return { ok: true, detail: NOT_PRESENT };
  const cfg = readJson(path);
  if (cfg === null) return { ok: false, detail: `couldn't parse ${path} (left untouched)` };
  let node: Record<string, any> = cfg;
  for (const k of keys) {
    if (typeof node?.[k] !== 'object' || node[k] === null) return { ok: true, detail: NOT_PRESENT };
    node = node[k];
  }
  if (!Object.prototype.hasOwnProperty.call(node, NAME)) return { ok: true, detail: NOT_PRESENT };
  delete node[NAME];
  writeJson(path, cfg);
  return { ok: true, detail: `removed from ${path}` };
}

function jsonTarget(id: string, name: string, path: string, keys: string[]): Target {
  return { id, name, uninstall: () => removeJsonPath(path, keys) };
}

/** Claude Code owns a large managed ~/.claude.json, so let its own CLI do the edit. */
function claudeCode(): Target {
  return {
    id: 'claude-code',
    name: 'Claude Code',
    uninstall: () => {
      const r = spawnSync('claude', ['mcp', 'remove', NAME, '-s', 'user'], { stdio: 'ignore' });
      return { ok: true, detail: r.status === 0 ? 'claude mcp remove (user scope)' : NOT_PRESENT };
    },
  };
}

/** Codex keeps MCP servers as TOML tables; drop the [mcp_servers.tabzero] block and its keys. */
function codex(): Target {
  const path = home('.codex', 'config.toml');
  const header = `[mcp_servers.${NAME}]`;
  return {
    id: 'codex',
    name: 'Codex',
    uninstall: () => {
      if (!existsSync(path)) return { ok: true, detail: NOT_PRESENT };
      const body = readFileSync(path, 'utf8');
      if (!body.includes(header)) return { ok: true, detail: NOT_PRESENT };
      const out: string[] = [];
      let skip = false;
      for (const ln of body.split('\n')) {
        if (ln.trim() === header) { skip = true; continue; } // drop the block header…
        if (skip && /^\s*\[/.test(ln)) skip = false; // …and its keys until the next TOML table
        if (!skip) out.push(ln);
      }
      copyFileSync(path, path + '.tabzero-bak');
      writeFileSync(path, out.join('\n').replace(/\n{3,}/g, '\n\n'));
      return { ok: true, detail: `removed from ${path}` };
    },
  };
}

/** Hermes stores MCP servers as indentation-sensitive YAML — let its CLI own the edit. */
function hermes(): Target {
  return {
    id: 'hermes',
    name: 'Hermes',
    uninstall: () => {
      const r = spawnSync('hermes', ['mcp', 'remove', NAME], { stdio: 'ignore' });
      return { ok: true, detail: r.status === 0 ? 'hermes mcp remove' : NOT_PRESENT };
    },
  };
}

export function allTargets(): Target[] {
  return [
    claudeCode(),
    jsonTarget('claude-desktop', 'Claude Desktop', join(appSupport('Claude'), 'claude_desktop_config.json'), ['mcpServers']),
    jsonTarget('cursor', 'Cursor', home('.cursor', 'mcp.json'), ['mcpServers']),
    jsonTarget('windsurf', 'Windsurf', home('.codeium', 'windsurf', 'mcp_config.json'), ['mcpServers']),
    jsonTarget('vscode', 'VS Code', join(appSupport('Code'), 'User', 'mcp.json'), ['servers']),
    jsonTarget('opencode', 'opencode', home('.config', 'opencode', 'opencode.json'), ['mcp']),
    codex(),
    jsonTarget('pi', 'Pi', home('.pi', 'agent', 'mcp.json'), ['mcpServers']),
    hermes(),
    jsonTarget('openclaw', 'OpenClaw', home('.openclaw', 'openclaw.json'), ['mcp', 'servers']),
  ];
}

/** Purge every stale Tab Zero MCP registration. Returns one line per target that had something. */
export function cleanupAll(): string[] {
  const lines: string[] = [];
  for (const t of allTargets()) {
    const r = t.uninstall();
    if (r.detail !== NOT_PRESENT) lines.push(`${r.ok ? '✓' : '✗'} ${t.name} — ${r.detail}`);
  }
  return lines;
}
