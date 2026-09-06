/*
 * showreceipts report app (S22, ARCHITECTURE section 11). Hash-locked CSP,
 * default-src 'none': every node is built with createElement/createTextNode/
 * textContent, never by parsing markup; no network, no dynamic code, no
 * inline style attributes; hash state is regex-validated by the router.
 */
(function () {
  'use strict';

  // ---- payload ----
  var dataEl = document.getElementById('data');
  var DATA = dataEl ? JSON.parse(dataEl.textContent) : { mode: 'clear', payload: null };

  /* Under mode 'both' the toggle switches DATA.payload <-> DATA.hashed. */
  function payloadFor(useHashed) {
    if (DATA.mode === 'both' && useHashed && DATA.hashed) return DATA.hashed;
    return DATA.payload;
  }

  // ---- storage (every access try/caught) ----
  function lsGet(k) {
    try { return window.localStorage.getItem(k); } catch (err) { return null; }
  }
  function lsSet(k, v) {
    try { window.localStorage.setItem(k, v); } catch (err) { /* storage unavailable */ }
  }
  function lsDel(k) {
    try { window.localStorage.removeItem(k); } catch (err) { /* storage unavailable */ }
  }

  // ---- router (section 11.4: values regex-validated) ----
  var ROUTE_RE = {
    s: /^[0-9a-f]{8,12}$/,
    seq: /^[0-9]{1,7}$/,
    sort: /^(time|cost|verdict|claims)$/,
    dir: /^(asc|desc)$/,
    fv: /^(all|bad|unk|ok|none)$/,
    fh: /^[a-z][a-z0-9-]{0,15}$/,
    tf: /^(all|test|check|git|write|danger|error)$/,
    hp: /^[01]$/,
    q: /^[\x20-\x7e\u00a0-\uffff]{1,80}$/,
    fm: /^[\x20-\x7e]{1,64}$/,
    fp: /^[\x20-\x7e]{1,64}$/,
    d1: /^\d{4}-\d{2}-\d{2}$/,
    d2: /^\d{4}-\d{2}-\d{2}$/
  };

  function parseRoute() {
    var out = {};
    var raw = location.hash.replace(/^#/, '');
    if (raw === '') return out;
    var parts = raw.split('&');
    for (var i = 0; i < parts.length; i++) {
      var eq = parts[i].indexOf('=');
      if (eq === -1) continue;
      var k = parts[i].slice(0, eq);
      var v;
      try { v = decodeURIComponent(parts[i].slice(eq + 1)); } catch (err) { continue; }
      if (ROUTE_RE[k] && ROUTE_RE[k].test(v)) out[k] = v;
    }
    return out;
  }

  function routeHash(next) {
    var keys = Object.keys(next).sort();
    var parts = [];
    for (var i = 0; i < keys.length; i++) {
      var v = next[keys[i]];
      if (v === undefined || v === null || v === '') continue;
      parts.push(keys[i] + '=' + encodeURIComponent(String(v)));
    }
    return '#' + parts.join('&');
  }

  function go(patch) {
    var next = {};
    var k;
    for (k in route) next[k] = route[k];
    for (k in patch) {
      if (patch[k] === null) delete next[k];
      else next[k] = patch[k];
    }
    var hash = routeHash(next);
    if (hash === location.hash) render();
    else location.hash = hash;
  }

  // ---- DOM helpers (createElement/textContent) ----
  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }
  function attr(node, name, value) {
    node.setAttribute(name, value);
    return node;
  }
  function add(parent) {
    for (var i = 1; i < arguments.length; i++) if (arguments[i]) parent.appendChild(arguments[i]);
    return parent;
  }

  /* Allow-list, never a deny-list: only plain web URLs may become links. */
  function safeUrl(u) {
    return typeof u === 'string' && /^https?:\/\/\S+$/i.test(u) ? u : null;
  }
  function extLink(url, label) {
    var a = el('a', null, label || url);
    a.href = url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    return a;
  }

  // ---- formatting ----
  /* Section 8.3 shape: null -> n/a; <0.01 -> 4 decimals; <1000 -> 2; >=1000 -> comma-grouped dollars. */
  function fmtUsd(v, approx) {
    if (v === null || v === undefined) return 'n/a';
    var p = (approx ? '≈' : '') + '$';
    if (v < 0.01) return p + (v === 0 ? '0.00' : v.toFixed(4));
    return v < 1000 ? p + v.toFixed(2) : p + String(Math.round(v)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }
  function fmtPct(num, den) {
    return den ? Math.round((num / den) * 100) + '%' : '—';
  }
  function fmtWhen(iso) {
    return typeof iso === 'string' && iso.length >= 16 ? iso.slice(0, 16).replace('T', ' ') + 'Z' : '';
  }
  function fmtOffset(ms) {
    if (ms === null || ms === undefined) return '';
    var s = Math.max(0, Math.round(ms / 1000));
    var m = Math.floor(s / 60);
    var h = Math.floor(m / 60);
    function two(n) { return (n < 10 ? '0' : '') + n; }
    if (h > 0) return '+' + h + ':' + two(m % 60) + ':' + two(s % 60);
    return '+' + m + ':' + two(s % 60);
  }

  var VERDICT_PILL = { VERIFIED: 'ok', CONTRADICTED: 'bad', UNVERIFIED: 'unk' };
  var GLYPH = { ok: '✓', bad: '✗', unk: '?', said: '~' };
  function pillFor(verdict) {
    var kind = VERDICT_PILL[verdict] || 'none';
    var label = verdict === '—' ? 'no verdict' : String(verdict).toLowerCase().replace(/_/g, ' ');
    return el('span', 'pill pill-' + kind, label);
  }

  // ---- state ----
  var app = document.getElementById('app');
  var route = parseRoute();
  var P = payloadFor(route.hp === '1');
  var statusEl = null;
  var headerEl = null;
  var mainEl = null;
  var helpEl = null;
  var themeBtn = null;
  var listState = { shown: 100, active: 0 };
  var keysOn = lsGet('showreceipts.keys') !== 'off';

  function announce(msg) {
    if (statusEl) statusEl.textContent = msg;
  }
  function keyOf(card) {
    return card.harness + ':' + card.id;
  }
  function cardByShort(sid) {
    for (var i = 0; i < P.sessions.length; i++) if (P.sessions[i].shortId === sid) return P.sessions[i];
    return null;
  }

  // ---- rendering in rAF chunks of 50 ----
  var CHUNK = 50;
  function chunked(items, each, done) {
    var i = 0;
    function step() {
      var end = Math.min(items.length, i + CHUNK);
      for (; i < end; i++) each(items[i], i);
      if (i < items.length) requestAnimationFrame(step);
      else if (done) done();
    }
    step();
  }

  // ---- theme ----
  function themePref() {
    var t = lsGet('showreceipts.theme');
    return t === 'dark' || t === 'light' ? t : 'auto';
  }
  function applyTheme(pref) {
    if (pref === 'dark' || pref === 'light') {
      attr(document.documentElement, 'data-theme', pref);
      lsSet('showreceipts.theme', pref);
    } else {
      document.documentElement.removeAttribute('data-theme');
      lsDel('showreceipts.theme');
    }
  }
  function cycleTheme() {
    var next = { auto: 'light', light: 'dark', dark: 'auto' }[themePref()];
    applyTheme(next);
    if (themeBtn) themeBtn.textContent = 'theme: ' + next;
    announce('theme set to ' + next);
  }
  function toggleHashPaths() {
    if (DATA.mode !== 'both') return;
    var hashedNow = route.hp === '1';
    go({ hp: hashedNow ? null : '1' });
    announce('paths ' + (hashedNow ? 'shown in clear' : 'hashed'));
  }

  // ---- header strip ----
  /* 11.2: scanned range + per-harness counts. */
  function scannedMeta() {
    var lo = null, hi = null, names = [], counts = {};
    for (var i = 0; i < P.sessions.length; i++) {
      var c = P.sessions[i];
      if (lo === null || c.startedAt < lo) lo = c.startedAt;
      if (hi === null || c.endedAt > hi) hi = c.endedAt;
      if (counts[c.harness] === undefined) { names.push(c.harness); counts[c.harness] = 0; }
      counts[c.harness]++;
    }
    var parts = [];
    for (var j = 0; j < names.length; j++) parts.push(counts[names[j]] + ' ' + names[j]);
    return (lo === null ? 'no sessions' : 'scanned ' + lo.slice(0, 10) + ' → ' + hi.slice(0, 10))
      + (parts.length > 0 ? ' · ' + parts.join(' · ') : '');
  }

  function buildHeader() {
    var hdr = el('header', 'hdr');
    add(hdr, el('h1', null, 'showreceipts'));
    add(hdr, el('span', 'meta', scannedMeta() + ' · generated ' + fmtWhen(P.meta.generatedAt) + ' · times UTC'));
    add(hdr, el('span', 'spacer'));

    themeBtn = el('button', null, 'theme: ' + themePref());
    themeBtn.type = 'button';
    themeBtn.addEventListener('click', cycleTheme);
    add(hdr, themeBtn);

    if (DATA.mode === 'both') {
      var hp = el('button', null, 'paths: ' + (route.hp === '1' ? 'hashed' : 'clear'));
      hp.type = 'button';
      attr(hp, 'aria-pressed', route.hp === '1' ? 'true' : 'false');
      hp.addEventListener('click', toggleHashPaths);
      add(hdr, hp);
    }

    /* 11.2: data: URI named receipt-<id>.json; href built lazily on click. */
    var exp = el('a', null, 'export JSON');
    exp.download = 'receipt-' + (route.s || 'all') + '.json';
    exp.href = 'data:application/json;charset=utf-8,';
    exp.addEventListener('click', function () {
      var card = route.s ? cardByShort(route.s) : null;
      var obj = card && P.receipts[keyOf(card)] ? P.receipts[keyOf(card)] : P;
      exp.href = 'data:application/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(obj));
    });
    add(hdr, exp);

    var help = el('button', null, '?');
    help.type = 'button';
    attr(help, 'aria-label', 'keyboard shortcuts');
    help.addEventListener('click', toggleHelp);
    add(hdr, help);
    return hdr;
  }

  // ---- rate cards ----
  function rateCards() {
    var wrap = el('section', 'cards');
    attr(wrap, 'aria-label', 'false-done rate by model');
    var rows = P.rows || [];
    for (var i = 0; i < rows.length && i < 12; i++) {
      var r = rows[i];
      var card = el('article', 'kpi');
      add(card, el('div', 'who', r.model));
      add(card, el('div', 'ver', r.harness + (r.harnessVersion ? ' ' + r.harnessVersion : '')));
      var dl = el('dl');
      var stat = function (list, dt, dd) {
        add(list, el('dt', null, dt));
        add(list, el('dd', null, dd));
      };
      stat(dl, 'done turns', r.doneTurns);
      stat(dl, 'contradicted', fmtPct(r.contradictedTurns, r.doneTurns));
      stat(dl, 'unverified', fmtPct(r.unverifiedTurns, r.doneTurns));
      stat(dl, 'test-run rate', r.testRunRate === null ? '—' : Math.round(r.testRunRate * 100) + '%');
      stat(dl, 'cost/turn', r.costPerDoneTurnUsd ? fmtUsd(r.costPerDoneTurnUsd.median) : '—');
      add(card, dl);
      add(wrap, card);
    }
    return wrap;
  }

  // ---- filters + list ----
  function select(labelText, current, options, key, def) {
    var label = el('label', null, labelText + ' ');
    var sel = el('select');
    for (var i = 0; i < options.length; i++) {
      var o = el('option', null, options[i][1]);
      o.value = options[i][0];
      if (options[i][0] === current) o.selected = true;
      add(sel, o);
    }
    sel.addEventListener('change', function () {
      var patch = {};
      patch[key] = sel.value === def ? null : sel.value;
      listState.shown = 100;
      listState.active = 0;
      go(patch);
    });
    add(label, sel);
    return label;
  }

  /* Date/search filter inputs; state lives in the hash. */
  function textInput(type, key, labelText) {
    var label = el('label', null, labelText + ' ');
    var input = el('input');
    input.type = type;
    input.value = route[key] || '';
    input.addEventListener('change', function () {
      var patch = {};
      patch[key] = input.value !== '' && ROUTE_RE[key].test(input.value) ? input.value : null;
      listState.shown = 100;
      listState.active = 0;
      go(patch);
    });
    add(label, input);
    return label;
  }

  function projOf(c) {
    var parts = String(c.cwd || '').split(/[\\/]/);
    for (var i = parts.length - 1; i >= 0; i--) if (parts[i] !== '') return parts[i];
    return c.cwd || '';
  }

  /* 11.2 text search: title, cwd, model, claims. */
  function matchesText(c, q) {
    var hay = (c.title || '') + '\n' + c.cwd + '\n' + c.model;
    var r = P.receipts[keyOf(c)];
    var lines = (r && r.lines) || [];
    for (var i = 0; i < lines.length; i++) hay += '\n' + lines[i].claim;
    return hay.toLowerCase().indexOf(q) !== -1;
  }

  function distinct(fn) {
    var out = [];
    for (var i = 0; i < P.sessions.length; i++) {
      var v = fn(P.sessions[i]);
      if (v !== '' && out.indexOf(v) === -1) out.push(v);
    }
    return out.sort();
  }
  function allOpts(label, values) {
    var out = [['all', label]];
    for (var i = 0; i < values.length; i++) out.push([values[i], values[i]]);
    return out;
  }

  function filteredCards() {
    var fv = route.fv || 'all';
    var fh = route.fh || 'all';
    var fm = route.fm || 'all';
    var fp = route.fp || 'all';
    var q = (route.q || '').toLowerCase();
    var out = [];
    for (var i = 0; i < P.sessions.length; i++) {
      var c = P.sessions[i];
      if (fh !== 'all' && c.harness !== fh) continue;
      if (fv !== 'all' && (VERDICT_PILL[c.verdict] || 'none') !== fv) continue;
      if (fm !== 'all' && c.model !== fm) continue;
      if (fp !== 'all' && projOf(c) !== fp) continue;
      if (route.d1 && c.endedAt.slice(0, 10) < route.d1) continue;
      if (route.d2 && c.startedAt.slice(0, 10) > route.d2) continue;
      if (q !== '' && !matchesText(c, q)) continue;
      out.push(c);
    }
    var sort = route.sort || 'time';
    var dir = route.dir || 'desc';
    var rank = { CONTRADICTED: 0, UNVERIFIED: 1, VERIFIED: 2, NO_CLAIMS: 3, NO_FINAL: 4, NO_TURNS: 5, '—': 6 };
    out.sort(function (a, b) {
      var d = 0;
      if (sort === 'cost') d = (a.costUsd || 0) - (b.costUsd || 0);
      else if (sort === 'claims') d = a.claims - b.claims;
      else if (sort === 'verdict') d = (rank[b.verdict] !== undefined ? rank[b.verdict] : 9) - (rank[a.verdict] !== undefined ? rank[a.verdict] : 9);
      else d = a.endedAt < b.endedAt ? -1 : a.endedAt > b.endedAt ? 1 : 0;
      if (d === 0) d = a.id < b.id ? 1 : -1;
      return dir === 'desc' ? -d : d;
    });
    return out;
  }

  function sessionList(cards) {
    var box = el('ul', 'listbox');
    attr(box, 'role', 'listbox');
    attr(box, 'aria-label', 'sessions');
    var visible = cards.slice(0, listState.shown);
    if (listState.active >= visible.length) listState.active = Math.max(0, visible.length - 1);
    chunked(visible, function (c, i) {
      var opt = el('li', 'opt');
      attr(opt, 'role', 'option');
      attr(opt, 'data-sid', c.shortId);
      attr(opt, 'aria-selected', i === listState.active ? 'true' : 'false');
      opt.tabIndex = i === listState.active ? 0 : -1;
      add(opt, pillFor(c.verdict));
      add(opt, el('span', 'who', c.harnessLabel + ' · ' + c.model));
      add(opt, el('span', 'meta mono', c.shortId));
      add(opt, el('span', 'cost', fmtUsd(c.costUsd, c.unverified)));
      add(opt, el('span', 'sub',
        fmtWhen(c.endedAt) + ' · ' + c.turns + ' turns · ' + c.claims + ' claims · ' + (c.title || c.cwd)));
      opt.addEventListener('click', function () { go({ s: c.shortId, seq: null }); });
      add(box, opt);
    });
    return box;
  }

  function overview(main) {
    add(main, rateCards());
    var filters = el('div', 'filters');
    add(filters, select('harness', route.fh || 'all', allOpts('all harnesses', distinct(function (c) { return c.harness; })), 'fh', 'all'));
    add(filters, select('model', route.fm || 'all', allOpts('all models', distinct(function (c) { return c.model; })), 'fm', 'all'));
    add(filters, select('project', route.fp || 'all', allOpts('all projects', distinct(projOf)), 'fp', 'all'));
    add(filters, select('verdict', route.fv || 'all', [
      ['all', 'all verdicts'], ['bad', 'contradicted'], ['unk', 'unverified'], ['ok', 'verified'], ['none', 'no verdict']
    ], 'fv', 'all'));
    add(filters, select('sort', route.sort || 'time', [
      ['time', 'by time'], ['cost', 'by cost'], ['verdict', 'by verdict'], ['claims', 'by claims']
    ], 'sort', 'time'));
    add(filters, select('order', route.dir || 'desc', [['desc', 'desc'], ['asc', 'asc']], 'dir', 'desc'));
    add(filters, textInput('date', 'd1', 'from'));
    add(filters, textInput('date', 'd2', 'to'));
    add(filters, textInput('search', 'q', 'search'));
    add(main, filters);
    var cards = filteredCards();
    add(main, el('p', 'status', cards.length + ' of ' + P.sessions.length + ' sessions'));
    add(main, sessionList(cards));
    if (cards.length > listState.shown) {
      var more = el('button', 'more', 'show 100 more (' + (cards.length - listState.shown) + ' below)');
      more.type = 'button';
      more.addEventListener('click', function () {
        listState.shown += 100;
        render();
      });
      add(main, more);
    }
    add(main, diagnostics());
  }

  // ---- receipt view ----
  function contraSeqs(receipt) {
    var seqs = {};
    var js = receipt.judgements || [];
    for (var i = 0; i < js.length; i++) {
      if (js[i].verdict !== 'CONTRADICTED') continue;
      var ev = js[i].evidence || [];
      for (var k = 0; k < ev.length; k++) seqs[ev[k].seq] = true;
    }
    return seqs;
  }

  function turnTabs(receipt) {
    var tabs = el('div', 'tabs');
    attr(tabs, 'role', 'tablist');
    attr(tabs, 'aria-label', 'turns with claims');
    var turns = (receipt.turnsWithClaims || []).slice();
    if (turns.indexOf(receipt.turnIndex) === -1) turns.push(receipt.turnIndex);
    turns.sort(function (a, b) { return a - b; });
    for (var i = 0; i < turns.length; i++) {
      var t = turns[i];
      var tab = el('button', null, 'turn ' + t);
      tab.type = 'button';
      attr(tab, 'role', 'tab');
      attr(tab, 'aria-selected', t === receipt.turnIndex ? 'true' : 'false');
      if (t !== receipt.turnIndex) {
        tab.disabled = true;
        tab.title = 'only the receipt for turn ' + receipt.turnIndex + ' is embedded in this report';
      }
      add(tabs, tab);
    }
    return tabs;
  }

  function claimLines(receipt, sid) {
    var wrap = el('div');
    var lines = receipt.lines || [];
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      var btn = el('button', 'claim');
      btn.type = 'button';
      attr(btn, 'aria-expanded', 'false');
      add(btn, el('span', 'glyph-' + line.glyph, GLYPH[line.glyph] || '?'));
      btn.appendChild(document.createTextNode(' '));
      add(btn, el('span', null, line.claim));
      var panel = el('div', 'refs');
      panel.hidden = true;
      var evidence = line.evidence || [];
      for (var e2 = 0; e2 < evidence.length; e2++) add(panel, el('div', null, evidence[e2]));
      var refs = line.refs || [];
      for (var r2 = 0; r2 < refs.length; r2++) {
        var a = el('a', 'mono', (refs[r2].label ? refs[r2].label + ' · ' : '') + 'seq ' + refs[r2].seq);
        a.href = '#s=' + sid + '&seq=' + refs[r2].seq;
        add(panel, a);
      }
      if (evidence.length + refs.length === 0) add(panel, el('div', null, 'no evidence recorded'));
      btn.addEventListener('click', (function (b, p) {
        return function () {
          var open = p.hidden;
          p.hidden = !open;
          attr(b, 'aria-expanded', open ? 'true' : 'false');
        };
      })(btn, panel));
      add(wrap, btn, panel);
    }
    return wrap;
  }

  function receiptView(main, card) {
    var back = el('a', null, '← all sessions');
    back.href = '#';
    add(main, el('p', null, ''));
    main.lastChild.appendChild(back);
    var receipt = P.receipts[keyOf(card)];
    if (!receipt) {
      add(main, el('p', 'status', 'no receipt embedded for this session'));
      return;
    }
    var paper = el('article', 'receipt');
    attr(paper, 'aria-label', 'receipt for session ' + card.shortId);
    add(paper, el('h2', null, 'SHOWRECEIPTS · ' + String(receipt.harnessLabel || receipt.harness).toUpperCase()));
    add(paper, el('div', 'hd',
      receipt.model + (receipt.harnessVersion ? ' · ' + receipt.harnessVersion : '') + ' · session ' + receipt.shortId));
    add(paper, el('div', 'hd', (receipt.branch ? (receipt.branch === 'HEAD' ? 'detached HEAD' : receipt.branch) + ' · ' : '') + receipt.cwd));
    add(paper, el('div', 'hd',
      fmtWhen(receipt.startedAt) + ' → ' + fmtWhen(receipt.endedAt) + (card.title ? ' · ' + card.title : '')));
    add(paper, el('div', 'rule'));
    var vwrap = el('div');
    add(vwrap, pillFor(receipt.verdict));
    var c = receipt.counts || {};
    add(vwrap, el('span', 'hd',
      ' ✓ ' + (c.VERIFIED || 0) + ' · ✗ ' + (c.CONTRADICTED || 0) + ' · ? ' + (c.UNVERIFIED || 0) + ' · ~ ' + (c.NOT_SCORED || 0)));
    add(paper, vwrap);
    add(paper, turnTabs(receipt));
    add(paper, el('div', 'rule'));
    add(paper, claimLines(receipt, card.shortId));
    var i;
    if ((receipt.alsoSaid || []).length > 0) {
      add(paper, el('div', 'hd', 'ALSO SAID'));
      for (i = 0; i < receipt.alsoSaid.length; i++) add(paper, el('div', null, '~ ' + receipt.alsoSaid[i]));
    }
    if ((receipt.alsoDid || []).length > 0) {
      add(paper, el('div', 'hd', 'ALSO DID'));
      for (i = 0; i < receipt.alsoDid.length; i++) {
        var d = receipt.alsoDid[i];
        add(paper, el('div', d.warn ? 'glyph-unk' : null, (d.warn ? '⚠ ' : '· ') + d.text));
      }
    }
    /* Section 11.2 item 6: post-final activity, capped like the terminal (3 + aggregate). */
    var pfs = receipt.postFinal || [];
    var pfNote = function (who, calls, tail) {
      add(paper, el('div', null, '· after this message: ' + who + ' ran ' + calls + ' tool calls ' + tail + '— not evidence for the claims above'));
    };
    for (i = 0; i < pfs.length && i < 3; i++) {
      pfNote(pfs[i].agentId == null ? 'the main agent' : 'agent ' + pfs[i].agentId, pfs[i].toolCalls, '(' + pfs[i].files + ' files, ' + pfs[i].testRuns + ' test runs) ');
    }
    if (pfs.length > 3) {
      for (var pfCalls = 0, j = 3; j < pfs.length; j++) pfCalls += pfs[j].toolCalls;
      pfNote(pfs.length - 3 + ' more agents', pfCalls, '');
    }
    add(paper, el('div', 'rule'));
    var st = receipt.stats || {};
    add(paper, el('div', 'hd',
      st.toolCalls + ' tool calls · ' + st.filesChanged + ' files changed · ' + st.testRuns + ' test runs · ' + st.apiCalls + ' api calls'));
    var rc = receipt.cost;
    add(paper, el('div', 'hd', receipt.source === 'ledger' ? 'cost n/a (hook-captured)' : 'cost ' + fmtUsd(rc ? rc.usd : null, rc && rc.unverified) + ' (API-equivalent)'));
    add(main, paper);
    if (receipt.finalText) {
      var det = el('details', 'acc');
      add(det, el('summary', null, 'final message'));
      var body = el('div');
      add(body, el('pre', 'final', receipt.finalText));
      add(det, body);
      add(main, det);
    }
    add(main, timelineView(card, receipt));
    add(main, diagnostics());
  }

  // ---- timeline ----
  function colIndex(tl) {
    var col = {};
    for (var i = 0; i < tl.cols.length; i++) col[tl.cols[i]] = i;
    return col;
  }

  function gapTotal(tl, col) {
    var total = 0;
    for (var i = 0; i < tl.rows.length; i++) {
      var flags = tl.rows[i][col.flags] || [];
      if (flags.indexOf('gap') === -1) continue;
      var m = /^\+(\d+) hidden$/.exec(String(tl.rows[i][col.summary] || ''));
      if (m) total += Number(m[1]);
    }
    return total;
  }

  function bandRow(text) {
    var tr = el('tr', 'bandrow');
    var td = el('td', null, text);
    td.colSpan = 6;
    add(tr, td);
    return tr;
  }

  function timelineView(card, receipt) {
    var wrap = el('section');
    add(wrap, el('div', 'hd', 'EVIDENCE TIMELINE'));
    var tl = P.timelines[keyOf(card)];
    if (!tl || !tl.rows || tl.rows.length === 0) {
      add(wrap, el('p', 'status', 'timeline not embedded for this session (rerun report with --full)'));
      return wrap;
    }
    var col = colIndex(tl);
    var tf = route.tf || 'all';
    var chips = el('div', 'filters');
    var kinds = ['all', 'test', 'check', 'git', 'write', 'danger', 'error'];
    for (var i = 0; i < kinds.length; i++) {
      var chip = el('button', null, kinds[i]);
      chip.type = 'button';
      attr(chip, 'aria-pressed', kinds[i] === tf ? 'true' : 'false');
      chip.addEventListener('click', (function (f) {
        return function () { go({ tf: f === 'all' ? null : f }); };
      })(kinds[i]));
      add(chips, chip);
    }
    add(wrap, chips);

    var contra = contraSeqs(receipt);
    var scroll = el('div', 'gridwrap');
    var table = el('table', 'grid');
    attr(table, 'role', 'grid');
    attr(table, 'aria-label', 'evidence timeline');
    var thead = el('thead');
    var hr = el('tr');
    var heads = ['t', 'tool', 'summary', 'exit', 'usd', 'flags'];
    for (var h = 0; h < heads.length; h++) {
      var th = el('th', null, heads[h]);
      attr(th, 'scope', 'col');
      add(hr, th);
    }
    add(thead, hr);
    add(table, thead);
    var tbody = el('tbody');

    var lastGreen = -1;
    for (var g = 0; g < tl.rows.length; g++) {
      var gr = tl.rows[g];
      var gf = gr[col.flags] || [];
      if (gf.indexOf('test') !== -1 && gr[col.exit] === 0) lastGreen = g;
    }

    var focusRow = null;
    var indexed = [];
    for (var n = 0; n < tl.rows.length; n++) indexed.push(n);
    chunked(indexed, function (idx) {
      var row = tl.rows[idx];
      var flags = row[col.flags] || [];
      if (flags.indexOf('gap') !== -1) {
        add(tbody, bandRow(row[col.summary] || 'rows hidden'));
        return;
      }
      if (tf !== 'all' && flags.indexOf(tf) === -1) { if (idx === lastGreen) add(tbody, bandRow('· after last green run ·')); return; }
      var seq = row[col.seq];
      var tr = el('tr');
      tr.tabIndex = -1;
      attr(tr, 'id', 'r' + seq);
      var cls = '';
      if (contra[seq]) cls = cls + ' contra';
      if (lastGreen !== -1 && idx > lastGreen) cls = cls + ' stale';
      if (String(seq) === route.seq) cls = cls + ' hl';
      if (cls !== '') tr.className = cls.slice(1);
      add(tr, el('td', 'mono', fmtOffset(row[col.ms])));
      add(tr, el('td', null, (row[col.agent] ? row[col.agent] + ' · ' : '') + row[col.tool]));
      var sum = el('td');
      var url = row[col.kind] === 'fetch' ? safeUrl(row[col.summary]) : null;
      if (url) add(sum, extLink(url, row[col.summary]));
      else sum.textContent = row[col.summary] === null || row[col.summary] === undefined ? '' : row[col.summary];
      add(tr, sum);
      add(tr, el('td', 'mono', row[col.exit] === null || row[col.exit] === undefined ? '' : row[col.exit]));
      add(tr, el('td', 'mono', row[col.usd] === null || row[col.usd] === undefined ? '' : fmtUsd(row[col.usd])));
      var fl = el('td');
      for (var f2 = 0; f2 < flags.length; f2++) add(fl, el('span', 'flag flag-' + flags[f2], flags[f2]));
      add(tr, fl);
      if (String(seq) === route.seq) focusRow = tr;
      add(tbody, tr);
      if (idx === lastGreen) add(tbody, bandRow('· after last green run ·'));
    }, function () {
      var target = focusRow || tbody.querySelector('tr[id]');
      if (target) target.tabIndex = 0;
      if (focusRow) {
        focusRow.focus();
        focusRow.scrollIntoView({ block: 'center' });
        announce('timeline row seq ' + route.seq);
      }
    });
    add(table, tbody);
    add(scroll, table);
    add(wrap, scroll);
    var hidden = gapTotal(tl, col);
    if (hidden > 0) add(wrap, el('p', 'status', hidden + ' timeline rows hidden by the size budget'));
    return wrap;
  }

  // ---- diagnostics + footer ----
  function diagnostics() {
    var det = el('details', 'acc');
    add(det, el('summary', null, 'diagnostics'));
    var body = el('div');
    var m = P.meta;
    add(body, el('div', null, 'showreceipts ' + m.toolVersion + ' · rules ' + m.rulesVersion + ' · prices ' + m.pricesVersion));
    add(body, el('div', null, 'generated ' + fmtWhen(m.generatedAt) + ' · paths ' + (m.hashPaths ? 'hashed' : 'in clear')));
    add(body, el('div', null,
      P.sessions.length + ' sessions · ' + Object.keys(P.receipts).length + ' receipts · '
      + Object.keys(P.timelines).length + ' timelines embedded'));
    var hidden = 0;
    var tkeys = Object.keys(P.timelines);
    for (var i = 0; i < tkeys.length; i++) {
      var tl = P.timelines[tkeys[i]];
      hidden += gapTotal(tl, colIndex(tl));
    }
    if (hidden > 0) add(body, el('div', null, hidden + ' timeline rows hidden by the 16 MB size budget'));
    add(det, body);
    return det;
  }

  function footer() {
    return el('footer', null,
      'showreceipts ' + P.meta.toolVersion + ' · every verdict is derived from the session log alone · this report never contacts the network. '
      + 'This file contains paths and claim text from your sessions; use --hash-paths before sharing it.');
  }

  // ---- help overlay ----
  var SHORTCUTS = [
    ['j / k', 'next / previous row (arrows too)'],
    ['Enter / o', 'open the selected session'],
    ['/', 'jump to the session search'],
    ['[ / ]', 'previous / next contradicted row'],
    ['e', 'jump to the evidence timeline'],
    ['t', 'cycle the theme'],
    ['h', 'toggle hashed paths (with --hash-paths=both)'],
    ['Esc', 'back to all sessions'],
    ['?', 'toggle this sheet']
  ];
  function toggleHelp() {
    if (helpEl) {
      helpEl.remove();
      helpEl = null;
      announce('help closed');
      return;
    }
    helpEl = el('div', 'help');
    attr(helpEl, 'role', 'dialog');
    attr(helpEl, 'aria-label', 'keyboard shortcuts');
    add(helpEl, el('h2', null, 'keyboard shortcuts'));
    var dl = el('dl');
    for (var i = 0; i < SHORTCUTS.length; i++) {
      add(dl, el('dt', null, SHORTCUTS[i][0]));
      add(dl, el('dd', null, SHORTCUTS[i][1]));
    }
    add(helpEl, dl);
    /* Section 11.4 / WCAG 2.1.4: the on/off switch lives in this sheet. */
    var sw = el('button', null, 'shortcuts: ' + (keysOn ? 'on' : 'off'));
    sw.type = 'button';
    attr(sw, 'aria-pressed', keysOn ? 'true' : 'false');
    sw.addEventListener('click', function () {
      keysOn = !keysOn;
      lsSet('showreceipts.keys', keysOn ? 'on' : 'off');
      sw.textContent = 'shortcuts: ' + (keysOn ? 'on' : 'off');
      attr(sw, 'aria-pressed', keysOn ? 'true' : 'false');
      announce('keyboard shortcuts ' + (keysOn ? 'on' : 'off'));
    });
    add(helpEl, sw);
    document.body.appendChild(helpEl);
    announce('help open');
  }

  // ---- keyboard ----
  function moveRow(delta) {
    var sel = route.s ? 'table.grid tbody tr[id]' : '[role="option"]';
    var rows = app.querySelectorAll(sel);
    if (rows.length === 0) return;
    var idx = -1;
    for (var i = 0; i < rows.length; i++) {
      if (rows[i] === document.activeElement || (idx === -1 && rows[i].tabIndex === 0)) idx = i;
    }
    var next = Math.max(0, Math.min(rows.length - 1, idx + delta));
    for (var j = 0; j < rows.length; j++) rows[j].tabIndex = j === next ? 0 : -1;
    if (!route.s) {
      for (var k = 0; k < rows.length; k++) attr(rows[k], 'aria-selected', k === next ? 'true' : 'false');
      listState.active = next;
    }
    rows[next].focus();
  }

  /* [ / ]: previous/next contradicted timeline row (or session card). */
  function moveContra(delta) {
    var rows = [];
    var i;
    if (route.s) {
      var trs = app.querySelectorAll('table.grid tr.contra');
      for (i = 0; i < trs.length; i++) rows.push(trs[i]);
    } else {
      var cards = app.querySelectorAll('[role="option"]');
      for (i = 0; i < cards.length; i++) if (cards[i].querySelector('.pill-bad')) rows.push(cards[i]);
    }
    if (rows.length === 0) { announce('no contradicted rows'); return; }
    var at = rows.indexOf(document.activeElement);
    var next = at === -1 ? (delta > 0 ? 0 : rows.length - 1) : Math.max(0, Math.min(rows.length - 1, at + delta));
    rows[next].tabIndex = 0;
    rows[next].focus();
    rows[next].scrollIntoView({ block: 'center' });
    announce('contradicted row ' + (next + 1) + ' of ' + rows.length);
  }

  function focusSearch() {
    var box = app.querySelector('input[type="search"]');
    if (box) { box.focus(); box.select(); return; }
    go({ s: null, seq: null });
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        var late = app.querySelector('input[type="search"]');
        if (late) late.focus();
      });
    });
  }

  function focusTimeline() {
    var row = app.querySelector('table.grid tbody tr[tabindex="0"]') || app.querySelector('table.grid tbody tr[id]');
    if (!row) { announce('no timeline on this view'); return; }
    row.tabIndex = 0;
    row.focus();
    row.scrollIntoView({ block: 'center' });
  }

  function openActive() {
    var active = app.querySelector('[role="option"][aria-selected="true"]');
    var sid = active && active.getAttribute('data-sid');
    if (sid) go({ s: sid, seq: null });
  }

  document.addEventListener('keydown', function (e) {
    /* 11.4 guards: no browser/OS chords, never while typing in a control. */
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    var tag = e.target && e.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if (e.target && e.target.isContentEditable) return;
    /* Esc still closes the sheet: a dialog escape, not a WCAG 2.1.4 key. */
    if (e.key === 'Escape' && helpEl) { toggleHelp(); return; }
    /* The sheet's switch silences every shortcut, ? included. */
    if (!keysOn) return;
    if (e.key === '?') { toggleHelp(); e.preventDefault(); return; }
    if (e.key === 'Escape') { if (route.s) go({ s: null, seq: null }); return; }
    if (e.key === 'j' || e.key === 'ArrowDown') { moveRow(1); e.preventDefault(); return; }
    if (e.key === 'k' || e.key === 'ArrowUp') { moveRow(-1); e.preventDefault(); return; }
    if (e.key === '[' || e.key === ']') { moveContra(e.key === ']' ? 1 : -1); e.preventDefault(); return; }
    if (e.key === 't') { cycleTheme(); return; }
    if (e.key === 'h') { toggleHashPaths(); return; }
    if (e.key === '/') { focusSearch(); e.preventDefault(); return; }
    if (e.key === 'e') { focusTimeline(); return; }
    if ((e.key === 'Enter' || e.key === 'o') && !route.s) { openActive(); e.preventDefault(); }
  });

  // ---- render ----
  function render() {
    route = parseRoute();
    P = payloadFor(route.hp === '1') || DATA.payload;
    if (headerEl) headerEl.remove();
    if (mainEl) mainEl.remove();
    headerEl = buildHeader();
    app.insertBefore(headerEl, app.firstChild);
    mainEl = el('main', 'wrap');
    var card = route.s ? cardByShort(route.s) : null;
    if (card) {
      receiptView(mainEl, card);
      announce('receipt for session ' + card.shortId);
    } else {
      if (route.s) announce('session ' + route.s + ' not found');
      overview(mainEl);
    }
    add(mainEl, footer());
    app.appendChild(mainEl);
  }

  if (app && DATA.payload) {
    statusEl = el('div', 'vh');
    attr(statusEl, 'role', 'status');
    attr(statusEl, 'aria-live', 'polite');
    app.appendChild(statusEl);
    window.addEventListener('hashchange', render);
    render();
  }
})();
