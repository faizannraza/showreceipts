/**
 * The HTML report's stylesheet (ARCHITECTURE §11.3, S22): design tokens —
 * the light palette on bare `:root`, the dark palette under BOTH the
 * `prefers-color-scheme: dark` media query (guarded so an explicit
 * `data-theme="light"` wins) and `[data-theme="dark"]` (so the toggle wins
 * in both directions) — plus the thermal-paper receipt card, verdict pills,
 * the session listbox, the timeline grid table, band rows, `:focus-visible`
 * rings and `prefers-reduced-motion`.
 *
 * Every colour lives in {@link LIGHT}/{@link DARK} so the contrast test can
 * compute WCAG ratios over the exact values the stylesheet uses. No `url()`,
 * no `@import`, no external resources — the report is one self-contained
 * file behind a hash-locked CSP.
 */

/** One theme's design tokens (CSS custom property name → colour). */
export type Palette = Readonly<Record<string, string>>;

/** Light palette (WCAG: ink/muted/accent ≥ 4.5:1 on bg/card/paper; ok/bad/unk/focus ≥ 3:1). */
export const LIGHT: Palette = {
  bg: '#f2efe9',
  card: '#ffffff',
  paper: '#fdfbf5',
  ink: '#1c1b18',
  muted: '#5b564d',
  line: '#d9d3c7',
  accent: '#0b57d0',
  ok: '#116329',
  bad: '#a40e26',
  unk: '#7a5900',
  focus: '#0b57d0',
  pillInk: '#ffffff',
  band: '#e9e3d6',
  sel: '#e3ecfa',
};

/** Dark palette (same contrast guarantees against the dark surfaces). */
export const DARK: Palette = {
  bg: '#16181c',
  card: '#1e2126',
  paper: '#1b1e23',
  ink: '#e9e7e2',
  muted: '#a6a29a',
  line: '#343941',
  accent: '#8ab4f8',
  ok: '#69cd84',
  bad: '#f2848f',
  unk: '#e0b95a',
  focus: '#8ab4f8',
  pillInk: '#101317',
  band: '#232830',
  sel: '#253248',
};

/** `--name: value;` lines for one palette. */
function tokens(palette: Palette): string {
  return Object.entries(palette)
    .map(([name, value]) => `--${name}:${value};`)
    .join('');
}

/**
 * The full report stylesheet. Deterministic (a pure function of the two
 * palettes), so the CSP style hash is stable for one build.
 */
export function buildCss(): string {
  return `:root{${tokens(LIGHT)}color-scheme:light dark;}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){${tokens(DARK)}}}
:root[data-theme="dark"]{${tokens(DARK)}}
*{box-sizing:border-box;}
body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;}
code,pre,.mono,.receipt{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;}
.vh{position:absolute;width:1px;height:1px;margin:-1px;padding:0;border:0;clip-path:inset(50%);overflow:hidden;white-space:nowrap;}
a{color:var(--accent);}
button,select,input{font:inherit;color:var(--ink);background:var(--card);border:1px solid var(--line);border-radius:6px;padding:4px 10px;}
button,select{cursor:pointer;}
button[disabled]{opacity:.5;cursor:default;}
:focus-visible{outline:2px solid var(--focus);outline-offset:2px;}
.wrap{max-width:1080px;margin:0 auto;padding:16px;}
.hdr{display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:12px 16px;border-bottom:1px solid var(--line);background:var(--card);position:sticky;top:0;z-index:3;}
.hdr h1{font-size:16px;margin:0 8px 0 0;}
.hdr .meta{color:var(--muted);font-size:12px;}
.hdr .spacer{flex:1;}
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:10px;margin:16px 0;}
.kpi{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:10px 12px;}
.kpi .who{font-weight:600;}
.kpi .ver{color:var(--muted);font-size:12px;}
.kpi dl{display:grid;grid-template-columns:auto auto;gap:2px 12px;margin:8px 0 0;font-size:12px;}
.kpi dt{color:var(--muted);}
.kpi dd{margin:0;text-align:right;font-variant-numeric:tabular-nums;}
.pill{display:inline-block;border-radius:99px;padding:1px 8px;font-size:11px;font-weight:600;}
.pill-ok{background:var(--ok);color:var(--pillInk);}
.pill-bad{background:var(--bad);color:var(--pillInk);}
.pill-unk{background:var(--unk);color:var(--pillInk);}
.pill-none{background:var(--band);color:var(--ink);}
.glyph-ok{color:var(--ok);font-weight:700;}
.glyph-bad{color:var(--bad);font-weight:700;}
.glyph-unk{color:var(--unk);font-weight:700;}
.glyph-said{color:var(--muted);font-weight:700;}
.filters{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:12px 0;}
.filters label{color:var(--muted);font-size:12px;}
.listbox{list-style:none;margin:0;padding:0;border:1px solid var(--line);border-radius:8px;background:var(--card);overflow:hidden;}
.opt{display:flex;flex-wrap:wrap;gap:6px 10px;align-items:center;padding:8px 12px;border-top:1px solid var(--line);cursor:pointer;}
.opt:first-child{border-top:0;}
.opt[aria-selected="true"]{background:var(--sel);}
.opt .who{font-weight:600;}
.opt .sub{color:var(--muted);font-size:12px;flex-basis:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.opt .cost{margin-left:auto;font-variant-numeric:tabular-nums;}
.more{margin:10px 0;}
.receipt{background:var(--paper);border:1px solid var(--line);border-radius:2px;padding:16px 18px;margin:14px 0;box-shadow:0 1px 3px rgba(0,0,0,.12);font-size:13px;}
.receipt h2{font-size:14px;margin:0 0 4px;letter-spacing:.06em;}
.receipt .rule{border-top:1px dashed var(--line);margin:10px 0;}
.receipt .hd{color:var(--muted);font-size:12px;}
.claim{display:block;width:100%;text-align:left;background:none;border:0;border-radius:4px;padding:4px 6px;font:inherit;color:inherit;}
.claim:hover{background:var(--band);}
.refs{margin:2px 0 8px 26px;padding:6px 10px;border-left:2px solid var(--line);color:var(--muted);font-size:12px;}
.refs a{display:inline-block;margin-right:8px;}
.tabs{display:flex;gap:6px;margin:10px 0;}
.tabs [role="tab"][aria-selected="true"]{border-color:var(--focus);font-weight:600;}
.gridwrap{overflow:auto;max-height:480px;border:1px solid var(--line);border-radius:8px;background:var(--card);}
table.grid{border-collapse:collapse;width:100%;font-size:12px;}
table.grid th{position:sticky;top:0;background:var(--card);text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);z-index:1;}
table.grid td{padding:4px 8px;border-top:1px solid var(--line);vertical-align:top;font-variant-numeric:tabular-nums;}
table.grid tr.contra td{background:var(--sel);border-left:3px solid var(--bad);}
table.grid tr.hl td{outline:2px solid var(--focus);outline-offset:-2px;}
table.grid tr[tabindex]{cursor:pointer;}
tr.bandrow td{background:var(--band);color:var(--muted);text-align:center;font-style:italic;padding:3px 8px;}
.flag{display:inline-block;border:1px solid var(--line);border-radius:4px;padding:0 5px;margin-right:4px;font-size:11px;color:var(--muted);}
.flag-test{color:var(--ok);border-color:var(--ok);}
.flag-danger,.flag-error{color:var(--bad);border-color:var(--bad);}
details.acc{border:1px solid var(--line);border-radius:8px;background:var(--card);margin:14px 0;}
details.acc>summary{padding:8px 12px;cursor:pointer;font-weight:600;}
details.acc>div{padding:0 12px 10px;color:var(--muted);font-size:12px;}
.final{white-space:pre-wrap;overflow-wrap:anywhere;background:var(--band);border-radius:6px;padding:10px;max-height:320px;overflow:auto;}
.help{position:fixed;inset:auto 16px 16px auto;max-width:320px;background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px 16px;box-shadow:0 4px 18px rgba(0,0,0,.25);z-index:9;}
.help h2{margin:0 0 8px;font-size:14px;}
.help dl{display:grid;grid-template-columns:auto 1fr;gap:4px 12px;margin:0;font-size:12px;}
.help dt{font-family:ui-monospace,Menlo,monospace;color:var(--muted);}
.help dd{margin:0;}
.status{color:var(--muted);font-size:12px;margin:6px 0;}
footer{color:var(--muted);font-size:12px;margin:24px 0 8px;border-top:1px solid var(--line);padding-top:10px;}
@media (prefers-reduced-motion: reduce){*,*::before,*::after{animation:none !important;transition:none !important;scroll-behavior:auto !important;}}
`;
}
