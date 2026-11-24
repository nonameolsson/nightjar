import { describe, expect, it } from 'vitest';
import { markdown } from './markdown.js';

// an escaped `<` that opens a script tag
const TAG_LEFT = /&#60;\/?script\b/i;

describe('markdown', () => {
	it('renders headings, lists, nested lists, checkboxes, code and quotes', () => {
		const html = markdown(
			[
				'# One',
				'###### Six',
				'',
				'1. first',
				'2. second',
				'   - inner',
				'- [ ] todo',
				'- [x] done',
				'',
				'```html',
				'<b>kept as text</b>',
				'```',
				'',
				'> quoted `<i>`',
				'',
				'Use `npm test` and _care_.'
			].join('\n')
		);
		expect(html).toContain('<h3>One</h3><h6>Six</h6>');
		expect(html).toContain('<ol><li>first</li><li>second<ul><li>inner</li></ul></li></ol>');
		expect(html).toContain(
			'<ul><li class="task"><input type="checkbox" disabled> todo</li><li class="task"><input type="checkbox" disabled checked> done</li></ul>'
		);
		expect(html).toContain('<pre><code>&#60;b&#62;kept as text&#60;/b&#62;</code></pre>');
		expect(html).toContain('<blockquote><p>quoted <code>&#60;i&#62;</code></p></blockquote>');
		expect(html).toContain('<p>Use <code>npm test</code> and <em>care</em>.</p>');
	});

	it('links only web addresses, and reaches no emphasis into one', () => {
		expect(markdown('[ADR](https://example.com/a_b_c*d*)')).toBe(
			'<p><a class="ext" href="https://example.com/a_b_c*d*" target="_blank" rel="noreferrer noopener">ADR</a></p>'
		);
		expect(markdown('[x](data:text/html,hi) [y]("onclick=1)')).toBe('<p>x y</p>');
	});

	it('strips raw HTML but keeps it as text inside code', () => {
		expect(markdown('a <b onclick="x()">b</b> `<b>` <!-- gone -->')).toBe(
			'<p>a b <code>&#60;b&#62;</code></p>'
		);
	});

	it('leaves no tag behind however deep the nesting', () => {
		// each pass takes out one level, so a bounded loop would leave a tag behind
		const depth = 40;
		const nested = `${'<'.repeat(depth)}${'script>'.repeat(depth)}alert(1)`;
		expect(markdown(nested)).not.toMatch(TAG_LEFT);
	});
});
