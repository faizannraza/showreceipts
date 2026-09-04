/**
 * The single-file HTML report (ARCHITECTURE §11.1, S22): one self-contained
 * document — `<meta charset>`, a hash-locked Content-Security-Policy meta as
 * the very next head child, `<title>`, the ~150-byte theme bootstrap, the
 * inline stylesheet, the app shell, the JSON data block and the app script.
 * Exactly three `<script>` elements ever exist; the data block is inert
 * (`type="application/json"`) and every `<`, `>`, `&`, U+2028 and U+2029 in
 * it is embedded as a `\uXXXX` JSON escape, so no transcript-derived string
 * can close the block or open a tag.
 *
 * CSP hashes are computed at render time over the exact UTF-8 text of the
 * three hashed inline blocks (bootstrap, style, app script) — there is no
 * `'unsafe-inline'` anywhere. {@link selfCheck} re-derives the hashes from
 * an emitted document so tests (and `--self-check`) can prove the bytes
 * match.
 *
 * `--hash-paths` (§11.2) is the S18 `hashStrings` final pass over every
 * string of the payload (each session hashed against its own cwd, the rate
 * rows against none); `both` embeds the clear payload plus a second, hashed
 * payload and the app's toggle switches between them. The salt never appears
 * in the output.
 *
 * The app script is read at runtime with
 * `readFileSync(new URL('./report.js', import.meta.url))`; the S12b build
 * rule copies `src/render/report.js` to `dist/render/report.js` byte-for-
 * byte, so the same code serves both trees.
 */
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Receipt, ReportPayload } from '../model/types.js';
import { hashStrings } from '../util/hashpaths.js';
import { stableStringify } from '../util/json.js';
import { buildCss } from './html-css.js';
import { payloadKey } from './payload.js';

/** `--hash-paths` modes: `off` (clear), `on` (hashed only), `both` (toggle). */
export type HashPathsMode = 'off' | 'on' | 'both';

export interface RenderHtmlOptions {
  /** The §11.2 mode (default `off`). */
  hashPaths?: HashPathsMode | undefined;
  /** Salt of the hash pass; default: 32 random hex chars (never emitted). */
  salt?: string | undefined;
  /** §11.2 bare tokens (home dir, username) rewritten to `u:<hex>` wherever they appear. */
  extraTokens?: readonly string[] | undefined;
  /** Document title (static, renderer-owned — escaped anyway). */
  title?: string | undefined;
}

/** The parsed shape of the embedded `#data` block (§11.1). */
export interface ReportData {
  mode: 'clear' | 'hashed' | 'both';
  payload: ReportPayload;
  /** `both` only: the second, hashed payload the toggle switches to. */
  hashed?: ReportPayload;
}

/**
 * The theme bootstrap (§11.1): applied before first paint so an explicit
 * choice never flashes the wrong palette. Storage access is try/caught —
 * a file:// or sandboxed context may throw on the accessor itself.
 */
export const THEME_BOOTSTRAP =
  "(function(){var t;try{t=localStorage.getItem('showreceipts.theme')}catch(e){}" +
  "if(t==='dark'||t==='light'){document.documentElement.setAttribute('data-theme',t)}})();";

let reportJsCache: string | null = null;

/** The app script text, trailing newline stripped (the hash covers the exact embedded bytes). */
function reportJs(): string {
  if (reportJsCache === null) {
    reportJsCache = readFileSync(new URL('./report.js', import.meta.url), 'utf8').replace(/\n$/, '');
  }
  return reportJsCache;
}

/**
 * Escapes serialised JSON for embedding in the inert data block: every `<`,
 * `>`, `&`, U+2028 and U+2029 becomes a `\uXXXX` escape *inside the JSON
 * text* (these characters only ever occur within string literals, so the
 * JSON stays valid and `JSON.parse` round-trips exactly). This is the only
 * place data is serialised into HTML.
 */
export function embedJson(json: string): string {
  return json.replace(/[<>&\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

/** A CSP source token for one inline block: `'sha256-<base64 of the exact UTF-8 text>'`. */
function cspHash(text: string): string {
  return `'sha256-${createHash('sha256').update(text, 'utf8').digest('base64')}'`;
}

/** Minimal text escape for renderer-owned head text (the title). */
function escapeText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** The §11.2 pass over a whole payload: each session against its own cwd, rows against none. */
function hashedCopy(payload: ReportPayload, salt: string, extraTokens: readonly string[]): ReportPayload {
  const cwdByKey = new Map<string, string>();
  for (const card of payload.sessions) cwdByKey.set(payloadKey(card), card.cwd);

  const receipts: Record<string, Receipt> = {};
  for (const [key, receipt] of Object.entries(payload.receipts)) {
    cwdByKey.set(key, receipt.cwd);
    const hashed = hashStrings(receipt, salt, receipt.cwd, extraTokens);
    hashed.hashPaths = true;
    receipts[key] = hashed;
  }

  const timelines: ReportPayload['timelines'] = {};
  for (const [key, timeline] of Object.entries(payload.timelines)) {
    timelines[key] = hashStrings(timeline, salt, cwdByKey.get(key) ?? '', extraTokens);
  }

  return {
    meta: { ...payload.meta, hashPaths: true },
    rows: hashStrings(payload.rows, salt, '', extraTokens),
    sessions: payload.sessions.map((card) => hashStrings(card, salt, card.cwd, extraTokens)),
    receipts,
    timelines,
  };
}

/** Assembles the data block object for the requested `--hash-paths` mode. */
function buildData(payload: ReportPayload, opts: RenderHtmlOptions): ReportData {
  const mode = opts.hashPaths ?? 'off';
  if (mode === 'off') return { mode: 'clear', payload };
  const salt = opts.salt !== undefined && opts.salt !== '' ? opts.salt : randomBytes(16).toString('hex');
  const hashed = hashedCopy(payload, salt, opts.extraTokens ?? []);
  if (mode === 'on') return { mode: 'hashed', payload: hashed };
  return { mode: 'both', payload, hashed };
}

/**
 * Renders the complete report document (§11.1). Deterministic for one
 * payload/options pair (given an explicit `salt`); `meta.generatedAt` was
 * stamped from `--now` by `buildReportPayload`.
 */
export function renderHtml(payload: ReportPayload, opts: RenderHtmlOptions = {}): string {
  const css = buildCss();
  const app = reportJs();
  const json = embedJson(stableStringify(buildData(payload, opts)));
  const title = escapeText(opts.title ?? 'showreceipts report');
  const csp = [
    "default-src 'none'",
    `script-src ${cspHash(THEME_BOOTSTRAP)} ${cspHash(app)}`,
    `style-src ${cspHash(css)}`,
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<title>${title}</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<script>${THEME_BOOTSTRAP}</script>
<style>${css}</style>
</head>
<body>
<noscript><p>This report needs JavaScript. Everything renders locally — nothing ever leaves this file.</p></noscript>
<div id="app"></div>
<script id="data" type="application/json">${json}</script>
<script>${app}</script>
</body>
</html>
`;
}

/** A `<script>` open tag, matched leniently so a count mismatch is reported, not hidden. */
const SCRIPT_RE = /<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g;

/**
 * `--self-check` (§11.1): proves an emitted document's CSP hashes match its
 * exact inline bytes, that exactly three script blocks exist, that no
 * `'unsafe-inline'` crept in, and that the data block is valid JSON with
 * every dangerous character escaped.
 */
export function selfCheck(html: string): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  const scripts = [...html.matchAll(SCRIPT_RE)].map((m) => m[1] as string);
  if (scripts.length !== 3) problems.push(`expected exactly 3 script blocks, found ${scripts.length}`);
  const style = /<style>([\s\S]*?)<\/style>/.exec(html);
  if (style === null) problems.push('missing inline <style> block');
  const csp = /<meta http-equiv="Content-Security-Policy" content="([^"]*)">/.exec(html);
  if (csp === null) problems.push('missing Content-Security-Policy meta');
  if (!/<head>\n<meta charset="utf-8">\n<meta http-equiv="Content-Security-Policy"/.test(html)) {
    problems.push('CSP meta is not the immediate sibling of <meta charset>');
  }
  if (csp !== null && style !== null && scripts.length === 3) {
    const content = csp[1] as string;
    if (content.includes('unsafe-inline')) problems.push("CSP contains 'unsafe-inline'");
    if (!content.includes(cspHash(scripts[0] as string))) problems.push('theme bootstrap bytes do not match the CSP hash');
    if (!content.includes(cspHash(scripts[2] as string))) problems.push('app script bytes do not match the CSP hash');
    if (!content.includes(cspHash(style[1] as string))) problems.push('stylesheet bytes do not match the CSP hash');
    const data = scripts[1] as string;
    if (/[<>&\u2028\u2029]/.test(data)) problems.push('data block contains an unescaped <, >, & or line separator');
    try {
      JSON.parse(data);
    } catch {
      problems.push('data block is not valid JSON');
    }
  }
  return { ok: problems.length === 0, problems };
}
