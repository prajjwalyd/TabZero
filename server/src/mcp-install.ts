// Registers (and removes) the Tab Zero MCP server in the config of every agent harness the user
// has installed. Each harness uses a different schema/location, so every target owns its own
// detect + install + uninstall. All writers are defensive: they back up the file first and merge
// (never clobber) other servers. A failed target reports an error instead of throwing, so one bad
// harness can't sink the rest.
import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir, platform } from 'node:os';
import { spawnSync } from 'node:child_process';

export interface McpCommand {
  command: string;
  args: string[];
}

export interface InstallResult {
  ok: boolean;
  detail: string;
}

export interface Target {
  id: string;
  name: string;
  hint: string;
  detected: () => boolean;
  install: (cmd: McpCommand) => InstallResult;
  uninstall: () => InstallResult;
}

const NAME = 'tabzero';
const home = (...p: string[]) => join(homedir(), ...p);

function appSupport(app: string): string {
  if (platform() === 'darwin') return home('Library', 'Application Support', app);
  if (platform() === 'win32') return join(process.env.APPDATA || home('AppData', 'Roaming'), app);
  return home('.config', app); // linux
}

function onPath(bin: string): boolean {
  const finder = platform() === 'win32' ? 'where' : 'which';
  try { return spawnSync(finder, [bin], { stdio: 'ignore' }).status === 0; } catch { return false; }
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

function backup(path: string): void {
  if (existsSync(path)) copyFileSync(path, path + '.tabzero-bak');
}

function writeJson(path: string, obj: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  backup(path);
  writeFileSync(path, JSON.stringify(obj, null, 2) + '\n');
}

/** Upsert into a `{ [rootKey]: { [NAME]: serverDef } }`-shaped JSON config (the common MCP shape). */
function upsertJson(path: string, rootKey: string, def: unknown): InstallResult {
  const cfg = readJson(path);
  if (cfg === null) return { ok: false, detail: `couldn't parse ${path} (left untouched)` };
  if (typeof cfg[rootKey] !== 'object' || cfg[rootKey] === null) cfg[rootKey] = {};
  cfg[rootKey][NAME] = def;
  writeJson(path, cfg);
  return { ok: true, detail: path };
}

/** Remove NAME from a `{ [rootKey]: { [NAME]: ... } }`-shaped JSON config. */
function removeJson(path: string, rootKey: string): InstallResult {
  if (!existsSync(path)) return { ok: true, detail: 'not present' };
  const cfg = readJson(path);
  if (cfg === null) return { ok: false, detail: `couldn't parse ${path} (left untouched)` };
  if (cfg[rootKey] && Object.prototype.hasOwnProperty.call(cfg[rootKey], NAME)) {
    delete cfg[rootKey][NAME];
    writeJson(path, cfg);
    return { ok: true, detail: `removed from ${path}` };
  }
  return { ok: true, detail: 'not present' };
}

// A JSON target: same file, same rootKey, differing only in the server def shape.
function jsonTarget(
  id: string, name: string, hint: string, path: string, rootKey: string,
  detected: () => boolean, def: (cmd: McpCommand) => unknown,
): Target {
  return {
    id, name, hint, detected,
    install: (cmd) => upsertJson(path, rootKey, def(cmd)),
    uninstall: () => removeJson(path, rootKey),
  };
}

function claudeCode(): Target {
  return {
    id: 'claude-code', name: 'Claude Code', hint: 'CLI',
    detected: () => onPath('claude'),
    install: (cmd) => {
      // Official CLI is the safe path — ~/.claude.json is large and managed, so we don't hand-edit it.
      // `add-json` errors if the server already exists, so remove first for an idempotent re-install.
      const json = JSON.stringify({ command: cmd.command, args: cmd.args });
      spawnSync('claude', ['mcp', 'remove', NAME, '-s', 'user'], { stdio: 'ignore' });
      const r = spawnSync('claude', ['mcp', 'add-json', NAME, '-s', 'user', json], { stdio: 'ignore' });
      return r.status === 0
        ? { ok: true, detail: 'claude mcp add-json (user scope)' }
        : { ok: false, detail: 'claude mcp add-json failed — run it manually' };
    },
    uninstall: () => {
      const r = spawnSync('claude', ['mcp', 'remove', NAME, '-s', 'user'], { stdio: 'ignore' });
      return { ok: true, detail: r.status === 0 ? 'claude mcp remove (user scope)' : 'not present' };
    },
  };
}

function codex(): Target {
  const path = home('.codex', 'config.toml');
  const header = `[mcp_servers.${NAME}]`;
  return {
    id: 'codex', name: 'Codex', hint: 'CLI',
    detected: () => onPath('codex') || existsSync(home('.codex')),
    install: (cmd) => {
      const block =
        `${header}\n` +
        `command = ${JSON.stringify(cmd.command)}\n` +
        `args = [${cmd.args.map((a) => JSON.stringify(a)).join(', ')}]\n`;
      let body = existsSync(path) ? readFileSync(path, 'utf8') : '';
      if (body.includes(header)) return { ok: true, detail: 'already present in config.toml' };
      mkdirSync(dirname(path), { recursive: true });
      backup(path);
      if (body && !body.endsWith('\n')) body += '\n';
      writeFileSync(path, body + (body ? '\n' : '') + block);
      return { ok: true, detail: path };
    },
    uninstall: () => {
      if (!existsSync(path)) return { ok: true, detail: 'not present' };
      const body = readFileSync(path, 'utf8');
      if (!body.includes(header)) return { ok: true, detail: 'not present' };
      const out: string[] = [];
      let skip = false;
      for (const ln of body.split('\n')) {
        if (ln.trim() === header) { skip = true; continue; } // drop the block header…
        if (skip && /^\s*\[/.test(ln)) skip = false; // …and its keys until the next TOML table
        if (!skip) out.push(ln);
      }
      backup(path);
      writeFileSync(path, out.join('\n').replace(/\n{3,}/g, '\n\n'));
      return { ok: true, detail: `removed from ${path}` };
    },
  };
}

export function allTargets(): Target[] {
  const server = (cmd: McpCommand) => ({ command: cmd.command, args: cmd.args });
  return [
    claudeCode(),
    jsonTarget('claude-desktop', 'Claude Desktop', 'app', join(appSupport('Claude'), 'claude_desktop_config.json'),
      'mcpServers', () => existsSync(appSupport('Claude')), server),
    jsonTarget('cursor', 'Cursor', 'editor', home('.cursor', 'mcp.json'),
      'mcpServers', () => existsSync(home('.cursor')), server),
    jsonTarget('windsurf', 'Windsurf', 'editor', home('.codeium', 'windsurf', 'mcp_config.json'),
      'mcpServers', () => existsSync(home('.codeium', 'windsurf')), server),
    jsonTarget('vscode', 'VS Code', 'Copilot', join(appSupport('Code'), 'User', 'mcp.json'),
      'servers', () => existsSync(appSupport('Code')), (cmd) => ({ type: 'stdio', command: cmd.command, args: cmd.args })),
    jsonTarget('opencode', 'opencode', 'CLI', home('.config', 'opencode', 'opencode.json'),
      'mcp', () => onPath('opencode') || existsSync(home('.config', 'opencode')),
      (cmd) => ({ type: 'local', command: [cmd.command, ...cmd.args], enabled: true })),
    codex(),
  ];
}
