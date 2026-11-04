// The feedback contract (docs/custom-adapters.md): run over a Code host that has the optional `feedback` and `reply`.
import assert from 'node:assert/strict';
import type { CodeHost, Feedback, Pull } from '../code-host.js';
import { endsWithFooter, FOOTER } from '../footer.js';
import type { ContractCase } from './case.js';
import type { CodeHostHarness, CodeHostSubject, FeedbackBench, Given } from './code-host.js';

type FeedbackHost = CodeHost & Required<Pick<CodeHost, 'feedback' | 'reply'>>;

interface Opened {
	readonly subject: CodeHostSubject;
	readonly host: FeedbackHost;
	readonly bench: FeedbackBench;
	// a draft pull request with nothing said on it yet
	readonly pull: Pull;
}

function feedbackCase(
	name: string,
	check: (opened: Opened) => Promise<void>
): ContractCase<CodeHostHarness> {
	return {
		name,
		run: async (harness) => {
			const subject = await harness();
			try {
				const { codeHost, bench } = subject;
				assert.ok(
					codeHost.feedback !== undefined && codeHost.reply !== undefined,
					'the Code host has feedback and reply'
				);
				assert.ok(
					bench !== undefined,
					'the harness gives a bench, to put feedback on a pull request'
				);
				await codeHost.push((await subject.commit()).folder, 'factory/1-a');
				const pull = await codeHost.createDraft({
					title: 'A',
					head: 'factory/1-a',
					base: subject.base,
					body: 'a'
				});
				await check({ subject, host: codeHost as FeedbackHost, bench, pull });
			} finally {
				await subject.close?.();
			}
		}
	};
}

const sorted = (ids: readonly string[]) => [...ids].sort();

const idsOf = (list: readonly Feedback[]) => sorted(list.map((f) => f.id));

function seen(list: readonly Feedback[], id: string): Feedback {
	const found = list.find((f) => f.id === id);
	assert.ok(found !== undefined, `the feedback holds ${id}; it holds ${idsOf(list).join(', ')}`);
	return found;
}

function only<T>(list: readonly T[], what: string): T {
	const [first] = list;
	assert.ok(
		first !== undefined && list.length === 1,
		`exactly one ${what}; got ${String(list.length)}`
	);
	return first;
}

// what a reply quotes of feedback: the start of its first line
const startOf = (body: string) => body.split('\n')[0]?.slice(0, 30) ?? '';

const CONCLUSIONS = ['failure', 'timed_out', 'success', 'skipped', 'neutral'] as const;

type Review = Extract<Given, { kind: 'review' }>;

// A review as the host holds it: a vote has no text, and only one that asks for changes is feedback.
const asHeld = (bench: FeedbackBench, review: Review): Given =>
	bench.reviewsAreVotes === true ? { ...review, changes: true } : review;

const CHECK = 'ci / test';

const failing = (output = '1 test failed', trusted = true): Given => ({
	kind: 'check',
	name: CHECK,
	output,
	conclusion: 'failure',
	trusted
});

export const feedbackContract: readonly ContractCase<CodeHostHarness>[] = [
	feedbackCase(
		'reads line comments, conversation comments, reviews with a body and failed checks, each id prefixed with its kind',
		async ({ host, bench, pull }) => {
			const line = await bench.give(pull, {
				kind: 'comment',
				author: 'ann',
				body: 'Rename this $(x) & "y".',
				trusted: true,
				on: { path: 'src/a.ts', line: 3 }
			});
			const talk = await bench.give(pull, {
				kind: 'comment',
				author: 'ann',
				body: 'Why a loop?',
				trusted: true
			});
			const review = await bench.give(
				pull,
				asHeld(bench, { kind: 'review', author: 'bob', body: 'Needs a test.', trusted: true })
			);
			const check = await bench.give(pull, failing());
			assert.deepEqual(
				[line, talk, review, check].map((id) => id.split(':')[0]),
				['comment', 'comment', 'review', 'check']
			);
			const got = await host.feedback(pull);
			assert.deepEqual(idsOf(got), sorted([line, talk, review, check]));
			for (const f of got) assert.equal(f.id.split(':')[0], f.kind, `${f.id} is a ${f.kind}`);
			assert.ok(got.every((f) => f.at !== ''));

			const onLine = seen(got, line);
			assert.deepEqual(
				[onLine.kind, onLine.author, onLine.body, onLine.path, onLine.line, onLine.outdated],
				['comment', 'ann', 'Rename this $(x) & "y".', 'src/a.ts', 3, undefined]
			);
			const inTalk = seen(got, talk);
			assert.deepEqual(
				[inTalk.kind, inTalk.author, inTalk.body, inTalk.path, inTalk.line, inTalk.outdated],
				['comment', 'ann', 'Why a loop?', undefined, undefined, undefined]
			);
			const inReview = seen(got, review);
			assert.deepEqual([inReview.kind, inReview.author], ['review', 'bob']);
			if (bench.reviewsAreVotes === true) {
				assert.ok(inReview.body.trim() !== '', 'a vote reads as words of the host');
			} else {
				assert.equal(inReview.body, 'Needs a test.');
			}
			const inCheck = seen(got, check);
			assert.equal(inCheck.kind, 'check');
			assert.ok(inCheck.body.includes(CHECK), `a check's body names it:\n${inCheck.body}`);
			assert.ok(inCheck.body.includes('1 test failed'), `and holds its output:\n${inCheck.body}`);
		}
	),

	feedbackCase(
		'marks each piece trusted only when the host trusts its author',
		async ({ host, bench, pull }) => {
			const trusted = async (yes: boolean) => ({
				line: await bench.give(pull, {
					kind: 'comment',
					author: yes ? 'ann' : 'mallory',
					body: 'Line.',
					trusted: yes,
					on: { path: 'src/a.ts', line: 1 }
				}),
				talk: await bench.give(pull, {
					kind: 'comment',
					author: yes ? 'ann' : 'mallory',
					body: 'Talk.',
					trusted: yes
				}),
				review: await bench.give(
					pull,
					asHeld(bench, {
						kind: 'review',
						author: yes ? 'ann' : 'mallory',
						body: 'Review.',
						trusted: yes
					})
				),
				check: await bench.give(pull, failing('Output.', yes))
			});
			const yes = await trusted(true);
			const no = await trusted(false);
			const got = await host.feedback(pull);
			for (const id of Object.values(yes)) {
				assert.equal(seen(got, id).trusted, true, `${id} is trusted`);
			}
			for (const id of Object.values(no)) {
				assert.equal(seen(got, id).trusted, false, `${id} is not trusted`);
			}
		}
	),

	feedbackCase(
		'reads a check that failed or timed out, and no check that passed, was skipped or was neutral',
		async ({ host, bench, pull }) => {
			const asked = new Map<string, boolean>();
			for (const conclusion of CONCLUSIONS) {
				const id = await bench.give(pull, {
					kind: 'check',
					name: `${CHECK} ${conclusion}`,
					output: conclusion,
					conclusion,
					trusted: true
				});
				asked.set(id, conclusion === 'failure' || conclusion === 'timed_out');
			}
			const wanted = [...asked].filter(([, feedback]) => feedback).map(([id]) => id);
			assert.equal(wanted.length, 2);
			assert.deepEqual(idsOf(await host.feedback(pull)), sorted(wanted));
		}
	),

	feedbackCase(
		'skips an approval with no body, and reads one with a body',
		async ({ host, bench, pull }) => {
			await bench.give(pull, {
				kind: 'review',
				author: 'ann',
				body: '',
				trusted: true,
				approval: true
			});
			const nit = await bench.give(pull, {
				kind: 'review',
				author: 'ann',
				body: 'Looks good, one nit.',
				trusted: true,
				approval: true
			});
			// a vote holds no body, so an approval says nothing to answer
			assert.deepEqual(
				idsOf(await host.feedback(pull)),
				bench.reviewsAreVotes === true ? [] : [nit]
			);
		}
	),

	feedbackCase(
		"never reads Nightjar's own words as feedback, whoever wrote them, and so not its replies",
		async ({ host, bench, pull }) => {
			const own = `**Nightjar review: changes**\n\n- \`src/a.ts:3\`: a thing${FOOTER}`;
			for (const author of ['ann', 'mallory']) {
				const trusted = author === 'ann';
				await bench.give(pull, { kind: 'comment', author, body: own, trusted });
				// a vote holds no body for Nightjar to sign
				if (bench.reviewsAreVotes !== true) {
					await bench.give(pull, { kind: 'review', author, body: own, trusted });
				}
				await bench.give(pull, {
					kind: 'comment',
					author,
					body: own,
					trusted,
					on: { path: 'src/a.ts', line: 1 }
				});
			}
			const real = await bench.give(pull, {
				kind: 'comment',
				author: 'ann',
				body: 'Please change it.',
				trusted: true
			});
			assert.deepEqual(idsOf(await host.feedback(pull)), [real]);
			await host.reply(pull, real, 'Done in abc123.');
			assert.deepEqual(idsOf(await host.feedback(pull)), [real]);
		}
	),

	feedbackCase(
		'marks a line comment on a line the head commit no longer has as outdated, with its path and no line',
		async ({ host, bench, pull }) => {
			const gone = await bench.give(pull, {
				kind: 'comment',
				author: 'ann',
				body: 'This used to be wrong.',
				trusted: true,
				on: { path: 'src/old.ts', line: null }
			});
			const here = await bench.give(pull, {
				kind: 'comment',
				author: 'ann',
				body: 'This is wrong.',
				trusted: true,
				on: { path: 'src/a.ts', line: 7 }
			});
			const got = await host.feedback(pull);
			const old = seen(got, gone);
			assert.deepEqual([old.outdated, old.path, old.line], [true, 'src/old.ts', undefined]);
			const now = seen(got, here);
			assert.deepEqual([now.outdated, now.path, now.line], [undefined, 'src/a.ts', 7]);
		}
	),

	feedbackCase("cuts a failed check's output to its last 4 KB", async ({ host, bench, pull }) => {
		const output = `HEAD-OF-OUTPUT\n${'x'.repeat(10_000)}\nTAIL-OF-OUTPUT`;
		const id = await bench.give(pull, failing(output));
		const { body } = seen(await host.feedback(pull), id);
		assert.ok(body.includes('TAIL-OF-OUTPUT'), 'the end of the output stays');
		assert.ok(body.includes('x'.repeat(4000)), 'and as much of it as 4 KB holds');
		assert.ok(!body.includes('HEAD-OF-OUTPUT'), 'the start of the output goes');
		const bytes = Buffer.byteLength(body);
		assert.ok(bytes <= 4096 + 512, `the body is ${String(bytes)} bytes`);
	}),

	feedbackCase('reads every one of more than 100 line comments', async ({ host, bench, pull }) => {
		const given: string[] = [];
		for (let n = 1; n <= 120; n += 1) {
			given.push(
				await bench.give(pull, {
					kind: 'comment',
					author: 'ann',
					body: `Comment ${String(n)}.`,
					trusted: true,
					on: { path: 'src/a.ts', line: n }
				})
			);
		}
		assert.deepEqual(idsOf(await host.feedback(pull)), sorted(given));
	}),

	feedbackCase(
		'answers a line comment in its thread, ending with the footer, and leaves the conversation alone',
		async ({ subject, host, bench, pull }) => {
			const id = await bench.give(pull, {
				kind: 'comment',
				author: 'ann',
				body: 'Rename this.',
				trusted: true,
				on: { path: 'src/a.ts', line: 3 }
			});
			const before = (await subject.pull(pull)).comments;
			await host.reply(pull, id, 'Renamed in abc123.');
			const reply = only(await bench.thread(pull, id), 'reply in the thread');
			assert.ok(reply.includes('Renamed in abc123.'), `the reply:\n${reply}`);
			assert.ok(endsWithFooter(reply), `the reply ends with the footer:\n${reply}`);
			assert.deepEqual((await subject.pull(pull)).comments, before);
		}
	),

	feedbackCase(
		"answers anything else in the pull request's conversation, quoting the start of it and ending with the footer; a comment may be answered in its own thread instead",
		async ({ subject, host, bench, pull }) => {
			const asked: Given[] = [
				{
					kind: 'comment',
					author: 'ann',
					body: 'Why a loop and not a map?',
					trusted: true
				},
				asHeld(bench, {
					kind: 'review',
					author: 'ann',
					body: 'Please add a test for the empty case.',
					trusted: true
				}),
				failing()
			];
			for (const given of asked) {
				const id = await bench.give(pull, given);
				const quoted = startOf(seen(await host.feedback(pull), id).body);
				assert.notEqual(quoted, '');
				const before = (await subject.pull(pull)).comments;
				await host.reply(pull, id, `Fixed, see ${id}.`);
				if (given.kind === 'comment') {
					const replies = await bench.thread(pull, id);
					if (replies.length > 0) {
						const reply = only(replies, `reply in the thread of ${id}`);
						assert.ok(reply.includes(`Fixed, see ${id}.`), `the reply:\n${reply}`);
						assert.ok(endsWithFooter(reply), `the reply ends with the footer:\n${reply}`);
						assert.deepEqual((await subject.pull(pull)).comments, before);
						continue;
					}
				}
				const added = (await subject.pull(pull)).comments.slice(before.length);
				const reply = only(added, `comment on the pull request after answering ${id}`);
				assert.ok(reply.includes(`Fixed, see ${id}.`), `the reply:\n${reply}`);
				assert.ok(reply.includes(quoted), `the reply quotes ${quoted}:\n${reply}`);
				assert.ok(reply.indexOf(quoted) < reply.indexOf('Fixed, see'), 'the quote comes first');
				assert.ok(endsWithFooter(reply), `the reply ends with the footer:\n${reply}`);
			}
		}
	),

	feedbackCase('refuses to answer feedback that is not there', async ({ host, pull }) => {
		for (const id of ['comment:999999', 'review:999999', 'check:999999']) {
			const attempt = Promise.resolve().then(() => host.reply(pull, id, 'Done.'));
			await assert.rejects(attempt, `answering ${id}`);
		}
	})
];
