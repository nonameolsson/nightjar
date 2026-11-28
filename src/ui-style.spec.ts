import { describe, expect, it } from 'vitest';
import { STYLE } from './ui-style.js';

// The page-level checks (hit areas, the type ramp, Hue-Plus-Shape) read the stylesheet as served, in ui.spec.ts.
describe('the page stylesheet', () => {
	it('holds light tokens on :root and dark ones under the machine’s dark scheme, and nothing else decides', () => {
		expect(STYLE).toMatch(/^:root \{ color-scheme: light;/m);
		expect(STYLE).toContain('@media (prefers-color-scheme: dark) {\n:root { color-scheme: dark;');
		expect(STYLE).not.toContain('data-theme');
	});

	it('has no banner and draws no image but the data: icon mask', () => {
		expect(STYLE).not.toContain('.banner');
		expect(STYLE).not.toContain('background-image');
		expect(STYLE).not.toMatch(/url\((?!"data:)/);
	});

	it('has no theme switch', () => {
		expect(STYLE).not.toContain('#themes');
	});
});
