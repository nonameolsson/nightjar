// The feedback suite is no rubber stamp: a Code host that breaks one rule fails the case for it.
import { describe, expect, it } from 'vitest';
import type { CodeHost, Feedback } from '../code-host.js';
import { FOOTER } from '../footer.js';
import { fakeCodeHostHarness } from '../fakes/harness.js';
import type { CodeHostHarness } from './code-host.js';
import { feedbackContract } from './feedback.js';

type Answering = CodeHost & Required<Pick<CodeHost, 'feedback' | 'reply'>>;

// the fake Code host with its feedback read through `change`
function reading(change: (list: Feedback[]) => Feedback[]): CodeHostHarness {
	return async () => {
		const subject = await fakeCodeHostHarness();
		const host = subject.codeHost as Answering;
		const feedback: Answering['feedback'] = async (pull) => change(await host.feedback(pull));
		return { ...subject, codeHost: { ...host, feedback } };
	};
}

function caseNamed(start: string) {
	const found = feedbackContract.find((c) => c.name.startsWith(start));
	if (found === undefined) throw new Error(`no feedback case starts with ${start}`);
	return found;
}

const withLine = (f: Feedback): Feedback => (f.outdated === true ? { ...f, line: 1 } : f);

describe('the feedback contract', () => {
	it('fails a Code host that reads only the first hundred line comments', async () => {
		const harness = reading((list) => list.slice(0, 100));
		await expect(caseNamed('reads every one of more').run(harness)).rejects.toThrow();
	});

	it('fails a Code host that trusts every author', async () => {
		const harness = reading((list) => list.map((f) => ({ ...f, trusted: true })));
		await expect(caseNamed('marks each piece trusted').run(harness)).rejects.toThrow();
	});

	it('fails a Code host that gives an outdated line comment its line', async () => {
		const harness = reading((list) => list.map(withLine));
		await expect(caseNamed('marks a line comment').run(harness)).rejects.toThrow();
	});

	it('fails a Code host whose reply in a thread has no footer', async () => {
		const harness: CodeHostHarness = async () => {
			const subject = await fakeCodeHostHarness();
			const bench = subject.bench;
			if (bench === undefined) throw new Error('the fake has a bench');
			const thread: typeof bench.thread = async (pull, id) =>
				(await bench.thread(pull, id)).map((text) => text.replace(FOOTER, ''));
			return { ...subject, bench: { ...bench, thread } };
		};
		await expect(caseNamed('answers a line comment').run(harness)).rejects.toThrow();
	});

	it('fails a Code host that reads its own replies as feedback', async () => {
		const harness: CodeHostHarness = async () => {
			const subject = await fakeCodeHostHarness();
			const host = subject.codeHost as Answering;
			const bench = subject.bench;
			if (bench === undefined) throw new Error('the fake has a bench');
			// every reply comes back as a comment by a trusted person, with the footer cut off
			const reply: Answering['reply'] = async (pull, id, body) => {
				await host.reply(pull, id, body);
				await bench.give(pull, { kind: 'comment', author: 'ann', trusted: true, body });
			};
			return { ...subject, codeHost: { ...host, reply } };
		};
		await expect(caseNamed("never reads Nightjar's own words").run(harness)).rejects.toThrow();
	});
});
