import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { DEFAULT_THEME, THEME_SCRIPT, THEME_SWITCH, THEMES, themeStyles } from './ui-theme.js';

interface El {
	dataset: Record<string, string>;
	media?: string;
	attrs?: Record<string, string>;
	setAttribute?: (k: string, v: string) => void;
	onclick?: () => void;
}

// Runs the head script over stand-in style and button elements, with what local storage holds.
function run(kept: string | null) {
	const store = new Map<string, string>(kept === null ? [] : [['nightjar-theme', kept]]);
	const button = (theme: string): El => {
		const el: El = { dataset: { theme }, attrs: {} };
		el.setAttribute = (k, v) => {
			if (el.attrs) el.attrs[k] = v;
		};
		return el;
	};
	const styles: El[] = THEMES.map((t) => ({ dataset: { theme: t }, media: '' }));
	const buttons = THEMES.map(button);
	const root = { dataset: {} as Record<string, string> };
	let ready = () => {};
	runInNewContext(THEME_SCRIPT, {
		document: {
			documentElement: root,
			querySelectorAll: (sel: string) => (sel.startsWith('style') ? styles : buttons)
		},
		localStorage: {
			getItem: (k: string) => store.get(k) ?? null,
			setItem: (k: string, v: string) => store.set(k, v)
		},
		addEventListener: (_: string, f: () => void) => {
			ready = f;
		}
	});
	const on = () => styles.filter((s) => s.media === 'all').map((s) => s.dataset.theme);
	return { root, styles, buttons, store, ready: () => ready(), on };
}

describe('the page themes', () => {
	it('makes Paper the default and switches only the other stylesheets off', () => {
		expect(DEFAULT_THEME).toBe('paper');
		const html = themeStyles({ paper: 'p{}', nightjar: 'n{}' });
		expect(html).toContain('<style data-theme="paper">p{}</style>');
		expect(html).toContain('<style data-theme="nightjar" media="not all">n{}</style>');
	});

	it('offers one pressed button per theme in the bar', () => {
		expect(THEME_SWITCH).toContain('aria-label="Theme"');
		for (const t of THEMES) expect(THEME_SWITCH).toContain(`data-theme="${t}"`);
	});

	it('shows Paper when nothing, or something unknown, is kept', () => {
		for (const kept of [null, 'neon']) {
			const page = run(kept);
			expect(page.root.dataset.theme).toBe('paper');
			expect(page.on()).toEqual(['paper']);
		}
	});

	it('shows the kept theme before the body is drawn', () => {
		const page = run('nightjar');
		expect(page.root.dataset.theme).toBe('nightjar');
		expect(page.on()).toEqual(['nightjar']);
	});

	it('switches and keeps the theme a person picks', () => {
		const page = run(null);
		page.ready();
		expect(page.buttons[0]?.attrs?.['aria-pressed']).toBe('true');
		page.buttons.find((b) => b.dataset.theme === 'nightjar')?.onclick?.();
		expect(page.on()).toEqual(['nightjar']);
		expect(page.store.get('nightjar-theme')).toBe('nightjar');
		expect(page.buttons.find((b) => b.dataset.theme === 'nightjar')?.attrs?.['aria-pressed']).toBe(
			'true'
		);
	});
});
