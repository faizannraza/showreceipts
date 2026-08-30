// Key-based content policy for fixture redaction (PLAN S03, instruction 6).
//
// Every decision is made by key path and record role, never by sniffing a
// value alone. Unknown strings under any parent are stubbed (`<s:Nb>`), never
// copied. Stubs carry the UTF-8 byte length of what they replaced and, when
// the original contained U+2028, U+2029, `\r`, `\t` or NUL, those characters
// appended once each in original order so hazard bytes survive.
//
// Policy summary (see the step file for the full table):
//   final assistant text  → sentence-level keep (KEEP_SENTENCE_RE, never SECRET_SHAPE_RE) / <text:Nb>
//   non-final text        → <text:Nb>; thinking → <think:Nb>; signature → <sig>
//   human prompts         → <prompt:Nb> keeping the tag skeletons readers parse
//   code-bearing keys     → per line: prefix + <line:Nb> + integrity tokens
//   commands              → tokenizer skeleton; long literals → <str:Nb>
//   tool outputs          → per line: keep-list lines verbatim, else <out:Nb>
//   count-only records    → type skeleton, values stubbed by kind
//   ids / paths / hosts   → id map, path map, host allow-list, e-mail mask
import { FIXED_OWNER_ACCOUNT, FIXED_OWNER_ORG } from './idmap.mjs';
import { HOST_ALLOWLIST, INTEGRITY_TOKENS, KEEP_LINE_RULES, KEEP_SENTENCE_RE, MAX_COMMAND_BYTES, MAX_COMMAND_LITERAL_CHARS, MAX_KEPT_SENTENCE_CHARS, SECRET_SHAPE_RE } from './keep-lists.mjs';
import { segmentLine } from './sentences.mjs';

/** Bumped whenever the policy changes what a fixture contains. */
export const POLICY_VERSION = 1;

const HAZARD_RE = /[\u2028\u2029\r\t\0]/;
const HAZARDS = ['\u2028', '\u2029', '\r', '\t', '\0'];

const PATH_KEYS = new Set(['cwd', 'filePath', 'file_path', 'path', 'notebook_path', 'filename', 'scriptPath', 'transcriptDir', 'outputFile', 'persistedOutputPath', 'outputFilePath', 'planFilePath', 'trackingPath', 'displayPath', 'workdir', 'backupFileName', 'transcript_path', 'worktreePath', 'outputDir']);

/** Bare command words that look like credentials are stubbed whatever their length. */
const SECRET_WORD_RE = /^(?:ghp_|gho_|ghs_|ghu_|github_pat_|sk-|sk_live_|sk_test_|xox[bapr]-|AKIA|ASIA|AIza|ya29\.|eyJ[A-Za-z0-9_-]{8,}|glpat-|npm_)/;
/** A flag whose following word is a credential value. */
const SECRET_FLAG_RE = /^--?(?:token|secret|key|password|passwd|pass|api-?key|auth|authorization|credentials?|cookie|bearer)(?:=|$)/i;

/** Keys whose string values are ids that are only recognisable by key. */
const ID_KEY_KINDS = { taskId: 'task', backgroundTaskId: 'task', task_id: 'task', agentId: 'agent', parentAgentId: 'agent', bridgeSessionId: 'bridge' };

/** Top-level record keys copied verbatim (strings still go through the scrubber). */
const TOP_KEEP = new Set(['type', 'subtype', 'timestamp', 'version', 'userType', 'entrypoint', 'effort', 'permissionMode', 'isMeta', 'isCompactSummary', 'isVisibleInTranscriptOnly', 'isSidechain', 'promptId', 'uuid', 'parentUuid', 'logicalParentUuid', 'sessionId', 'session_id', 'requestId', 'sourceToolUseID', 'sourceToolAssistantUUID', 'interruptedMessageId', 'toolDenialKind', 'error', 'apiErrorStatus', 'isApiErrorMessage', 'durationMs', 'messageCount', 'pendingBackgroundAgentCount', 'pendingWorkflowCount', 'level', 'trigger', 'direction', 'scope', 'originalModel', 'fallbackModel', 'apiRefusalCategory', 'retractedMessageUuids', 'refusedUserMessageUuid', 'promptSource', 'turnCompanion', 'queuePriority', 'queueSkipAttachments', 'toolEndsTurn', 'isSnapshotUpdate', 'messageId', 'snapshotMessageId', 'leafUuid', 'prNumber', 'lastSequenceNum', 'operation', 'contextLength', 'parentSessionId', 'parentLastUuid', 'attributionAgent', 'compactMetadata', 'quotaLimits']);

/** Keys inside tool inputs / results / attachments whose values are structural and kept. */
const FIELD_KEEP = new Set(['type', 'interrupted', 'isImage', 'noOutputExpected', 'returnCodeInterpretation', 'persistedOutputSize', 'timedOutAfterMs', 'dangerouslyDisableSandbox', 'userModified', 'replaceAll', 'replace_all', 'staleRecovered', 'memdirStamped', 'status', 'isAsync', 'resolvedModel', 'canReadOutputFile', 'taskType', 'task_type', 'bytes', 'code', 'codeText', 'durationMs', 'durationSeconds', 'searchCount', 'total_deferred_tools', 'success', 'isAgent', 'persistent', 'timeoutMs', 'timeout', 'timeout_ms', 'run_in_background', 'pattern', 'glob', 'output_mode', 'head_limit', 'offset', 'limit', 'pages', 'multiline', '-i', '-n', '-A', '-B', '-C', 'context', 'case_insensitive', 'subagent_type', 'model', 'isolation', 'edit_mode', 'cell_type', 'max_results', 'skill', 'numLines', 'startLine', 'totalLines', 'truncatedByTokenCap', 'dimensions', 'originalSize', 'count', 'oldStart', 'oldLines', 'newStart', 'newLines', 'hookName', 'hookEvent', 'commandMode', 'reminderType', 'newDate', 'isSubAgent', 'planExists', 'isInitial', 'skillCount', 'itemCount', 'showConcurrencyNote', 'autoModeConsentFlow', 'commandName', 'allowedTools', 'multiSelect', 'gitOperation', 'media_type', 'mode', 'agentType', 'spawnDepth', 'isFork', 'worktreeCleanlyRemoved', 'kind', 'statusChange', 'yield_time_ms', 'max_output_tokens', 'session_id', 'exit_code', 'duration_seconds', 'stop_reason', 'is_error']);

/** Words allowed verbatim inside `<task-notification><summary>` bodies. */
const SUMMARY_WORDS = new Set(['agent', 'background', 'command', 'local', 'workflow', 'task', 'monitor', 'completed', 'finished', 'failed', 'killed', 'stopped', 'exit', 'code', 'with', 'has', 'the', 'timed', 'out', 'error', 'succeeded', 'running', 'cancelled', 'aborted', 'interrupted', 'output', 'file', 'status', 'done', 'ended', 'process', 'session', 'a', 'an', 'in', 'of', 'to', 'for', 'and', 'was', 'is', 'shell', 'still', 'after', 'ms', 's', 'seconds', 'minutes', 'stdout', 'stderr', 'bash']);

const SECRET_KEY_RE = /(?:token|secret|key|password|passwd|pass|auth|credential|cookie|session)/i;

function blen(s) {
  return Buffer.byteLength(s, 'utf8');
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Canonical form of a forbidden-list entry: lower-case with every
 * non-alphanumeric character removed, so `example-corp`, `example.corp`,
 * `Example Corp` and `examplecorp` are one token (never write a real entry
 * into a committed file, comments included). The committed hash list
 * (`fixtures/redaction/forbidden.sha256.json`) stores `sha256(canonicalToken(t))`
 * and the privacy test canonicalises the same way before hashing.
 * @param {string} token
 * @returns {string}
 */
export function canonicalToken(token) {
  return String(token).toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/**
 * Regex masking one forbidden-list entry in every separator spelling: the
 * entry's alphanumeric runs may be joined by nothing or by any single
 * non-alphanumeric character (`example-corp` also matches `example_corp`,
 * `example.corp`, `Example Corp`, `examplecorp`), case-insensitively and only at alphanumeric-run
 * boundaries. Returns null for entries shorter than three alphanumerics.
 * @param {string} token
 * @returns {RegExp | null}
 */
export function forbiddenRegExp(token) {
  if (typeof token !== 'string') return null;
  const runs = token.toLowerCase().split(/[^a-z0-9]+/).filter((r) => r !== '');
  if (runs.join('').length < 3) return null;
  return new RegExp(`(?<![A-Za-z0-9])${runs.map(escapeRe).join('[^A-Za-z0-9]?')}(?![A-Za-z0-9])`, 'gi');
}

/**
 * Creates a redactor bound to one fixture's id map, path map and forbidden
 * token list. `review.add(category, text)` receives every verbatim-kept string.
 * @param {{ ids: object, paths: object, forbidden: string[], review: { add: (category: string, text: string) => void } }} deps
 */
export function createRedactor({ ids, paths, forbidden, review }) {
  const hosts = new Map();
  const branches = new Map();
  let threadN = 0;
  const forbiddenRes = [...new Map([...forbidden].map((t) => [canonicalToken(t), t])).values()]
    .sort((a, b) => canonicalToken(b).length - canonicalToken(a).length || (a < b ? -1 : a > b ? 1 : 0))
    .map(forbiddenRegExp)
    .filter((re) => re !== null);
  const stats = { stubs: 0, keptSentences: 0, keptLines: 0, commands: 0, forbiddenHits: 0 };

  // ---------------------------------------------------------------- helpers
  function hz(s) {
    if (!HAZARD_RE.test(s)) return '';
    let out = '';
    const seen = new Set();
    for (const ch of s) {
      if (HAZARDS.includes(ch) && !seen.has(ch)) {
        seen.add(ch);
        out += ch;
        if (seen.size === HAZARDS.length) break;
      }
    }
    return out;
  }

  function stub(kind, s) {
    stats.stubs++;
    return `<${kind}:${blen(s)}b>${hz(s)}`;
  }

  function hostN(host) {
    let n = hosts.get(host);
    if (n === undefined) {
      n = hosts.size + 1;
      hosts.set(host, n);
    }
    return `host-${n}.example`;
  }

  function maskGithubPath(path) {
    return path.replace(/^\/([^/\s]+)\/([^/\s]+)/, (m, owner) => (['orgs', 'users', 'settings', 'search', 'marketplace', 'features', 'about', 'login'].includes(owner) ? m : '/u/proj'));
  }

  function maskUrls(s) {
    let out = s.replace(/git@github\.com:[^\s"'/]+\/[^\s"']+/g, 'git@github.com:u/proj.git');
    out = out.replace(/\b(https?:\/\/)([^\s"'<>()\[\]]+)/g, (_m, scheme, rest) => {
      const slash = rest.indexOf('/');
      const hostPort = slash < 0 ? rest : rest.slice(0, slash);
      const path = slash < 0 ? '' : rest.slice(slash);
      const host = hostPort.replace(/:\d+$/, '').toLowerCase();
      if (!HOST_ALLOWLIST.includes(host)) return `${scheme}${hostN(host)}/`;
      if (host === 'github.com') return scheme + hostPort + maskGithubPath(path);
      if (host === 'api.github.com') return scheme + hostPort + path.replace(/^\/repos\/[^/\s]+\/[^/\s]+/, '/repos/u/proj');
      return scheme + hostPort + path;
    });
    out = out.replace(/(?<![\w/.-])github\.com\/([^\s"'/]+)\/([^\s"'/]+)/g, (m, owner) => (owner === 'u' ? m : 'github.com/u/proj'));
    return out;
  }

  /** E-mail-shaped tokens → `u@example.com`; `pkg@1.2.3` version specs (numeric TLD) are not e-mails. */
  function maskEmails(s) {
    return s.replace(/(?<![\w.-])(?!git@)[\w.+-]+@[\w-]+(?:\.[\w-]+)*\.[A-Za-z]{2,}(?![\w-])/g, 'u@example.com');
  }

  function forbiddenPass(s) {
    let out = s;
    for (const re of forbiddenRes) {
      out = out.replace(re, () => {
        stats.forbiddenHits++;
        return 'u';
      });
    }
    return out;
  }

  /** Every verbatim-kept string goes through here: ids → paths → hosts → e-mails → forbidden tokens. */
  function scrub(s) {
    if (typeof s !== 'string' || s === '') return s;
    return forbiddenPass(maskEmails(maskUrls(paths.rewrite(ids.rewrite(s)))));
  }

  /** A value that is one whole path (`filePath`, `cwd`, …): masked to its end even with spaces. */
  function scrubPath(s) {
    if (typeof s !== 'string' || s === '') return s;
    return forbiddenPass(maskEmails(maskUrls(paths.rewrite(ids.rewrite(s), true))));
  }

  function keep(category, s) {
    if (SECRET_SHAPE_RE.test(s)) return stub('s', s);
    const v = scrub(s);
    if (v !== '') review.add(category, v);
    return v;
  }

  /**
   * Object keys: identifier-like keys and paths are kept (scrubbed); any other
   * key is free text (AskUserQuestion answers are keyed by the question) and
   * becomes `<k:Nb>`, made unique inside its object with a `#n` suffix.
   */
  function mapKey(k, out) {
    let mapped = /^[\w.$@:-]{1,64}$/.test(k) || k.includes('/') ? scrub(k) : `<k:${blen(k)}b>${hz(k)}`;
    if (out !== undefined && mapped in out) {
      let n = 2;
      while (`${mapped}#${n}` in out) n++;
      mapped = `${mapped}#${n}`;
    }
    return mapped;
  }

  function idValue(key, v) {
    const kind = ID_KEY_KINDS[key];
    if (kind === 'task' && /^[a-z0-9]{9}$/.test(v)) {
      ids.register(v, 'task');
      return ids.mapTask(v);
    }
    if (kind === 'agent' && /^[a-z0-9]{15,}$/i.test(v)) {
      ids.register(v, 'agent');
      return ids.mapAgent(v);
    }
    if (kind === 'task' && /^[a-z0-9]{15,}$/i.test(v)) {
      ids.register(v, 'agent');
      return ids.mapAgent(v);
    }
    if (kind === 'bridge') {
      ids.register(v, 'bridge');
      return ids.mapToken('bridge', v);
    }
    if (/^\d{1,6}$/.test(v)) return v;
    return scrub(v);
  }

  /** Copies a value keeping numbers/booleans/null and scrubbing every string. */
  function keepDeep(v, key = '') {
    if (typeof v === 'string') return key in ID_KEY_KINDS ? idValue(key, v) : scrub(v);
    if (v === null || typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.map((x) => keepDeep(x, key));
    const out = {};
    for (const [k, x] of Object.entries(v)) out[mapKey(k, out)] = keepDeep(x, k);
    return out;
  }

  /** Copies a value stubbing every string not sitting under a path/id key. */
  function generic(v, key = '') {
    if (typeof v === 'string') {
      if (v === '') return '';
      if (PATH_KEYS.has(key)) return scrubPath(v);
      if (key in ID_KEY_KINDS) return idValue(key, v);
      if (FIELD_KEEP.has(key) && v.length <= 64 && !/\s{2,}/.test(v)) return scrub(v);
      return stub('s', v);
    }
    if (v === null || typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.map((x) => generic(x, key === 'lines' ? 'lines' : key));
    const out = {};
    for (const [k, x] of Object.entries(v)) out[mapKey(k, out)] = generic(x, k);
    return out;
  }

  // ---------------------------------------------------------------- text kinds
  function integrityTokens(line) {
    const found = INTEGRITY_TOKENS.filter((t) => line.includes(t));
    return found.length === 0 ? '' : ' ' + found.join(' ');
  }

  /** Code bodies: one `<line:Nb>` per line plus the integrity tokens the scanner looks for. */
  function redactCode(s) {
    if (s === '') return '';
    return s
      .split('\n')
      .map((line) => (line === '' ? '' : stub('line', line) + integrityTokens(line)))
      .join('\n');
  }

  /** One `structuredPatch[].lines[]` entry: prefix char + `<line:Nb>` + integrity tokens. */
  function redactPatchLine(line) {
    if (line === '') return '';
    const prefix = /^[+\- \\]/.test(line) ? line[0] : '';
    const body = line.slice(prefix.length);
    return prefix + stub('line', body) + integrityTokens(body);
  }

  /** apply_patch bodies: headers kept with mapped paths, `@@` markers kept, hunk lines stubbed. */
  function redactPatch(s) {
    return s
      .split('\n')
      .map((line) => {
        if (/^\*\*\* (?:Begin|End) Patch\s*$/.test(line)) return line;
        const header = /^(\*\*\* (?:Add File|Update File|Delete File|Move to): )(.*)$/.exec(line);
        if (header) return header[1] + keep('patch-header', header[2]);
        if (line.startsWith('@@')) return '@@' + (line.slice(2).trim() === '' ? '' : ' ' + stub('line', line.slice(2).trim()));
        return redactPatchLine(line);
      })
      .join('\n');
  }

  function redactWord(word, prev) {
    const kv = /^(-{0,2}[A-Za-z_][A-Za-z0-9_-]*)=(.*)$/s.exec(word);
    if (kv && (SECRET_KEY_RE.test(kv[1]) || SECRET_WORD_RE.test(kv[2]) || (kv[2].length > MAX_COMMAND_LITERAL_CHARS && !kv[2].includes('/')))) {
      return `${scrub(kv[1])}=${stub('str', kv[2])}`;
    }
    if (SECRET_WORD_RE.test(word) || (prev !== null && SECRET_FLAG_RE.test(prev) && !word.startsWith('-'))) return stub('str', word);
    if (word.length > MAX_COMMAND_LITERAL_CHARS && !word.includes('/')) return stub('str', word);
    return scrub(word);
  }

  function redactQuoted(lit, prev) {
    if (lit.length > MAX_COMMAND_LITERAL_CHARS) return stub('str', lit);
    if (SECRET_WORD_RE.test(lit) || SECRET_KEY_RE.test(lit) || (prev !== null && SECRET_FLAG_RE.test(prev))) return stub('str', lit);
    return scrub(lit);
  }

  /** Commands: tokenizer skeleton (words, flags, pipes, redirections, mapped paths); long literals and heredoc bodies stubbed. */
  function redactCommand(s) {
    if (s === '') return '';
    if (blen(s) > MAX_COMMAND_BYTES) return stub('cmd', s);
    stats.commands++;
    let out = '';
    let i = 0;
    const n = s.length;
    let pending = [];
    let prev = null;
    while (i < n) {
      const c = s[i];
      if (c === '\n') {
        out += '\n';
        i++;
        prev = null;
        if (pending.length > 0) {
          for (const delim of pending) {
            const bodyStart = i;
            let lineStart = i;
            let bodyEnd = -1;
            while (lineStart <= n) {
              let le = s.indexOf('\n', lineStart);
              if (le < 0) le = n;
              if (s.slice(lineStart, le).replace(/^\t+/, '') === delim) {
                bodyEnd = lineStart;
                i = le;
                break;
              }
              if (le >= n) break;
              lineStart = le + 1;
            }
            if (bodyEnd < 0) {
              const body = s.slice(bodyStart);
              out += body.startsWith('*** Begin Patch') ? redactPatch(body) : stub('heredoc', body);
              i = n;
              break;
            }
            const body = s.slice(bodyStart, bodyEnd);
            out += (body.startsWith('*** Begin Patch') ? redactPatch(body.replace(/\n$/, '')) : stub('heredoc', body)) + '\n' + delim;
          }
          pending = [];
        }
        continue;
      }
      if (c === "'" || c === '"') {
        const q = c;
        let j = i + 1;
        let lit = '';
        while (j < n && s[j] !== q) {
          if (q === '"' && s[j] === '\\' && j + 1 < n) {
            lit += s[j] + s[j + 1];
            j += 2;
            continue;
          }
          lit += s[j];
          j++;
        }
        const closed = j < n;
        out += q + redactQuoted(lit, prev) + (closed ? q : '');
        i = closed ? j + 1 : n;
        prev = null;
        continue;
      }
      if (c === '<' && s[i + 1] === '<') {
        const m = /^<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/.exec(s.slice(i, i + 80));
        if (m) {
          pending.push(m[2]);
          out += m[0];
          i += m[0].length;
          continue;
        }
      }
      if (/\s/.test(c)) {
        out += c;
        i++;
        continue;
      }
      let j = i;
      while (j < n && !/[\s'"]/.test(s[j])) j++;
      const word = s.slice(i, j);
      out += redactWord(word, prev);
      prev = word;
      i = j;
    }
    review.add('command', out);
    return out;
  }

  function transformLine(rule, line) {
    if (rule.name === 'pr-url') return scrub(line.replace(/https:\/\/github\.com\/\S+\/pull\/(\d+)\S*/g, 'https://github.com/u/proj/pull/$1'));
    if (rule.name === 'codex-chunk') return line.replace(/^Chunk ID: ([0-9a-f]+)$/, (_m, hex) => `Chunk ID: ${ids.mapChunk(hex)}`);
    if (rule.name === 'codex-denied') {
      const m = /^(.*?Codex\(Sandbox\(Denied.*?exit_code: -?\d+)/.exec(line);
      if (m) return scrub(m[1]) + ', ' + stub('out', line.slice(m[1].length)) + ' }))" }';
      return stub('out', line);
    }
    return stub('out', line);
  }

  function redactOutputLine(line) {
    if (line === '') return '';
    if (SECRET_SHAPE_RE.test(line)) return stub('out', line);
    for (const rule of KEEP_LINE_RULES) {
      const m = rule.re.exec(line);
      if (!m) continue;
      stats.keptLines++;
      if (rule.mode === 'whole') return keep('output-line', line);
      if (rule.mode === 'transform') {
        const v = transformLine(rule, line);
        review.add('output-line', v);
        return v;
      }
      const prefix = line.slice(0, m.index + m[0].length);
      const rest = line.slice(prefix.length);
      review.add('output-line', scrub(prefix));
      return scrub(prefix) + (rest.trim() === '' ? '' : ' ' + stub('out', rest));
    }
    return stub('out', line);
  }

  /** Tool outputs: keep-list lines verbatim (scrubbed), every other line `<out:Nb>`. */
  function redactOutput(s) {
    if (s === '') return '';
    return s.split('\n').map(redactOutputLine).join('\n');
  }

  function sentencePolicy(text) {
    return segmentLine(text)
      .map(({ text: t, sep }) => {
        const lead = /^\s*/.exec(t)[0];
        const core = t.slice(lead.length);
        if (core === '') return t + sep;
        if (KEEP_SENTENCE_RE.test(core) && core.length <= MAX_KEPT_SENTENCE_CHARS && !SECRET_SHAPE_RE.test(core)) {
          stats.keptSentences++;
          return lead + keep('sentence', core) + sep;
        }
        return lead + stub('text', core) + sep;
      })
      .join('');
  }

  /** Final message text: sentence-level keep with list/table/heading/fence skeletons preserved. */
  function redactFinalText(s) {
    if (s === '') return '';
    let fence = false;
    const out = [];
    for (const line of s.split('\n')) {
      const fenceMatch = /^(\s*(?:```|~~~))(.*)$/.exec(line);
      if (fenceMatch) {
        fence = !fence;
        const tag = fenceMatch[2].trim();
        out.push(fenceMatch[1] + (tag === '' ? '' : /^[A-Za-z0-9+#.-]{1,20}$/.test(tag) ? tag : stub('s', tag)));
        continue;
      }
      if (fence) {
        out.push(line.trim() === '' ? line : stub('text', line));
        continue;
      }
      if (line.trim() === '') {
        out.push(line);
        continue;
      }
      if (/^\s*\|/.test(line)) {
        if (/^[\s|:-]+$/.test(line)) {
          out.push(line);
          continue;
        }
        out.push(line.split('|').map((cell) => (cell.trim() === '' ? cell : ' ' + sentencePolicy(cell.trim()) + ' ')).join('|'));
        continue;
      }
      if (/^\s*(?:[-*_]\s*){3,}$/.test(line)) {
        out.push(line);
        continue;
      }
      const m = /^(\s*(?:[-*+•]\s+|\d+[.)]\s+|>\s*|#{1,6}\s+)?(?:\[[ xX]\]\s+)?)([\s\S]*)$/.exec(line);
      out.push(m[1] + sentencePolicy(m[2]));
    }
    return out.join('\n');
  }

  function summarySkeleton(core) {
    const parts = core.match(/"[^"]*"|\s+|[^\s"]+/g) ?? [];
    let out = '';
    let run = '';
    const flush = () => {
      if (run !== '') {
        out += stub('s', run);
        run = '';
      }
    };
    for (const part of parts) {
      if (/^\s+$/.test(part)) {
        if (run !== '') run += part;
        else out += part;
        continue;
      }
      if (part.startsWith('"')) {
        flush();
        out += part.length <= 2 ? part : '"' + stub('s', part.slice(1, -1)) + '"';
        continue;
      }
      const bare = part.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, '');
      if (bare === '' || /^\d+$/.test(bare) || SUMMARY_WORDS.has(bare.toLowerCase())) {
        flush();
        out += part;
        continue;
      }
      run += part;
    }
    flush();
    return out.replace(/(<s:\d+b>)\s+$/, '$1');
  }

  function taggedText(tag, text, outerKind) {
    if (text.trim() === '') return text;
    const lead = /^\s*/.exec(text)[0];
    const trail = /\s*$/.exec(text)[0];
    const core = text.slice(lead.length, text.length - trail.length);
    const wrap = (v) => lead + v + trail;
    switch (tag) {
      case 'command-name':
        return wrap(/^\/?[\w:./-]{1,64}$/.test(core) ? keep('tag', core) : stub('s', core));
      case 'task-id':
      case 'tool-use-id':
        return wrap(ids.mapByShape(core));
      case 'output-file':
        return wrap(scrubPath(core));
      case 'status':
        return wrap(/^[a-z_-]{1,32}$/i.test(core) ? keep('tag', core) : stub('s', core));
      case 'summary':
        return wrap(summarySkeleton(core));
      case 'local-command-stdout':
        return wrap(redactOutput(core));
      case 'system-reminder':
        return wrap(stub('meta', core));
      case undefined:
        return wrap(stub(outerKind, core));
      default:
        return wrap(stub('s', core));
    }
  }

  /** Keeps the XML-ish tag skeleton of a prompt/system body; bodies are stubbed per tag. */
  function redactTagged(s, outerKind) {
    const re = /<\/?([a-z][a-z0-9-]*)>/g;
    const stack = [];
    let out = '';
    let last = 0;
    let m;
    while ((m = re.exec(s)) !== null) {
      out += taggedText(stack[stack.length - 1], s.slice(last, m.index), outerKind);
      if (m[0][1] === '/') {
        if (stack[stack.length - 1] === m[1]) stack.pop();
      } else stack.push(m[1]);
      out += m[0];
      last = m.index + m[0].length;
    }
    out += taggedText(stack[stack.length - 1], s.slice(last), outerKind);
    return out;
  }

  function isTagged(s) {
    return /^\s*<[a-z][a-z0-9-]*>/.test(s) && /<\/[a-z][a-z0-9-]*>/.test(s);
  }

  /** Human/system prompt text. */
  function redactPromptText(s, r) {
    if (s === '') return '';
    if (s === '[Request interrupted by user]' || s === '[Request interrupted by user for tool use]') return s;
    if (s.startsWith('[Request interrupted')) return '[Request interrupted' + stub('prompt', s.slice('[Request interrupted'.length));
    if (isTagged(s)) return redactTagged(s, r.isCompactSummary ? 'summary' : r.isMeta ? 'meta' : 'prompt');
    if (r.isCompactSummary) return stub('summary', s);
    if (r.isMeta || r.turnCompanion) return stub('meta', s);
    return stub('prompt', s);
  }

  // ---------------------------------------------------------------- blocks
  function redactImageSource(source) {
    if (!source || typeof source !== 'object') return generic(source, 'source');
    const out = {};
    for (const [k, v] of Object.entries(source)) {
      if (k === 'data') out[k] = typeof v === 'string' ? '<img>' : generic(v, k);
      else if (k === 'type' || k === 'media_type') out[k] = typeof v === 'string' ? scrub(v) : generic(v, k);
      else out[k] = generic(v, k);
    }
    return out;
  }

  function redactDocumentSource(source) {
    if (!source || typeof source !== 'object') return generic(source, 'source');
    const out = {};
    for (const [k, v] of Object.entries(source)) {
      if (k === 'data') out[k] = typeof v === 'string' ? stub('file', v) : generic(v, k);
      else if (k === 'type' || k === 'media_type') out[k] = typeof v === 'string' ? scrub(v) : generic(v, k);
      else out[k] = generic(v, k);
    }
    return out;
  }

  function redactToolInput(name, input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return generic(input, 'input');
    const out = {};
    for (const [k, v] of Object.entries(input)) {
      if (typeof v !== 'string') {
        if (k === 'edits' && Array.isArray(v)) out[k] = v.map((e) => redactToolInput(name, e));
        else if ((k === 'allowed_domains' || k === 'blocked_domains') && Array.isArray(v)) out[k] = v.map((d) => (typeof d === 'string' ? scrub('https://' + d).replace(/^https:\/\//, '').replace(/\/$/, '') : generic(d, k)));
        else if ((k === 'addBlocks' || k === 'addBlockedBy') && Array.isArray(v)) out[k] = v.map((t) => (typeof t === 'string' ? idValue('taskId', t) : t));
        else out[k] = generic(v, k);
        continue;
      }
      if (k === 'command' || k === 'cmd') out[k] = redactCommand(v);
      else if (k === 'description' || k === 'activeForm' || k === 'subject') out[k] = v === '' ? '' : stub('desc', v);
      else if (k === 'prompt' || k === 'message') out[k] = v === '' ? '' : stub('prompt', v);
      else if (PATH_KEYS.has(k)) out[k] = scrubPath(v);
      else if (k === 'old_string' || k === 'new_string' || k === 'content' || k === 'new_source' || k === 'oldString' || k === 'newString') out[k] = redactCode(v);
      else if (k === 'url') out[k] = scrub(v);
      else if (k === 'query') out[k] = v === '' ? '' : stub('q', v);
      else if (k in ID_KEY_KINDS || k === 'cell_id') out[k] = k in ID_KEY_KINDS ? idValue(k, v) : scrub(v);
      else if (FIELD_KEEP.has(k) && v.length <= 64) out[k] = scrub(v);
      else out[k] = v === '' ? '' : stub('s', v);
    }
    return out;
  }

  function redactWebSearchResults(v) {
    if (Array.isArray(v)) return v.map(redactWebSearchResults);
    if (v && typeof v === 'object') {
      if (typeof v.url === 'string' || typeof v.title === 'string') {
        const host = /^https?:\/\/([^/\s:]+)/.exec(String(v.url ?? ''))?.[1] ?? 'unknown';
        return { title: '<t>', url: `https://${hostN(host.toLowerCase())}/` };
      }
      const out = {};
      for (const [k, x] of Object.entries(v)) out[k] = k === 'tool_use_id' ? scrub(String(x)) : redactWebSearchResults(x);
      return out;
    }
    if (typeof v === 'string') return v === '' ? '' : stub('s', v);
    return v;
  }

  function redactReadFile(file) {
    if (!file || typeof file !== 'object') return generic(file, 'file');
    const out = {};
    for (const [k, v] of Object.entries(file)) {
      if (k === 'content' || k === 'base64') out[k] = typeof v === 'string' ? (v === '' ? '' : stub('file', v)) : generic(v, k);
      else if (PATH_KEYS.has(k)) out[k] = typeof v === 'string' ? scrubPath(v) : generic(v, k);
      else if (FIELD_KEEP.has(k)) out[k] = keepDeep(v, k);
      else out[k] = generic(v, k);
    }
    return out;
  }

  function redactToolResultObject(name, t) {
    const out = {};
    for (const [k, v] of Object.entries(t)) {
      if (k === 'stdout' || k === 'stderr') out[k] = typeof v === 'string' ? redactOutput(v) : generic(v, k);
      else if (k === 'oldString' || k === 'newString' || k === 'originalFile' || (k === 'content' && name !== 'Read')) out[k] = typeof v === 'string' ? redactCode(v) : generic(v, k);
      else if (k === 'structuredPatch' && Array.isArray(v)) out[k] = v.map((hunk) => (hunk && typeof hunk === 'object' ? Object.fromEntries(Object.entries(hunk).map(([hk, hv]) => [hk, hk === 'lines' && Array.isArray(hv) ? hv.map((l) => (typeof l === 'string' ? redactPatchLine(l) : generic(l, 'lines'))) : keepDeep(hv, hk)])) : generic(hunk, k)));
      else if (k === 'edits' && Array.isArray(v)) out[k] = v.map((e) => redactToolInput(name, e));
      else if (k === 'file') out[k] = redactReadFile(v);
      else if (k === 'base64') out[k] = typeof v === 'string' ? stub('file', v) : generic(v, k);
      else if (k === 'description') out[k] = typeof v === 'string' ? (v === '' ? '' : stub('desc', v)) : generic(v, k);
      else if (k === 'prompt') out[k] = typeof v === 'string' ? (v === '' ? '' : stub('prompt', v)) : generic(v, k);
      else if (k === 'query') out[k] = typeof v === 'string' ? (v === '' ? '' : stub('q', v)) : generic(v, k);
      else if (k === 'results') out[k] = redactWebSearchResults(v);
      else if (k === 'result' || k === 'listing' || k === 'plan' || k === 'message' || k === 'summary' || k === 'workflowName') out[k] = typeof v === 'string' ? (v === '' ? '' : stub(k === 'result' ? 'out' : 's', v)) : generic(v, k);
      else if (k === 'url') out[k] = typeof v === 'string' ? scrub(v) : generic(v, k);
      else if (k === 'command') out[k] = typeof v === 'string' ? redactCommand(v) : generic(v, k);
      else if (k === 'gitOperation' || k === 'task') out[k] = k === 'task' ? generic(v, k) : keepDeep(v, k);
      else if (k === 'runId') out[k] = typeof v === 'string' ? scrub(v) : generic(v, k);
      else if (PATH_KEYS.has(k)) out[k] = typeof v === 'string' ? scrubPath(v) : generic(v, k);
      else if (k in ID_KEY_KINDS) out[k] = typeof v === 'string' ? idValue(k, v) : generic(v, k);
      else if (FIELD_KEEP.has(k)) out[k] = keepDeep(v, k);
      else out[k] = generic(v, k);
    }
    return out;
  }

  function redactToolResultContent(content) {
    if (typeof content === 'string') return redactOutput(content);
    if (Array.isArray(content)) return content.map((b) => redactContentBlock(b, { role: 'tool_result' }));
    return generic(content, 'content');
  }

  /** `toolUseResult` of any tool: string / array / object shapes. */
  function redactToolUseResult(name, t) {
    if (typeof t === 'string') return redactOutput(t);
    if (Array.isArray(t)) return redactToolResultContent(t);
    if (t && typeof t === 'object') return redactToolResultObject(name, t);
    return t;
  }

  function redactContentBlock(b, ctx) {
    if (!b || typeof b !== 'object') return generic(b, 'content');
    const out = {};
    for (const [k, v] of Object.entries(b)) {
      if (k === 'type' || k === 'name' || k === 'is_error' || k === 'caller') out[k] = keepDeep(v, k);
      else if (k === 'id' || k === 'tool_use_id') out[k] = typeof v === 'string' ? scrub(v) : v;
      else if (k === 'text') {
        if (typeof v !== 'string') out[k] = generic(v, k);
        else if (ctx.role === 'assistant') out[k] = ctx.isFinal ? redactFinalText(v) : v === '' ? '' : stub('text', v);
        else if (ctx.role === 'tool_result') out[k] = redactOutput(v);
        else out[k] = redactPromptText(v, ctx.record);
      } else if (k === 'thinking') out[k] = typeof v === 'string' ? (v === '' ? '' : stub('think', v)) : generic(v, k);
      else if (k === 'signature' || k === 'data') out[k] = typeof v === 'string' ? '<sig>' : generic(v, k);
      else if (k === 'input' && b.type === 'tool_use') out[k] = redactToolInput(String(b.name ?? ''), v);
      else if (k === 'content' && b.type === 'tool_result') out[k] = redactToolResultContent(v);
      else if (k === 'source' && b.type === 'image') out[k] = redactImageSource(v);
      else if (k === 'source' && b.type === 'document') out[k] = redactDocumentSource(v);
      else out[k] = generic(v, k);
    }
    return out;
  }

  function isFinalAssistant(r) {
    const m = r.message;
    return !!m && m.stop_reason === 'end_turn' && m.model !== '<synthetic>' && r.isApiErrorMessage !== true;
  }

  function redactMessage(msg, r) {
    if (!msg || typeof msg !== 'object') return generic(msg, 'message');
    const role = r.type === 'assistant' ? 'assistant' : 'user';
    const ctx = { role, isFinal: role === 'assistant' && isFinalAssistant(r), record: r };
    const out = {};
    for (const [k, v] of Object.entries(msg)) {
      if (k === 'content') {
        if (typeof v === 'string') out[k] = role === 'assistant' ? (ctx.isFinal ? redactFinalText(v) : v === '' ? '' : stub('text', v)) : redactPromptText(v, r);
        else if (Array.isArray(v)) out[k] = v.map((b) => redactContentBlock(b, ctx));
        else out[k] = generic(v, k);
      } else if (k === 'id' || k === 'model' || k === 'role' || k === 'type' || k === 'stop_reason' || k === 'stop_sequence' || k === 'usage' || k === 'container' || k === 'context_management' || k === 'stop_details' || k === 'diagnostics') out[k] = keepDeep(v, k);
      else out[k] = generic(v, k);
    }
    return out;
  }

  function redactAttachment(att) {
    if (!att || typeof att !== 'object') return generic(att, 'attachment');
    const out = {};
    for (const [k, v] of Object.entries(att)) {
      if (k === 'type' || k === 'hookName' || k === 'hookEvent' || k === 'status' || k === 'taskType' || k === 'commandMode' || k === 'reminderType' || k === 'newDate') out[k] = keepDeep(v, k);
      else if (k === 'toolUseID' || k === 'toolUseId') out[k] = typeof v === 'string' ? scrub(v) : v;
      else if (k === 'taskId') out[k] = typeof v === 'string' ? idValue('agentId', v) : v;
      else if (k === 'prompt') out[k] = typeof v === 'string' ? (v === '' ? '' : stub('prompt', v)) : generic(v, k);
      else if (k === 'description') out[k] = typeof v === 'string' ? (v === '' ? '' : stub('desc', v)) : generic(v, k);
      else if (k === 'content' && v && typeof v === 'object' && !Array.isArray(v) && v.file) out[k] = { ...generic(v, k), file: redactReadFile(v.file) };
      else if (k === 'skills' && Array.isArray(v)) out[k] = v.map((s) => (s && typeof s === 'object' ? { ...generic(s, 'skills'), path: typeof s.path === 'string' ? scrubPath(s.path) : s.path } : generic(s, k)));
      else out[k] = generic(v, k);
    }
    return out;
  }

  function redactSystemContent(s, r) {
    if (typeof s !== 'string') return generic(s, 'content');
    if (s === '') return '';
    if (isTagged(s)) return redactTagged(s, 'meta');
    if (r.subtype === 'compact_boundary') return keep('tag', s);
    return stub('s', s);
  }

  function branchValue(v) {
    if (typeof v !== 'string') return v;
    if (v === '' || v === 'main' || v === 'master' || v === 'HEAD' || v === 'develop') return v;
    let mapped = branches.get(v);
    if (mapped === undefined) {
      mapped = `branch-${branches.size + 1}`;
      branches.set(v, mapped);
    }
    return mapped;
  }

  // ---------------------------------------------------------------- records
  /** Redacts one Claude Code transcript record (main or subagent file). */
  function redactClaudeRecord(r) {
    if (!r || typeof r !== 'object' || Array.isArray(r)) return generic(r, '');
    const out = {};
    for (const [k, v] of Object.entries(r)) {
      if (k === 'message') out[k] = redactMessage(v, r);
      else if (k === 'toolUseResult') out[k] = redactToolUseResult(r.__tool ?? sniffTool(v), v);
      else if (k === 'attachment') out[k] = redactAttachment(v);
      else if (k === 'content') out[k] = r.type === 'queue-operation' ? (typeof v === 'string' ? (v === '' ? '' : stub('q', v)) : generic(v, k)) : redactSystemContent(v, r);
      else if (k === '__tool') continue;
      else if (k === 'cwd' || PATH_KEYS.has(k)) out[k] = typeof v === 'string' ? scrubPath(v) : generic(v, k);
      else if (k === 'gitBranch') out[k] = branchValue(v);
      else if (k === 'slug') out[k] = typeof v === 'string' ? 'fixture-slug' : generic(v, k);
      else if (k === 'origin') out[k] = v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([ok, ov]) => [ok, ok === 'kind' ? keepDeep(ov, ok) : generic(ov, ok)])) : generic(v, k);
      else if (k === 'aiTitle') out[k] = 'Fixture session';
      else if (k === 'agentName') out[k] = 'fixture-agent';
      else if (k === 'lastPrompt') out[k] = typeof v === 'string' ? stub('prompt', v) : generic(v, k);
      else if (k === 'atis') out[k] = typeof v === 'string' ? (v === '' ? '' : stub('s', v)) : generic(v, k);
      else if (k === 'prUrl') out[k] = typeof v === 'string' ? `https://github.com/u/proj/pull/${/\/pull\/(\d+)/.exec(v)?.[1] ?? String(r.prNumber ?? 0)}` : generic(v, k);
      else if (k === 'prRepository') out[k] = typeof v === 'string' ? 'u/proj' : generic(v, k);
      else if (k === 'frameUrl') out[k] = typeof v === 'string' ? 'https://host-0.example/frame' : generic(v, k);
      else if (k === 'title' && r.type === 'frame-link') out[k] = 'Fixture frame';
      else if (k === 'ownerAccountUuid') out[k] = FIXED_OWNER_ACCOUNT;
      else if (k === 'ownerOrganizationUuid') out[k] = FIXED_OWNER_ORG;
      else if (k in ID_KEY_KINDS) out[k] = typeof v === 'string' ? idValue(k, v) : generic(v, k);
      else if (k === 'apiRefusalExplanation') out[k] = typeof v === 'string' ? (v === '' ? '' : stub('s', v)) : v;
      else if (k === 'summary' && r.type === 'summary') out[k] = typeof v === 'string' ? stub('summary', v) : generic(v, k);
      else if (k === 'snapshot' && v && typeof v === 'object') out[k] = Object.fromEntries(Object.entries(v).map(([sk, sv]) => [sk, sk === 'messageId' || sk === 'timestamp' ? keepDeep(sv, sk) : generic(sv, sk)]));
      else if (TOP_KEEP.has(k)) out[k] = keepDeep(v, k);
      else out[k] = generic(v, k);
    }
    return out;
  }

  function sniffTool(t) {
    if (t && typeof t === 'object' && !Array.isArray(t)) {
      if ('stdout' in t) return 'Bash';
      if ('structuredPatch' in t) return 'type' in t ? 'Write' : 'Edit';
      if ('file' in t) return 'Read';
      if ('agentId' in t) return 'Agent';
      if ('runId' in t) return 'Workflow';
    }
    return 'unknown';
  }

  /** `agent-<id>.meta.json` sidecars. */
  function redactMeta(obj) {
    if (!obj || typeof obj !== 'object') return generic(obj, '');
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      if (k === 'description') out[k] = typeof v === 'string' ? (v === '' ? '' : stub('desc', v)) : generic(v, k);
      else if (k === 'toolUseId') out[k] = typeof v === 'string' ? scrub(v) : v;
      else if (k in ID_KEY_KINDS) out[k] = typeof v === 'string' ? idValue(k, v) : generic(v, k);
      else if (k === 'agentType' || k === 'spawnDepth' || k === 'model' || k === 'isFork' || k === 'worktreeCleanlyRemoved') out[k] = keepDeep(v, k);
      else out[k] = generic(v, k);
    }
    return out;
  }

  /** `journal.jsonl` records. */
  function redactJournal(r) {
    if (!r || typeof r !== 'object') return generic(r, '');
    const out = {};
    for (const [k, v] of Object.entries(r)) {
      if (k === 'type' || k === 'timestamp') out[k] = keepDeep(v, k);
      else if (k in ID_KEY_KINDS) out[k] = typeof v === 'string' ? idValue(k, v) : generic(v, k);
      else out[k] = generic(v, k);
    }
    return out;
  }

  // ---------------------------------------------------------------- codex
  function redactCodexOutputString(s) {
    if (s.startsWith('{')) {
      try {
        const j = JSON.parse(s);
        if (j && typeof j === 'object' && !Array.isArray(j)) {
          const out = {};
          for (const [k, v] of Object.entries(j)) {
            if (k === 'output') out[k] = typeof v === 'string' ? redactOutput(v) : generic(v, k);
            else if (k === 'metadata') out[k] = keepDeep(v, k);
            else out[k] = generic(v, k);
          }
          return JSON.stringify(out);
        }
      } catch {
        /* not JSON: fall through to the line policy */
      }
    }
    return redactOutput(s);
  }

  function redactCodexOutput(v) {
    if (typeof v === 'string') return redactCodexOutputString(v);
    if (Array.isArray(v)) return v.map((b) => (b && typeof b === 'object' ? Object.fromEntries(Object.entries(b).map(([k, x]) => [k, k === 'text' && typeof x === 'string' ? redactOutput(x) : k === 'type' ? keepDeep(x, k) : generic(x, k)])) : generic(b, 'output')));
    return generic(v, 'output');
  }

  function redactCodexArgs(argsStr) {
    let args;
    try {
      args = JSON.parse(argsStr);
    } catch {
      return stub('s', argsStr);
    }
    if (!args || typeof args !== 'object' || Array.isArray(args)) return JSON.stringify(generic(args, 'arguments'));
    const out = {};
    for (const [k, v] of Object.entries(args)) {
      if ((k === 'cmd' || k === 'command') && typeof v === 'string') out[k] = redactCommand(v);
      else if ((k === 'cmd' || k === 'command') && Array.isArray(v)) out[k] = v.map((el) => (typeof el === 'string' ? (el.length > MAX_COMMAND_LITERAL_CHARS || /\s/.test(el) ? redactCommand(el) : scrub(el)) : generic(el, k)));
      else if (k === 'chars' && typeof v === 'string') out[k] = /^[\u0000-\u001f]*$/.test(v) ? v : stub('str', v);
      else if (PATH_KEYS.has(k)) out[k] = typeof v === 'string' ? scrubPath(v) : generic(v, k);
      else if (FIELD_KEEP.has(k)) out[k] = keepDeep(v, k);
      else out[k] = generic(v, k);
    }
    return JSON.stringify(out);
  }

  function redactCodexUserMessage(msg) {
    const m = /^(# Context from my IDE setup:\n)([\s\S]*?)(\n## My request for Codex:\n)([\s\S]*)$/.exec(msg);
    if (m) return m[1] + stub('meta', m[2]) + m[3] + (m[4] === '' ? '' : stub('prompt', m[4]));
    return msg === '' ? '' : stub('prompt', msg);
  }

  function redactCodexMessageItem(p) {
    const out = {};
    const role = typeof p.role === 'string' ? p.role : 'user';
    for (const [k, v] of Object.entries(p)) {
      if (k === 'content' && Array.isArray(v)) {
        out[k] = v.map((c) => {
          if (!c || typeof c !== 'object') return generic(c, 'content');
          const cc = {};
          for (const [ck, cv] of Object.entries(c)) {
            if (ck === 'text' && typeof cv === 'string') {
              if (role === 'assistant') cc[ck] = redactFinalText(cv);
              else if (role === 'developer') cc[ck] = cv === '' ? '' : stub('instr', cv);
              else cc[ck] = isTagged(cv) ? redactTagged(cv, 'prompt') : cv === '' ? '' : stub('prompt', cv);
            } else if (ck === 'type') cc[ck] = keepDeep(cv, ck);
            else cc[ck] = generic(cv, ck);
          }
          return cc;
        });
      } else if (k === 'type' || k === 'role' || k === 'phase' || k === 'id' || k === 'status') out[k] = keepDeep(v, k);
      else out[k] = generic(v, k);
    }
    return out;
  }

  function redactCodexPayload(type, p) {
    if (!p || typeof p !== 'object' || Array.isArray(p)) return generic(p, 'payload');
    const out = {};
    if (type === 'session_meta') {
      for (const [k, v] of Object.entries(p)) {
        if (k === 'base_instructions') out[k] = v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([bk, bv]) => [bk, bk === 'text' && typeof bv === 'string' ? stub('instr', bv) : generic(bv, bk)])) : typeof v === 'string' ? stub('instr', v) : v;
        else if (k === 'cwd' || PATH_KEYS.has(k)) out[k] = typeof v === 'string' ? scrubPath(v) : generic(v, k);
        else out[k] = keepDeep(v, k);
      }
      return out;
    }
    if (type === 'turn_context') {
      for (const [k, v] of Object.entries(p)) {
        if (k === 'user_instructions' || k === 'developer_instructions') out[k] = typeof v === 'string' ? stub('instr', v) : generic(v, k);
        else if (k === 'cwd') out[k] = typeof v === 'string' ? scrubPath(v) : generic(v, k);
        else if (k === 'sandbox_policy' && v && typeof v === 'object') out[k] = Object.fromEntries(Object.entries(v).map(([sk, sv]) => [sk, sk === 'writable_roots' && Array.isArray(sv) ? sv.map((w) => (typeof w === 'string' ? scrubPath(w) : generic(w, sk))) : keepDeep(sv, sk)]));
        else if (k === 'collaboration_mode') out[k] = v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([ck, cv]) => [ck, ck === 'settings' && cv && typeof cv === 'object' ? Object.fromEntries(Object.entries(cv).map(([sk, sv]) => [sk, sk === 'developer_instructions' && typeof sv === 'string' ? stub('instr', sv) : keepDeep(sv, sk)])) : keepDeep(cv, ck)])) : generic(v, k);
        else out[k] = keepDeep(v, k);
      }
      return out;
    }
    const ptype = typeof p.type === 'string' ? p.type : '';
    if (type === 'event_msg') {
      for (const [k, v] of Object.entries(p)) {
        if (ptype === 'user_message' && k === 'message' && typeof v === 'string') out[k] = redactCodexUserMessage(v);
        else if (ptype === 'agent_message' && k === 'message' && typeof v === 'string') out[k] = redactFinalText(v);
        else if (ptype === 'agent_reasoning' && k === 'text' && typeof v === 'string') out[k] = v === '' ? '' : stub('think', v);
        else if (ptype === 'token_count' && (k === 'info' || k === 'rate_limits')) out[k] = v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([rk, rv]) => [rk, rk === 'plan_type' && typeof rv === 'string' ? stub('s', rv) : keepDeep(rv, rk)])) : v;
        else if (k === 'type') out[k] = keepDeep(v, k);
        else out[k] = generic(v, k);
      }
      return out;
    }
    if (type === 'response_item') {
      if (ptype === 'message') return redactCodexMessageItem(p);
      for (const [k, v] of Object.entries(p)) {
        if (ptype === 'reasoning' && k === 'encrypted_content') out[k] = typeof v === 'string' ? '<enc>' : generic(v, k);
        else if (ptype === 'reasoning' && (k === 'summary' || k === 'content')) out[k] = Array.isArray(v) ? [] : v === null ? null : generic(v, k);
        else if (ptype === 'function_call' && k === 'arguments' && typeof v === 'string') out[k] = redactCodexArgs(v);
        else if ((ptype === 'function_call_output' || ptype === 'custom_tool_call_output') && k === 'output') out[k] = redactCodexOutput(v);
        else if (ptype === 'custom_tool_call' && k === 'input' && typeof v === 'string') out[k] = p.name === 'apply_patch' ? redactPatch(v) : stub('s', v);
        else if (ptype === 'local_shell_call' && k === 'action') out[k] = v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([ak, av]) => [ak, (ak === 'command' || ak === 'cmd') && typeof av === 'string' ? redactCommand(av) : (ak === 'command' || ak === 'cmd') && Array.isArray(av) ? av.map((el) => (typeof el === 'string' ? (el.length > MAX_COMMAND_LITERAL_CHARS || /\s/.test(el) ? redactCommand(el) : scrub(el)) : generic(el, ak))) : ak === 'working_directory' ? (typeof av === 'string' ? scrubPath(av) : av) : keepDeep(av, ak)])) : generic(v, k);
        else if (k === 'type' || k === 'name' || k === 'call_id' || k === 'status' || k === 'id') out[k] = keepDeep(v, k);
        else out[k] = generic(v, k);
      }
      return out;
    }
    return generic(p, 'payload');
  }

  /** Redacts one Codex rollout record `{timestamp, type, payload}`. */
  function redactCodexRecord(r) {
    if (!r || typeof r !== 'object' || Array.isArray(r)) return generic(r, '');
    const out = {};
    for (const [k, v] of Object.entries(r)) {
      if (k === 'payload') out[k] = redactCodexPayload(String(r.type ?? ''), v);
      else if (k === 'timestamp' || k === 'type') out[k] = keepDeep(v, k);
      else out[k] = generic(v, k);
    }
    return out;
  }

  /** `session_index.jsonl` records. */
  function redactSessionIndex(r) {
    if (!r || typeof r !== 'object') return generic(r, '');
    const out = {};
    for (const [k, v] of Object.entries(r)) {
      if (k === 'id') out[k] = typeof v === 'string' ? scrub(v) : v;
      else if (k === 'thread_name') out[k] = `Fixture thread ${++threadN}`;
      else if (k === 'updated_at') out[k] = keepDeep(v, k);
      else out[k] = generic(v, k);
    }
    return out;
  }

  /** `models_cache.json`: only `client_version` and the reader-relevant model keys survive. */
  function redactModelsCache(obj) {
    const out = {};
    if (obj && typeof obj === 'object') {
      if (typeof obj.client_version === 'string') out.client_version = scrub(obj.client_version);
      if (Array.isArray(obj.models)) {
        out.models = obj.models.map((m) => {
          const mm = {};
          if (!m || typeof m !== 'object') return mm;
          for (const k of ['slug', 'shell_type', 'apply_patch_tool_type', 'truncation_policy', 'multi_agent_version']) {
            if (k in m) mm[k] = keepDeep(m[k], k);
          }
          return mm;
        });
      }
    }
    return out;
  }

  return {
    stub,
    scrub,
    redactClaudeRecord,
    redactMeta,
    redactJournal,
    redactCodexRecord,
    redactSessionIndex,
    redactModelsCache,
    redactFinalText,
    redactCommand,
    redactOutput,
    redactCode,
    redactPatch,
    stats,
    hosts: () => Object.fromEntries(hosts),
    branches: () => Object.fromEntries(branches),
  };
}

/**
 * Pass-1 registration: ids that are only recognisable by key, the tool name
 * behind every `tool_use` id, and every working directory for the path map.
 */
export function collectIds(r, { ids, paths, toolNames, harness }) {
  if (!r || typeof r !== 'object') return;
  if (harness === 'codex') {
    const p = r.payload;
    if (p && typeof p === 'object') {
      if (typeof p.cwd === 'string') paths.registerCwd(p.cwd);
      if (p.sandbox_policy && Array.isArray(p.sandbox_policy.writable_roots)) for (const w of p.sandbox_policy.writable_roots) paths.registerCwd(w);
    }
    return;
  }
  if (typeof r.cwd === 'string') paths.registerCwd(r.cwd);
  const visit = (v, key, depth) => {
    if (depth > 8 || v === null || typeof v !== 'object') {
      if (typeof v === 'string' && key in ID_KEY_KINDS) {
        const kind = ID_KEY_KINDS[key];
        if (kind === 'task' && /^[a-z0-9]{9}$/.test(v)) ids.register(v, 'task');
        else if ((kind === 'agent' || kind === 'task') && /^[a-z0-9]{15,}$/i.test(v)) ids.register(v, 'agent');
        else if (kind === 'bridge') ids.register(v, 'bridge');
      }
      return;
    }
    if (Array.isArray(v)) {
      for (const x of v) visit(x, key, depth + 1);
      return;
    }
    if (v.type === 'tool_use' && typeof v.id === 'string' && typeof v.name === 'string') toolNames.set(v.id, v.name);
    for (const [k, x] of Object.entries(v)) visit(x, k, depth + 1);
  };
  visit(r, '', 0);
}

/** The tool name behind a `user` record's `tool_result`, from the pass-1 map. */
export function toolNameOf(r, toolNames) {
  const c = r?.message?.content;
  if (!Array.isArray(c)) return undefined;
  const tr = c.find((b) => b && b.type === 'tool_result');
  return tr ? toolNames.get(tr.tool_use_id) : undefined;
}
