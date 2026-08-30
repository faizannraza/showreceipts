// Deterministic id rewriting for fixture redaction (PLAN S03, instruction 4).
//
// Every replacement derives from sha256(seed + ':' + kind + ':' + original),
// so one original id maps to one output everywhere: record fields, path
// segments, tag bodies, file names. Shapes are preserved so readers keep
// working on the fixtures: UUIDs keep their version and variant nibbles (v7
// additionally keeps the 48-bit timestamp prefix, so ordering and the
// last-8-hex shortId rule stay meaningful), prefixed tokens keep their prefix
// and length, agent ids stay 17 hex, workflow ids stay `wf_xxxxxxxx-xxx`, task
// ids stay nine `[a-z0-9]`.
import { createHash } from 'node:crypto';

/** Fixed replacement for `bridge-session.ownerAccountUuid`. */
export const FIXED_OWNER_ACCOUNT = '00000000-0000-4000-8000-000000000001';
/** Fixed replacement for `bridge-session.ownerOrganizationUuid`. */
export const FIXED_OWNER_ORG = '00000000-0000-4000-8000-000000000002';

const UUID_RE = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/;
const PREFIXED_RE = /\b(?:msg|req|srvtoolu|mcptoolu|toolu|cse|call|fc|rs)_[A-Za-z0-9]+/;
const AGENT_RE = /\bagent-[0-9a-f]{15,}\b/;
const WF_RE = /\bwf_[0-9a-f]{8}-[0-9a-f]{3}\b/;
const PATH_TASK_RE = /\b(?:tool-results|tasks)\/[a-z0-9]{9}(?=[./"'\s]|$)/;

const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const LOWER36 = 'abcdefghijklmnopqrstuvwxyz0123456789';
const HEX = '0123456789abcdef';

/** Token shapes accepted by `register()`; each has its own hash namespace. */
export const ID_KINDS = ['agent', 'task', 'bridge', 'chunk', 'token'];

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Creates the id map for one seed. All methods are pure functions of
 * (seed, kind, original); the internal caches only avoid re-hashing.
 * @param {string} seed
 */
export function createIdMap(seed) {
  const cache = new Map();
  /** exact token → kind, for ids that are only recognisable by the key they sit under */
  const registered = new Map();
  let registeredRe = null;

  function hashBytes(kind, original, n) {
    const out = [];
    for (let i = 0; out.length < n; i++) {
      const h = createHash('sha256')
        .update(`${seed}:${kind}:${original}${i === 0 ? '' : ':' + i}`)
        .digest();
      for (const b of h) {
        out.push(b);
        if (out.length === n) break;
      }
    }
    return out;
  }

  function fromAlphabet(kind, original, n, alphabet) {
    return hashBytes(kind, original, n)
      .map((b) => alphabet[b % alphabet.length])
      .join('');
  }

  function cached(key, make) {
    let v = cache.get(key);
    if (v === undefined) {
      v = make();
      cache.set(key, v);
    }
    return v;
  }

  /** Maps a UUID keeping version + variant nibbles (v7: also the 12-hex timestamp prefix). */
  function mapUuid(u) {
    const lower = u.toLowerCase();
    return cached('uuid:' + lower, () => {
      const raw = lower.replace(/-/g, '');
      const version = raw[12];
      const variant = raw[16];
      const h = fromAlphabet('uuid', lower, 32, HEX);
      const head = version === '7' ? raw.slice(0, 12) : h.slice(0, 12);
      const body = head + version + h.slice(13, 16) + variant + h.slice(17, 32);
      return `${body.slice(0, 8)}-${body.slice(8, 12)}-${body.slice(12, 16)}-${body.slice(16, 20)}-${body.slice(20)}`;
    });
  }

  /** Maps `msg_…`, `req_…`, `toolu_…`, `cse_…`, `call_…`, `fc_…`, `rs_…` keeping prefix and length. */
  function mapPrefixed(prefix, body) {
    return cached(`${prefix}:${body}`, () => `${prefix}_${fromAlphabet(prefix, body, body.length, ALNUM)}`);
  }

  /** Maps a 17-hex agent id (`a…`) to another 17-hex id keeping the leading `a`. */
  function mapAgent(id) {
    const lower = id.toLowerCase();
    return cached('agent:' + lower, () => {
      if (lower.startsWith('a')) return 'a' + fromAlphabet('agent', lower, lower.length - 1, HEX);
      return fromAlphabet('agent', lower, lower.length, HEX);
    });
  }

  /** Maps a nine-character task id. */
  function mapTask(id) {
    return cached('task:' + id, () => fromAlphabet('task', id, id.length, LOWER36));
  }

  /** Maps `wf_xxxxxxxx-xxx`. */
  function mapWf(a, b) {
    return cached(`wf:${a}-${b}`, () => `wf_${fromAlphabet('wf', `${a}-${b}`, 8, HEX)}-${fromAlphabet('wf-suffix', `${a}-${b}`, 3, HEX)}`);
  }

  /** Maps a hex chunk id keeping its length. */
  function mapChunk(hex) {
    return cached('chunk:' + hex, () => fromAlphabet('chunk', hex.toLowerCase(), hex.length, HEX));
  }

  /** Maps any other opaque token to a same-length `[A-Za-z0-9]` token. */
  function mapToken(kind, token) {
    return cached(`${kind}:${token}`, () => fromAlphabet(kind, token, token.length, ALNUM));
  }

  /**
   * Registers a token that is only recognisable by its key (task ids, bare
   * agent ids, bridge ids) so `rewrite()` replaces every later occurrence.
   */
  function register(token, kind) {
    if (typeof token !== 'string' || token === '' || !ID_KINDS.includes(kind)) return;
    if (registered.get(token) === kind) return;
    registered.set(token, kind);
    registeredRe = null;
  }

  function mapRegistered(token) {
    const kind = registered.get(token);
    if (kind === 'agent') return mapAgent(token);
    if (kind === 'task') return mapTask(token);
    if (kind === 'chunk') return mapChunk(token);
    return mapToken(kind, token);
  }

  /**
   * One combined regex: every token is matched and replaced exactly once, so
   * a replacement can never be re-mapped by a later rule (registered tokens
   * take precedence, then UUIDs, prefixed ids, `agent-…`, `wf_…`, and task ids
   * in `tool-results/` / `tasks/` path segments).
   */
  function combinedRegex() {
    if (registeredRe === null) {
      const tokens = [...registered.keys()].sort((a, b) => b.length - a.length || (a < b ? -1 : 1));
      const parts = [];
      if (tokens.length > 0) parts.push(`(?<![A-Za-z0-9])(?:${tokens.map(escapeRe).join('|')})(?![A-Za-z0-9])`);
      parts.push(UUID_RE.source, PREFIXED_RE.source, AGENT_RE.source, WF_RE.source, PATH_TASK_RE.source);
      registeredRe = new RegExp(parts.join('|'), 'g');
    }
    return registeredRe;
  }

  function mapMatch(m) {
    if (registered.has(m)) return mapRegistered(m);
    if (/^[0-9a-f]{8}-/i.test(m) && m.length === 36) return mapUuid(m);
    if (m.startsWith('agent-')) return 'agent-' + mapAgent(m.slice(6));
    if (m.startsWith('wf_')) return mapWf(m.slice(3, 11), m.slice(12));
    const path = /^(tool-results|tasks)\/([a-z0-9]{9})$/.exec(m);
    if (path) return `${path[1]}/${mapTask(path[2])}`;
    const prefixed = /^([a-z]+)_([A-Za-z0-9]+)$/.exec(m);
    if (prefixed) return mapPrefixed(prefixed[1], prefixed[2]);
    return m;
  }

  /** Rewrites every id-shaped token and every registered token inside a string (single pass). */
  function rewrite(s) {
    if (typeof s !== 'string' || s === '') return s;
    return s.replace(combinedRegex(), (m) => mapMatch(m));
  }

  /** Maps a bare token by shape (used for tag bodies such as `<task-id>`). */
  function mapByShape(token) {
    if (/^[a-z0-9]{9}$/.test(token)) {
      register(token, 'task');
      return mapTask(token);
    }
    if (/^a[0-9a-f]{16}$/.test(token)) {
      register(token, 'agent');
      return mapAgent(token);
    }
    return rewrite(token);
  }

  return {
    seed,
    mapUuid,
    mapPrefixed,
    mapAgent,
    mapTask,
    mapWf,
    mapChunk,
    mapToken,
    mapByShape,
    register,
    rewrite,
    /** Registered tokens (for the forbidden list). */
    registeredTokens: () => [...registered.keys()],
  };
}

/** UUID version nibble (`'4'`, `'7'`, …) or `null` when the string is not a UUID. */
export function uuidVersion(u) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(u) ? u[14] : null;
}
