import { spawn, spawnSync } from 'node:child_process';
import { OPENROUTER_API_KEY, OPENROUTER_MODEL, CLAUDE_MODEL } from './config.js';

type LlmBackend = 'openrouter' | 'claude' | 'none';

function detectBackend(): LlmBackend {
  if (OPENROUTER_API_KEY) return 'openrouter';
  try {
    const r = spawnSync('claude', ['--version'], { timeout: 8000, stdio: 'ignore' });
    if (r.status === 0) return 'claude';
  } catch {
    /* not installed */
  }
  return 'none';
}

export const LLM_BACKEND: LlmBackend = detectBackend();

function viaClaude(prompt: string, system: string | undefined, timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    const args = ['-p', '--model', CLAUDE_MODEL, '--max-turns', '1', '--output-format', 'text'];
    if (system) args.push('--append-system-prompt', system);
    const child = spawn('claude', args, { stdio: ['pipe', 'pipe', 'ignore'] });
    let out = '';
    let settled = false;
    const finish = (v: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(v);
    };
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
      finish(null);
    }, timeoutMs);
    child.stdout.on('data', (d) => (out += d.toString()));
    child.on('error', () => finish(null));
    child.on('close', () => finish(out.trim() || null));
    child.stdin.on('error', () => {});
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

async function viaOpenRouter(
  prompt: string,
  system: string | undefined,
  maxTokens: number,
  timeoutMs: number,
): Promise<string | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const messages = [
      ...(system ? [{ role: 'system', content: system }] : []),
      { role: 'user', content: prompt },
    ];
    const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${OPENROUTER_API_KEY}`,
        'HTTP-Referer': 'https://github.com/tabzero',
        'X-Title': 'Tab Zero',
      },
      body: JSON.stringify({ model: OPENROUTER_MODEL, max_tokens: maxTokens, messages }),
      signal: ctrl.signal,
    });
    if (!r.ok) return null;
    const j: any = await r.json();
    const text = j?.choices?.[0]?.message?.content;
    return typeof text === 'string' ? text.trim() : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Best-effort text completion. Returns null (never throws) so callers fall back to heuristics. */
export async function llmText(
  prompt: string,
  opts: { system?: string; maxTokens?: number; timeoutMs?: number } = {},
): Promise<string | null> {
  const { system, maxTokens = 400, timeoutMs = 45000 } = opts;
  if (LLM_BACKEND === 'openrouter') return viaOpenRouter(prompt, system, maxTokens, timeoutMs);
  if (LLM_BACKEND === 'claude') return viaClaude(prompt, system, timeoutMs);
  return null;
}
