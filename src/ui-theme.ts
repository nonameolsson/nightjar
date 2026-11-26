// The page's themes. Paper, the default, is a light list on warm paper greys that follows the machine's light or dark scheme;
// Nightjar is the night-shift HUD in `ui.ts`. Each is a whole stylesheet of its own, so neither bends to fit the other,
// and the page turns the one not chosen off with `media="not all"`. The choice is the person's own, kept in local storage.

export const THEMES = ['paper', 'nightjar'] as const;
export type Theme = (typeof THEMES)[number];
export const DEFAULT_THEME: Theme = 'paper';

const NAMES: Record<Theme, string> = { paper: 'Paper', nightjar: 'Nightjar' };

// The bar's switch: one button per theme, pressed for the one shown.
export const THEME_SWITCH = `<nav id="themes" aria-label="Theme">${THEMES.map(
	(t) => `<button type="button" data-theme="${t}">${NAMES[t]}</button>`
).join('')}</nav>`;

// Each theme's stylesheet, the default one on and the others off until the head script reads the person's choice.
export const themeStyles = (styles: Record<Theme, string>): string =>
	THEMES.map(
		(t) =>
			`<style data-theme="${t}"${t === DEFAULT_THEME ? '' : ' media="not all"'}>${styles[t]}</style>`
	).join('\n');

// Runs in the head, after the stylesheets and before the body is drawn, so a kept choice shows without a flash of the default.
// Its own script element with an id, so it is never the page's first bare <script>.
export const THEME_SCRIPT = `(() => {
const THEMES = ${JSON.stringify(THEMES)};
let theme = null;
try { theme = localStorage.getItem('nightjar-theme'); } catch {}
if (!THEMES.includes(theme)) theme = ${JSON.stringify(DEFAULT_THEME)};
const apply = () => {
	document.documentElement.dataset.theme = theme;
	for (const s of document.querySelectorAll('style[data-theme]')) s.media = s.dataset.theme === theme ? 'all' : 'not all';
	for (const b of document.querySelectorAll('button[data-theme]')) {
		b.dataset.on = String(b.dataset.theme === theme);
		b.setAttribute('aria-pressed', b.dataset.on);
	}
};
apply();
addEventListener('DOMContentLoaded', () => {
	apply();
	for (const b of document.querySelectorAll('button[data-theme]')) {
		b.onclick = () => {
			theme = b.dataset.theme;
			try { localStorage.setItem('nightjar-theme', theme); } catch {}
			apply();
		};
	}
});
})();`;

// Paper: one line per Feature, a 13px platform face with tabular figures, warm paper greys and one hairline for every rule.
// Hue lives in small objects (a status icon, a group's dot, a state's words), never in a field; one blue for focus and selection.
// Every colour is a token on :root, light first and dark second, so a line outside :root holds no literal.
export const PAPER_STYLE = `
:root { color-scheme: light; --bg: #ffffff; --surface-2: #f7f7f5; --surface-3: #efeeec; --ink: #37352f; --muted: #66655f; --line: #e9e9e7; --accent: #1d76cf; --built: #1d7f52; --fault: #c93a3f; --ask: #956a0a; --pending: #a3a29e; --blue: #337ea9; --blue-ink: #306e92; --purple: #9065b0; --gray: #787774; --on-fill: #ffffff; --tint: 8%; --scrim: rgba(15, 15, 15, 0.25); --shadow-pop: 0 0 0 1px rgba(15, 15, 15, 0.05), 0 3px 6px rgba(15, 15, 15, 0.1), 0 9px 24px rgba(15, 15, 15, 0.2); --sans: ui-sans-serif, -apple-system, BlinkMacSystemFont, 'Segoe UI Variable Text', 'Segoe UI', Helvetica, Arial, sans-serif; --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
@media (prefers-color-scheme: dark) {
:root { color-scheme: dark; --bg: #191919; --surface-2: #202020; --surface-3: #2c2c2c; --ink: #d4d4d2; --muted: #a3a3a1; --line: #2f2f2f; --accent: #2a7fd8; --built: #4cc38a; --fault: #ff6369; --ask: #e2b93d; --pending: #5f5e5b; --blue: #5e9fd1; --blue-ink: #71abd7; --purple: #9d68d3; --gray: #9b9b9b; --on-fill: #191919; --tint: 12%; --scrim: rgba(0, 0, 0, 0.5); --shadow-pop: 0 0 0 1px rgba(255, 255, 255, 0.07), 0 3px 6px rgba(0, 0, 0, 0.3), 0 9px 24px rgba(0, 0, 0, 0.45); }
}
:root { --ask-bg: color-mix(in oklab, var(--ask) var(--tint), transparent); --accent-bg: color-mix(in oklab, var(--accent) 20%, transparent); }
* { box-sizing: border-box; }
body { background-color: var(--bg); color: var(--ink); font: 13px/1.4 var(--sans); font-feature-settings: 'tnum' 1; margin: 0; display: flex; flex-direction: column; height: 100vh; height: 100dvh; overflow: hidden; --gut: max(24px, calc((100% - 1380px) / 2 + 24px)); }
::selection { background: var(--accent-bg); }
a { color: inherit; text-underline-offset: 2px; }
a:focus-visible, button:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.banner { display: none; }
.bar { align-items: center; background: var(--bg); border-bottom: 1px solid var(--line); display: flex; flex: none; gap: 4px; min-height: 40px; padding: 6px var(--gut); }
#top { background: var(--bg); border-bottom: 1px solid var(--line); flex: none; padding: 0 var(--gut); }
#scroll { flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain; }
#scroll:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
.elsewhere { display: flex; flex-wrap: wrap; gap: 6px; margin-left: auto; }
.mark { font-size: 13px; font-weight: 600; margin: 0 16px 0 0; }
#views, #themes { display: flex; gap: 2px; }
#themes { border-left: 1px solid var(--line); margin-left: 8px; padding-left: 8px; }
#views button { background: none; border: 0; border-radius: 6px; color: var(--muted); cursor: pointer; font: inherit; min-height: 24px; height: 28px; padding: 0 10px; }
#themes button { background: none; border: 0; border-radius: 6px; color: var(--muted); cursor: pointer; font: inherit; font-size: 12.5px; min-height: 24px; height: 28px; padding: 0 10px; }
#views button:hover, #themes button:hover { background: var(--surface-2); color: var(--ink); }
#views button[data-on="true"], #themes button[data-on="true"] { background: var(--surface-3); color: var(--ink); font-weight: 500; }
#panels { margin: 0 auto; max-width: 1380px; min-width: 0; padding: 16px 24px 48px; }
h1, h2 { font-size: 1em; margin: 0; }
header { align-items: baseline; display: flex; flex-wrap: wrap; gap: 4px 12px; padding: 12px 0 2px; }
h1 { font-size: 16px; font-weight: 600; }
header span { color: var(--muted); font-size: 12px; }
header .state { background: var(--surface-3); border-radius: 9999px; color: var(--ink); font-size: 11.5px; font-weight: 500; padding: 1px 8px; }
header .stale { color: var(--ask); }
#cards, #measures .stats { color: var(--muted); display: flex; flex-wrap: wrap; font-size: 12px; gap: 4px 20px; margin: 0; padding: 2px 0 10px; }
.stat b { color: var(--ink); font-weight: 500; }
.empty, small, .meta { color: var(--muted); }
small { font-size: 12px; }
.empty { margin: 8px 0; }
ul, ol { list-style: none; margin: 4px 0; padding: 0; }
pre { background: var(--surface-2); border: 1px solid var(--line); border-radius: 6px; color: var(--muted); font: 12px/1.5 var(--mono); margin: 8px 0 0; max-height: 14rem; overflow: auto; padding: 8px 10px; white-space: pre-wrap; }
#panels[data-view="board"] :is(.overview, .table), #panels[data-view="table"] :is(.overview, .board), #panels[data-view="overview"] :is(.board, .table) { display: none; }
.egg, .slot:empty { border-radius: 50%; display: inline-block; flex: none; height: 14px; position: relative; vertical-align: middle; width: 14px; }
.egg { background: var(--built); }
.egg::after { border: solid var(--on-fill); border-width: 0 1.5px 1.5px 0; content: ""; height: 6px; left: 5px; position: absolute; top: 2.5px; transform: rotate(45deg); width: 3px; }
.egg.building { background: conic-gradient(var(--blue) 0 50%, transparent 0); border: 1.5px solid var(--blue); box-shadow: inset 0 0 0 1.5px var(--bg); }
.egg.need { background: var(--ask); }
.egg.need::before, .egg.need::after { background: var(--on-fill); border: 0; content: ""; left: 6px; position: absolute; transform: none; width: 2px; }
.egg.need::before { height: 5px; top: 3px; }
.egg.need::after { height: 2px; top: 9px; }
.egg.waiting, .slot:empty { background: none; border: 1.5px dashed var(--pending); }
.egg.building::after, .egg.waiting::after { content: none; }
.slot { display: inline-grid; place-items: center; }
.eggs { align-items: center; display: flex; flex-wrap: wrap; gap: 4px; }
.legend { color: var(--muted); display: flex; flex-wrap: wrap; font-size: 12px; gap: 6px 18px; margin: 0 0 12px; }
.legend span { align-items: center; display: inline-flex; gap: 6px; }
.cols { display: block; }
.cols.has-detail { align-items: start; display: grid; gap: 24px; grid-template-columns: minmax(0, 1fr) 340px; }
.left { min-width: 0; }
.head { background: var(--bg); color: var(--muted); display: grid; font-size: 11.5px; gap: 6px 20px; grid-template-columns: minmax(0, 1fr) 13rem 10.5rem 6.5rem; margin: 0 0 4px; padding: 4px 10px; position: sticky; top: 0; z-index: 2; }
.head span:last-child { text-align: right; white-space: nowrap; }
.mat { --h: var(--blue); margin-bottom: 12px; }
.mat[data-state="waiting"] { --h: var(--ask); }
.mat[data-state="queue"] { --h: var(--purple); }
.mat[data-state="shelf"] { --h: var(--gray); }
.mat[data-state="completed"] { --h: var(--built); }
.tab { align-items: center; background: var(--surface-2); border-radius: 6px; display: flex; gap: 8px; height: 32px; padding: 0 10px; }
.tab::before { background: var(--h); border-radius: 50%; content: ""; height: 8px; width: 8px; }
.tab h2 { font-size: 12px; font-weight: 500; }
.tally { color: var(--muted); font-size: 12px; font-style: normal; font-weight: 500; }
.lines { padding: 2px 0; }
.entry { align-items: center; border-radius: 6px; display: grid; gap: 4px 20px; grid-template-columns: minmax(0, 1fr) 13rem 10.5rem 6.5rem; min-height: 44px; overflow-wrap: anywhere; padding: 8px 10px; }
.entry:hover { background: var(--surface-2); }
.lines > .empty { padding: 8px 10px; }
.more { color: var(--muted); font-size: 12px; margin: 0; padding: 8px 10px; }
.table .more { padding: 10px 12px 0; }
.detail .more { display: flex; flex-wrap: wrap; gap: 4px 16px; }
.entry p { margin: 0; }
.who { font-size: 13.5px; font-weight: 500; }
.who b { color: var(--muted); display: inline-block; font-size: 12.5px; font-weight: 400; margin-right: 6px; min-width: 40px; }
.eggcell .meta { font-size: 12px; margin-top: 4px; }
.now .label { align-items: center; display: flex; font-size: 12.5px; font-weight: 500; }
.now .label .egg { margin-right: 6px; }
.now p:not(.label) { color: var(--muted); font-size: 12px; }
.clock { color: var(--muted); font-size: 12px; text-align: right; }
.entry > ul, .entry > .next { grid-column: 1 / -1; }
.next { color: var(--muted); font-size: 12.5px; margin: 2px 0 0; }
.next p { margin: 6px 0 2px; }
.next ol { list-style: decimal; margin: 0; padding-left: 1.6em; }
.next li { padding: 1px 0; }
.tickets .reason { color: var(--muted); font-size: 12.5px; }
.tickets .next { margin-left: 4px; }
.entry.waiting .now .label { color: var(--ask); }
.entry.building .now .label { color: var(--blue-ink); }
.entry.pulled .now .label { color: var(--built); }
.entry.failed .now .label, .entry.failed .now p { color: var(--fault); }
.tickets li { font-size: 12.5px; padding: 2px 0 2px 4px; }
.tickets li.waiting { color: var(--ask); }
.detail { background: var(--bg); border: 1px solid var(--line); border-radius: 8px; padding: 14px 16px; position: sticky; top: 16px; }
.dk { align-items: center; color: var(--muted); display: flex; font-size: 12px; font-weight: 500; gap: 8px; margin: 0; }
.dk i { animation: blip 2s ease-out infinite; background: var(--blue); border-radius: 50%; height: 8px; width: 8px; }
@keyframes blip { 0% { box-shadow: 0 0 0 0 color-mix(in oklab, var(--blue) 50%, transparent); } 100% { box-shadow: 0 0 0 7px transparent; } }
.detail h3 { font-size: 14px; font-weight: 600; margin: 8px 0 2px; overflow-wrap: anywhere; }
.detail h3 b { color: var(--muted); font-size: 12.5px; font-weight: 400; margin-right: 6px; }
.sub { color: var(--muted); font-size: 12px; margin: 0; }
.steps { margin: 12px 0; }
.steps li { padding: 4px 0 4px 22px; position: relative; }
.steps > li::before { border: 1.5px dashed var(--pending); border-radius: 50%; content: ""; height: 12px; left: 0; position: absolute; top: 6px; width: 12px; }
.steps li.built { color: var(--muted); }
.steps > li.built::before { background: var(--built); border: 1.5px solid var(--built); }
.steps li.building { font-weight: 500; }
.steps > li.building::before { background: conic-gradient(var(--blue) 0 50%, transparent 0); border: 1.5px solid var(--blue); box-shadow: inset 0 0 0 1.5px var(--bg); }
.steps li.waiting { color: var(--ask); }
.steps > li.waiting::before { background: var(--ask); border: 1.5px solid var(--ask); }
.meters { display: grid; gap: 8px; grid-template-columns: 1fr 1fr; margin-bottom: 12px; }
.meters div { background: var(--surface-2); border-radius: 6px; padding: 6px 10px; }
.meters small { display: block; font-size: 11.5px; }
.meters b { font-size: 13.5px; font-weight: 600; }
.chips { display: flex; flex-wrap: wrap; gap: 6px; margin: 4px 0 12px; }
.chips button { background: none; border: 1px solid var(--line); border-radius: 9999px; color: var(--muted); cursor: pointer; font: inherit; font-size: 12.5px; min-height: 24px; padding: 2px 12px; }
.chips button:hover { background: var(--surface-2); }
.chips button[data-on="true"] { background: var(--surface-3); border-color: var(--surface-3); color: var(--ink); font-weight: 500; }
.filters { align-items: center; display: flex; flex-wrap: wrap; gap: 0 20px; }
.chips-label { align-self: center; color: var(--muted); font-size: 12.5px; }
[data-shown] { font-size: 12.5px; margin: 0 0 8px; }
[data-shown]:empty { display: none; }
.week { display: flex; flex-wrap: wrap; gap: 6px 28px; margin: 4px 0; }
.week li { padding: 0; }
.week b { color: var(--ink); font-size: 16px; font-weight: 600; margin-right: 4px; }
a.count { align-items: center; color: var(--ink); display: inline-flex; min-height: 24px; text-decoration: none; }
a.count:hover { text-decoration: underline; }
.scroll { overflow-x: auto; }
.sr, .skip:not(:focus) { clip: rect(0 0 0 0); clip-path: inset(50%); height: 1px; overflow: hidden; position: absolute; white-space: nowrap; width: 1px; }
.skip { background: var(--bg); color: var(--accent); left: 8px; padding: 8px 12px; top: 8px; z-index: 4; }
td.progress .eggs { display: inline-flex; margin-bottom: 4px; vertical-align: middle; }
td.progress p { display: inline; margin: 0 0 0 10px; }
.scroll:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
tr[data-failed] td { color: var(--fault); }
table { border-collapse: collapse; width: 100%; }
th, td { border-bottom: 1px solid var(--line); padding: 10px 12px; text-align: left; vertical-align: top; }
tbody tr:hover { background: var(--surface-2); }
th button { align-items: center; background: none; border: 0; color: var(--muted); cursor: pointer; display: inline-flex; font: inherit; font-size: 11.5px; font-weight: 500; min-height: 24px; padding: 0; }
th button[data-on="true"] { color: var(--ink); }
th button[data-on="true"]::after { border: solid currentColor; border-width: 0 1.5px 1.5px 0; content: ""; display: inline-block; height: 0.4em; margin-left: 0.6em; transform: rotate(45deg) translateY(-0.2em); width: 0.4em; }
th button[data-dir="asc"]::after { transform: rotate(-135deg) translate(-0.1em, -0.1em); }
tr[hidden] { display: none; }
.overview section { border-top: 1px solid var(--line); margin-top: 20px; padding-top: 10px; }
.overview h2 { color: var(--muted); font-size: 12px; font-weight: 500; margin-bottom: 4px; }
.overview li { padding: 3px 0; }
a.ext { color: inherit; text-decoration: none; }
a.ext:hover { text-decoration: underline; }
a.act { align-items: center; border: 1px solid var(--line); border-radius: 6px; color: var(--ink); display: inline-flex; font-size: 12.5px; gap: 6px; min-height: 24px; height: 28px; padding: 0 10px; text-decoration: none; white-space: nowrap; }
a.act:hover { background: var(--surface-2); text-decoration: none; }
a.act::after { background: currentColor; color: var(--muted); content: ""; height: 12px; mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16' fill='none' stroke='black' stroke-width='1.6'%3E%3Cpath d='M6 3H3v10h10v-3M9 2h5v5M14 2 7 9'/%3E%3C/svg%3E") center / contain no-repeat; width: 12px; }
.clock a.act { margin-left: auto; }
button.why { align-items: center; flex-wrap: wrap; background: none; border: 0; color: inherit; cursor: pointer; display: inline-flex; font: inherit; padding: 2px 0; text-align: left; }
button.why span { color: var(--muted); flex-basis: 100%; font-weight: 400; padding: 2px 0 0 20px; text-decoration: underline dotted; text-underline-offset: 2px; white-space: nowrap; }
button.why[aria-expanded="true"] span { color: var(--ink); }
.entry > .help { background: var(--ask-bg); border-radius: 6px; font-size: 12.5px; grid-column: 1 / -1; max-width: 72ch; padding: 8px 12px; }
.help p { margin: 4px 0; }
.help p:last-child { color: var(--muted); }
.help ol { list-style: decimal; margin: 6px 0; padding-left: 1.3rem; }
.help li { padding: 2px 0; }
code { background: var(--surface-3); border-radius: 4px; font: 12px var(--mono); padding: 1px 4px; }
.hint { color: var(--muted); display: block; font-size: 12px; margin-top: 2px; }
button.copy { background: none; border: 1px solid var(--line); border-radius: 6px; color: var(--ink); cursor: pointer; font: inherit; font-size: 12px; margin-left: 4px; min-height: 24px; padding: 1px 8px; }
button.copy:hover { background: var(--surface-2); }
button.open { background: none; border: 0; color: inherit; cursor: pointer; font: inherit; min-height: 24px; padding: 0; text-align: left; }
button.open:hover { text-decoration: underline; text-underline-offset: 2px; }
a.open { align-items: center; display: inline-flex; min-height: 24px; }
a.book-link { color: var(--muted); font-size: 12px; font-weight: 400; margin-left: 8px; }
#feature { background: var(--bg); border: 0; border-left: 1px solid var(--line); box-shadow: var(--shadow-pop); color: var(--ink); height: 100%; inset: 0 0 0 auto; margin: 0; max-height: none; max-width: 100%; overflow-y: auto; overscroll-behavior: contain; padding: 0; width: 640px; }
#feature::backdrop { background: var(--scrim); }
.fp { min-height: 100%; padding: 14px 24px 32px; }
.fp-bar { align-items: center; display: flex; gap: 8px; justify-content: space-between; }
button.close { background: none; border: 1px solid var(--line); border-radius: 6px; color: var(--ink); cursor: pointer; font: inherit; font-size: 12.5px; min-height: 24px; height: 28px; padding: 0 10px; }
button.close:hover { background: var(--surface-2); }
#feature h2 { font-size: 16px; font-weight: 600; margin: 8px 0 4px; overflow-wrap: anywhere; }
#feature h2 b { color: var(--muted); font-size: 13px; font-weight: 400; margin-right: 6px; }
#feature .sub { margin: 0 0 6px; }
#feature section { border-top: 1px solid var(--line); margin-top: 16px; padding-top: 10px; }
#feature h3 { color: var(--muted); font-size: 12px; font-weight: 500; margin: 0 0 6px; }
#feature .fault { color: var(--fault); }
.md { overflow-wrap: anywhere; }
.md p { margin: 6px 0; }
#feature .md :is(h3, h4, h5, h6) { color: var(--ink); font-size: 13.5px; font-weight: 600; margin: 14px 0 4px; }
.md ul { list-style: disc; padding-left: 1.4em; }
.md ol { list-style: decimal; padding-left: 1.6em; }
.md li { padding: 1px 0; }
.md li.task { list-style: none; margin-left: -1.2em; }
.md input[type="checkbox"] { accent-color: var(--accent); margin: 0 6px 0 0; vertical-align: middle; }
.md blockquote { border-left: 2px solid var(--line); color: var(--muted); margin: 8px 0; padding-left: 12px; }
.md hr { border: 0; border-top: 1px solid var(--line); margin: 12px 0; }
#feature .steps { margin: 4px 0 0; }
#feature .steps li p { margin: 2px 0; }
#feature .steps li.closed { color: var(--muted); }
#feature .steps > li.closed::before { background: var(--built); border: 1.5px solid var(--built); }
.tk b { color: var(--muted); font-size: 12.5px; font-weight: 400; margin-right: 6px; }
.blockers { color: var(--muted); }
#feature .contract { font-size: 12px; margin: 6px 0; }
#feature .contract.ok, #feature .verdict.ok { color: var(--built); }
#feature .contract.bad, #feature .verdict.bad { color: var(--fault); }
#feature .verdict { font-size: 12px; }
#feature ul.faults { color: var(--fault); font-size: 12.5px; list-style: disc; margin: 2px 0 4px; padding-left: 1.4em; }
.criteria summary { color: var(--muted); cursor: pointer; font-size: 12px; min-height: 24px; padding: 2px 0; }
.criteria summary:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.cost summary { color: var(--muted); cursor: pointer; font-size: 12px; min-height: 24px; padding: 2px 0; }
.cost summary:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
td.cost summary { color: inherit; font-size: 13px; padding: 0; text-decoration: underline dotted var(--muted); text-underline-offset: 3px; }
.entry > .cost { grid-column: 1 / -1; }
.split { font-size: 12px; font-variant-numeric: tabular-nums; max-width: 40rem; padding: 2px 0; }
.split-head { color: var(--muted); font-size: 12px; font-weight: 500; margin: 8px 0 2px; }
.split dl { margin: 0; }
.split dl div { border-top: 1px solid var(--line); display: grid; gap: 2px 12px; grid-template-columns: minmax(0, 10rem) minmax(0, 1fr); padding: 3px 0; }
.split dt { overflow-wrap: anywhere; }
.split dd { margin: 0; overflow-wrap: anywhere; }
.split .empty { margin: 4px 0; }
.stepsbar { display: flex; gap: 2px; list-style: none; margin: 6px 0 0; padding: 0; }
.seg { border-radius: 2px; display: inline-block; flex: none; height: 8px; width: 18px; }
.seg.passed { background: var(--built); }
.seg.retried { background: repeating-linear-gradient(135deg, var(--built) 0 2px, transparent 2px 4px); border: 1px solid var(--built); }
.seg.failed { background: linear-gradient(90deg, var(--fault) 0 40%, transparent 40% 60%, var(--fault) 60%); }
.seg.running { background: linear-gradient(90deg, var(--blue) 0 50%, transparent 50%); border: 1px solid var(--blue); }
.seg.notReached { border: 1px dashed var(--pending); }
.seg.notNeeded { background: linear-gradient(var(--pending), var(--pending)) center / 100% 2px no-repeat; }
@media (prefers-reduced-motion: reduce) { .dk i { animation: none; } }
@media (min-width: 1261px) and (max-width: 1400px) {
	.cols.has-detail .entry { grid-template-columns: 1fr; }
	.cols.has-detail .head { display: none; }
}
@media (max-width: 1260px) {
	.cols.has-detail { grid-template-columns: 1fr; }
	.detail { order: -1; position: static; }
}
@media (pointer: coarse) {
	th button, #views button, #themes button, .chips button, button.copy, a.act, a.open, a.count, button.open, button.close, .criteria summary, .cost summary { min-height: 44px; }
	#views button, #themes button, .chips button { padding-inline: 14px; }
	.tab { height: 40px; }
}
@media (max-height: 480px), (max-width: 400px) {
	body { height: auto; overflow: visible; }
	#scroll { overflow: visible; }
}
@media (max-width: 900px) {
	.entry { grid-template-columns: 1fr; }
	.head { display: none; }
	.clock { text-align: left; }
}
@media (max-width: 760px) {
	body { --gut: 12px; }
	#cards, #measures .stats { gap: 2px 14px; }
	.mark { display: none; }
	.bar { flex-wrap: wrap; }
	#panels { padding: 12px 12px 40px; }
	.scroll table { min-width: 36rem; }
	.split dl div { grid-template-columns: 1fr; }
}
`;
