/**
 * Network facts (§4.6.7): package-manager registries (`inferred:true`),
 * `gh` → api.github.com, git remotes (URL argument, `To`/`From` output
 * lines, else `origin (host unknown)`), curl/wget URLs, and tool-input URLs
 * (WebFetch, browser navigate/batch). Loopback/link-local/RFC1918/`*.local`
 * hosts are dropped; hosts are lower-cased with no paths; `npx`, `uv run`,
 * `npm run` and `npm test` never count.
 */
import type { CommandFact, NetworkFact, ShellSegment, ToolCall } from '../model/types.js';
import type { LedgerContext } from './commands.js';
import { hostFromOutput, hostOfToken } from './git.js';
import { gitSubcommand } from './shell/index.js';

const URL_RE = /^https?:\/\//i;
const GIT_NET_SUBCOMMANDS = new Set(['push', 'fetch', 'pull', 'clone', 'ls-remote']);
const NPM_NET = new Set(['install', 'ci', 'i', 'add', 'publish', 'view', 'info', 'search']);
const NODE_ALT_NET = new Set(['add', 'install', 'dlx', 'x']);
const BROWSERISH_RE = /browser|chrome|navigate|tab/i;

/** The lower-cased host of an `http(s)` URL (no userinfo, port or path), else `null`. */
function hostOfUrl(url: string): string | null {
  const m = /^https?:\/\/(?:[^@/\s]+@)?([^/:?#\s]+)/i.exec(url);
  return m === null ? null : (m[1] as string).toLowerCase();
}

/** Loopback, link-local, RFC1918, `*.local`, `*.localhost` (§4.6.7 drop list). */
function isDroppedHost(host: string): boolean {
  if (host === 'localhost' || host === '0.0.0.0' || host === '::1' || host === '[::1]') return true;
  if (host.endsWith('.local') || host.endsWith('.localhost')) return true;
  if (/^127\./.test(host) || /^169\.254\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host)) return true;
  const m = /^172\.(\d+)\./.exec(host);
  if (m !== null) {
    const octet = Number(m[1]);
    if (octet >= 16 && octet <= 31) return true;
  }
  return false;
}

/** The default registry host a package-manager segment implies, else `null`. */
function registryOf(seg: ShellSegment): string | null {
  const p = seg.program;
  const a0 = seg.argv[0] ?? '';
  const a1 = seg.argv[1] ?? '';
  if (seg.wrapper === 'pnpm dlx' || seg.wrapper === 'yarn dlx' || seg.wrapper === 'bunx') return 'registry.npmjs.org';
  if (p === 'npm' && NPM_NET.has(a0)) return 'registry.npmjs.org';
  if ((p === 'pnpm' || p === 'yarn' || p === 'bun') && NODE_ALT_NET.has(a0)) return 'registry.npmjs.org';
  if ((p === 'pip' || p === 'pip3') && (a0 === 'install' || a0 === 'download')) return 'pypi.org';
  if (p === 'uv' && (['sync', 'add', 'lock'].includes(a0) || (a0 === 'pip' && a1 === 'install') || (a0 === 'tool' && a1 === 'install'))) return 'pypi.org';
  if (p === 'cargo' && ['add', 'install', 'publish'].includes(a0)) return 'crates.io';
  if (p === 'go' && (a0 === 'get' || a0 === 'install' || (a0 === 'mod' && a1 === 'download'))) return 'proxy.golang.org';
  if (p === 'brew' && ['install', 'upgrade', 'update', 'fetch', 'tap'].includes(a0)) return 'formulae.brew.sh';
  if (p === 'apt-get' && ['install', 'update', 'upgrade', 'dist-upgrade'].includes(a0)) return 'archive.ubuntu.com';
  if (p === 'docker' && ['pull', 'push', 'build', 'run'].includes(a0)) return 'registry-1.docker.io';
  return null;
}

interface FactStatus {
  status: NetworkFact['status'];
  exit?: number | null;
  note?: string;
}

/** `contacted` on exit 0 or unknown-with-output; else `attempted` with the exit kept. */
function statusOf(seg: ShellSegment, call: ToolCall, sandboxOff: boolean): FactStatus {
  if (sandboxOff) return { status: 'attempted', exit: seg.exitCode, note: 'sandbox: network off' };
  if (seg.exitCode === 0) return { status: 'contacted' };
  if (seg.exitCode === null) return call.resultText.length > 0 ? { status: 'contacted' } : { status: 'attempted', exit: null };
  return { status: 'attempted', exit: seg.exitCode };
}

/** `url`, `urls[]` and `actions[].input.url` strings on a fetch/browser tool input. */
function inputUrls(call: ToolCall): string[] {
  if (call.kind !== 'fetch' && call.kind !== 'mcp' && !BROWSERISH_RE.test(call.tool) && !/fetch/i.test(call.tool)) return [];
  const out: string[] = [];
  const addIf = (v: unknown): void => {
    if (typeof v === 'string' && URL_RE.test(v)) out.push(v);
  };
  addIf(call.input['url']);
  const urls = call.input['urls'];
  if (Array.isArray(urls)) for (const u of urls) addIf(u);
  const actions = call.input['actions'];
  if (Array.isArray(actions)) {
    for (const a of actions) {
      if (typeof a !== 'object' || a === null) continue;
      const input = (a as Record<string, unknown>)['input'];
      if (typeof input === 'object' && input !== null) addIf((input as Record<string, unknown>)['url']);
    }
  }
  return out;
}

/**
 * Extracts the session's `NetworkFact`s (§4.6.7). One fact per distinct
 * `(host, via)` per call; a Codex session with `networkAccess:false` reports
 * every command-derived contact as `attempted` with the note
 * "sandbox: network off".
 */
export function extractNetwork(calls: readonly ToolCall[], ctx: LedgerContext, commands: readonly CommandFact[]): NetworkFact[] {
  const byId = new Map(commands.map((f) => [f.toolCallId, f]));
  const facts: NetworkFact[] = [];
  const sandboxOff = ctx.harness === 'codex' && ctx.sandbox !== undefined && ctx.sandbox.networkAccess === false;

  for (const call of calls) {
    const seen = new Set<string>();
    const push = (host: string, via: NetworkFact['via'], inferred: boolean, st: FactStatus): void => {
      if (host === '' || isDroppedHost(host)) return;
      const key = `${host}|${via}`;
      if (seen.has(key)) return;
      seen.add(key);
      const f: NetworkFact = { seq: call.seq, host, via, inferred, status: st.status };
      if (st.exit !== undefined) f.exit = st.exit;
      if (st.note !== undefined) f.note = st.note;
      facts.push(f);
    };

    for (const url of inputUrls(call)) {
      const host = hostOfUrl(url);
      if (host === null) continue;
      const via: NetworkFact['via'] = BROWSERISH_RE.test(call.tool) ? 'browser' : 'fetch';
      const st: FactStatus = call.isError ? { status: 'attempted', exit: call.exitCode } : { status: 'contacted' };
      push(host, via, false, st);
    }

    if (call.denied !== undefined || call.interrupted) continue;
    const fact = byId.get(call.id);
    if (fact === undefined) continue;
    for (const seg of fact.segments) {
      if (seg.ran === false || seg.ran === 'short-circuited') continue;
      const st = statusOf(seg, call, sandboxOff);
      const registry = registryOf(seg);
      if (registry !== null) push(registry, 'package-manager', true, st);
      if (seg.program === 'gh' || seg.program === 'hub') push('api.github.com', 'git', true, st);
      if (seg.program === 'glab') push('gitlab.com', 'git', true, st);
      if (seg.program === 'git') {
        const sub = gitSubcommand(seg.argv);
        if (sub !== null && GIT_NET_SUBCOMMANDS.has(sub)) {
          const urlTok = seg.argv.find((a) => hostOfToken(a) !== null);
          const host = (urlTok !== undefined ? hostOfToken(urlTok) : null) ?? hostFromOutput(call.resultText);
          push(host ?? 'origin (host unknown)', 'git', host === null, st);
        }
      }
      if (seg.program === 'curl' || seg.program === 'wget' || seg.program === 'http') {
        for (const a of seg.argv) {
          if (!URL_RE.test(a)) continue;
          const host = hostOfUrl(a);
          if (host !== null) push(host, 'shell', false, st);
        }
      }
    }
  }
  return facts;
}
