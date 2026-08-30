// Path maps for fixture redaction (PLAN S03, instruction 5).
//
//   (a) home:      /Users/<name>, /home/<name>            → /home/u
//                  /private/tmp/claude-<n>/<dash>/<uuid>/… → /tmp/claude/<dash'>/<uuid'>/…
//   (b) dash dirs: -Users-<name>-Desktop-Wattage           → -home-u-proj
//                  -Users-<name>                           → -home-u
//                  other dash dirs                         → -home-u-projN (first seen)
//   (c) projects:  <home>/Desktop/Wattage                  → /home/u/proj
//                  other working directories seen as cwd   → /home/u/projN (first seen)
//                  repo-relative paths are left alone
//   (d) tmpdir:    /var/folders/…/T/                       → /tmp/t/
//   (e) other paths under the home directory keep their structural segments
//       (dot-directories, `projects`, `subagents`, mapped ids, …) and hash
//       every other segment, so a file name outside the project never leaks.
//   (f) `~/…` is the home directory: it goes through (b)–(e) and keeps its
//       tilde form (`~/Desktop/<hash>/<hash>`, `~/.claude/projects/-home-u/…`).
//
// Everything is plain string replacement applied to every string of a
// fixture after id mapping, longest prefix first, so the same real path
// always renders the same way (including inside commands and kept lines).

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Encodes an absolute path the way Claude Code names project directories. */
export function dashEncode(p) {
  return p.replace(/[/.]/g, '-');
}

const BOUNDARY = '(?![A-Za-z0-9._-])';

/** Segments under the home directory kept verbatim by rule (e). */
const STRUCTURAL_SEGMENTS = new Set(['.claude', '.codex', '.showreceipts', '.cursor', '.gemini', '.copilot', '.hermes', '.config', '.cache', '.local', '.npm', 'projects', 'plans', 'settings.json', 'settings.local.json', 'subagents', 'workflows', 'scripts', 'tool-results', 'tasks', 'memory', 'sessions', 'archived_sessions', 'session_index.jsonl', 'models_cache.json', 'config.toml', 'hooks.json', 'skills', 'plugins', 'worktrees', 'remote-agents', 'Desktop', 'Documents', 'Downloads', 'tmp', 'ledger', 'cache', 'state', 'last', 'backups', 'publish', 'bin', 'src', 'node_modules', 'journal.jsonl', 'sessions-index.json', 'CLAUDE.md', 'AGENTS.md']);

/** Segments that are already mapped ids or mapped roots. */
const MAPPED_SEGMENT_RE = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|agent-[0-9a-f]{15,}(?:\.[a-z.]+)?|[0-9a-f]{15,}|wf_[0-9a-f]{8}-[0-9a-f]{3}|[a-z0-9]{9}(?:\.[a-z]+)?|-home-u(?:-proj\d*)?|proj\d*|\d{4}|\d{2})$/;

/**
 * @param {{ user: string, home: string, primaryProject: string, hashSegment: (seg: string) => string }} opts
 *   `home` is the author's home directory, `primaryProject` the directory
 *   that maps to `/home/u/proj`, `hashSegment` a deterministic hash for
 *   non-structural path segments outside the projects.
 */
export function createPathMap({ user, home, primaryProject, hashSegment }) {
  const homeClean = home.replace(/\/+$/, '');
  const primary = primaryProject.replace(/\/+$/, '');
  /** real root → mapped root, insertion order = first seen */
  const projects = new Map();
  let nextN = 1;

  /**
   * Registers a working directory as a project root (`/home/u/projN`) unless
   * it is the home directory, inside the primary project, inside an already
   * registered root, or a dot-directory.
   */
  function registerCwd(p) {
    if (typeof p !== 'string' || p === '') return;
    const clean = p.replace(/\/+$/, '');
    if (clean === homeClean || clean === primary || clean.startsWith(primary + '/')) return;
    if (!clean.startsWith(homeClean + '/')) return;
    const rest = clean.slice(homeClean.length + 1);
    if (rest === '' || rest.startsWith('.')) return;
    for (const root of projects.keys()) if (clean === root || clean.startsWith(root + '/')) return;
    projects.set(clean, `/home/u/proj${nextN++}`);
  }

  function projectRules() {
    const rules = [[primary, '/home/u/proj']];
    for (const [root, mapped] of projects) rules.push([root, mapped]);
    rules.sort((a, b) => b[0].length - a[0].length);
    return rules;
  }

  function maskSegment(seg) {
    if (seg === '' || seg === '.' || seg === '..' || STRUCTURAL_SEGMENTS.has(seg) || MAPPED_SEGMENT_RE.test(seg)) return seg;
    const ext = /\.[A-Za-z0-9]{1,8}$/.exec(seg)?.[0] ?? '';
    const base = seg.slice(0, seg.length - ext.length);
    return (base === '' ? '' : hashSegment(base).slice(0, 8)) + ext;
  }

  function maskRest(rest) {
    if (/^proj\d*(?:\/|$)/.test(rest)) return '/home/u/' + rest;
    return '/home/u/' + rest.split('/').map(maskSegment).join('/');
  }

  /** Rule (e): hashes non-structural segments of a mapped home path outside the projects. */
  function maskHomePaths(s, wholePath) {
    if (wholePath) return s.replace(/^\/home\/u\/(.+)$/s, (_m, rest) => maskRest(rest));
    return s.replace(/\/home\/u\/([^\s"'`<>|:;)\]}]+)/g, (_m, rest) => maskRest(rest));
  }

  /** Unknown dash-encoded project directories → `-home-u-projN` in first-seen order. */
  const dashProjects = new Map();
  function mapDashRest(m) {
    let mapped = dashProjects.get(m);
    if (mapped === undefined) {
      mapped = `-home-u-proj${nextN++}`;
      dashProjects.set(m, mapped);
    }
    return mapped;
  }

  /**
   * Rewrites every path form inside a string. With `wholePath` the string is
   * one path (a `filePath`-style value) and rule (e) masks it to its end even
   * when segments contain spaces.
   */
  function rewrite(s, wholePath = false) {
    if (typeof s !== 'string' || s === '') return s;
    let out = s;
    out = out.replace(/(?<![A-Za-z0-9])~\/([^\s"'`<>|:;)\]}]+)/g, (_m, rest) => {
      const abs = rewrite(homeClean + '/' + rest, wholePath);
      return abs.startsWith('/home/u/') ? '~/' + abs.slice('/home/u/'.length) : abs;
    });
    out = out.replace(/(?:\/private)?\/tmp\/claude-\d+\//g, '/tmp/claude/');
    out = out.replace(/(?:\/private)?\/var\/folders\/[^/\s"'\\]+\/[^/\s"'\\]+\/T\//g, '/tmp/t/');
    const rules = projectRules();
    for (const [root, mapped] of rules) {
      out = out.replace(new RegExp(escapeRe(root) + BOUNDARY, 'g'), mapped);
      out = out.replace(new RegExp(escapeRe(dashEncode(root)) + BOUNDARY, 'g'), dashEncode(mapped));
    }
    out = out.replace(new RegExp(escapeRe(dashEncode(homeClean)) + BOUNDARY, 'g'), '-home-u');
    out = out.replace(new RegExp(`-Users-${escapeRe(user)}${BOUNDARY}`, 'g'), '-home-u');
    out = out.replace(/-Users-[A-Za-z0-9_]+(?![A-Za-z0-9_])/g, '-home-u');
    out = out.replace(/-home-u-(?!proj\d*(?![A-Za-z0-9._-]))[A-Za-z0-9._-]+/g, (m) => mapDashRest(m));
    out = out.replace(new RegExp(escapeRe(homeClean) + BOUNDARY, 'g'), '/home/u');
    out = out.replace(/\/Users\/[^/\s"'\\:]+/g, '/home/u');
    out = out.replace(/\/home\/(?!u(?![A-Za-z0-9._-]))[^/\s"'\\:]+/g, '/home/u');
    out = maskHomePaths(out, wholePath);
    return out;
  }

  return {
    registerCwd,
    rewrite,
    /** `{ realRoot: mappedRoot }` (real roots never leave the author's machine). */
    projectMap: () => Object.fromEntries([...projects, ...dashProjects]),
  };
}
