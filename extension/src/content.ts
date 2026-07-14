// Cheap, metadata-only page enrichment. We read ONLY the descriptors a site already
// publishes for link previews (OpenGraph / meta description / the visible h1 or lead
// paragraph) — never the full body, never anything the user typed. Runs once at idle.
function metaContent(sel: string): string | null {
  const el = document.querySelector(sel) as HTMLMetaElement | null;
  const v = el?.content?.trim();
  return v && v.length > 2 ? v : null;
}

function firstText(sel: string): string | null {
  const el = document.querySelector(sel);
  const t = el?.textContent?.replace(/\s+/g, ' ').trim();
  return t && t.length > 2 ? t : null;
}

function clip(s: string | null, n: number): string | null {
  return s ? s.replace(/\s+/g, ' ').trim().slice(0, n) : null;
}

function collect(): { url: string; description: string | null; heading: string | null } {
  const description =
    metaContent('meta[property="og:description"]') ||
    metaContent('meta[name="description"]') ||
    metaContent('meta[name="twitter:description"]') ||
    firstText('article p') ||
    firstText('main p') ||
    null;
  const heading =
    metaContent('meta[property="og:title"]') ||
    firstText('h1') ||
    null;
  return { url: location.href, description: clip(description, 320), heading: clip(heading, 160) };
}

try {
  const m = collect();
  if (m.description || m.heading) chrome.runtime.sendMessage({ type: 'meta', ...m });
} catch {
  /* some pages block extension messaging; nothing to do */
}

export {};
