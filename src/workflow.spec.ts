import { globSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { chooseWorkflow, skillsNamed, workflowLine, type WorkflowConfig } from './workflow.js';

const flow: WorkflowConfig = {
	steps: [{ name: 'critique', prompt: 'look', point: 'afterAllTickets' }]
};

describe('workflowLine', () => {
	it.each([
		['**Workflow:** design-review', 'design-review'],
		['Workflow: design-review', 'design-review'],
		['text\n\n**workflow:**  `design-review`  \nmore', 'design-review'],
		['**Workflow:** two words', 'two words']
	])('reads %j', (body, name) => {
		expect(workflowLine(body)).toBe(name);
	});

	it('finds none in a body without the line', () => {
		expect(workflowLine('A Feature about the Workflow: it is long')).toBeUndefined();
		expect(workflowLine('**Workflow:**')).toBeUndefined();
	});
});

describe('chooseWorkflow', () => {
	const settings = { workflows: { 'design-review': flow } };

	it('picks none without a line or a default', () => {
		expect(chooseWorkflow(settings, 'a body')).toEqual({ kind: 'none' });
		expect(chooseWorkflow({}, 'a body')).toEqual({ kind: 'none' });
	});

	it('picks the default without a line, and the line over the default', () => {
		const withDefault = {
			workflows: { ...settings.workflows, other: flow },
			defaultWorkflow: 'other'
		};
		expect(chooseWorkflow(withDefault, 'a body')).toMatchObject({ name: 'other' });
		expect(chooseWorkflow(withDefault, '**Workflow:** design-review')).toMatchObject({
			name: 'design-review'
		});
	});

	it('refuses an unknown name, naming the known ones', () => {
		const got = chooseWorkflow(settings, '**Workflow:** nope');
		expect(got).toMatchObject({ kind: 'refused' });
		expect(got.kind === 'refused' && got.why).toContain('`design-review`');
	});

	it('refuses a line when factory.json names no Workflow', () => {
		const got = chooseWorkflow({}, '**Workflow:** nope');
		expect(got.kind === 'refused' && got.why).toContain('factory.json names none');
	});

	it('refuses a Workflow that cannot run here, with the reason', () => {
		const got = chooseWorkflow(
			{ ...settings, brokenWorkflows: { 'design-review': 'no such skill' } },
			'**Workflow:** design-review'
		);
		expect(got.kind === 'refused' && got.why).toContain('no such skill');
	});
});

describe('skillsNamed', () => {
	it('finds the skills a prompt names with a slash', () => {
		expect(skillsNamed('/design-critic critique, then /tdd')).toEqual(['design-critic', 'tdd']);
		expect(skillsNamed('Run `/plugin:skill` once')).toEqual(['plugin:skill']);
	});

	it('does not read a path or a URL as a skill', () => {
		expect(skillsNamed('edit src/app/main.ts and /tmp/notes, see https://a.example/x')).toEqual([]);
		expect(skillsNamed('about 1/2 of it')).toEqual([]);
	});
});

describe('the code', () => {
	it('names no skill: a Workflow brings its own', () => {
		const root = fileURLToPath(new URL('..', import.meta.url));
		const name = new RegExp(['impe', 'ccable'].join(''), 'i');
		const found = globSync('src/**/*.ts', { cwd: root }).filter((f) =>
			name.test(readFileSync(join(root, f), 'utf8'))
		);
		expect(found).toEqual([]);
	});
});
