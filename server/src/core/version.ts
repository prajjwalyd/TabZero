// Single source of truth for the version: the root package.json. Keeps the MCP server's advertised
// version from drifting out of sync with the package (the extension manifest is stamped at build
// time — see extension/build.mjs). Works in dev and when packaged: server/src/core and
// server/dist/core are both exactly three levels below the package root.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

function read(): string {
  try {
    const p = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'package.json');
    return JSON.parse(readFileSync(p, 'utf8')).version || '0.0.0';
  } catch {
    return '0.0.0'; // never let a missing manifest take down the MCP server
  }
}

export const VERSION = read();
