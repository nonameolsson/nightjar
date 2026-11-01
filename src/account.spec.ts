import { describe, expect, it } from 'vitest';
import { accountLine, parseAccount, profileEnv } from './account.js';

const HOME = '/home/ann';

describe('profileEnv', () => {
	it('leaves the environment alone when there is no profile', () => {
		const env = { HOME, CLAUDE_CONFIG_DIR: '/x', CLAUDE_CODE_OAUTH_TOKEN: 't' };
		expect(profileEnv(undefined, env)).toEqual(env);
	});

	it('points a name at ~/.claude-NAME and drops the token', () => {
		const env = profileEnv('work', { HOME, CLAUDE_CODE_OAUTH_TOKEN: 't', PATH: '/bin' });
		expect(env).toEqual({ HOME, PATH: '/bin', CLAUDE_CONFIG_DIR: '/home/ann/.claude-work' });
		expect('CLAUDE_CODE_OAUTH_TOKEN' in env).toBe(false);
	});

	it('takes a path as the folder itself, with ~/ from home', () => {
		expect(profileEnv('/srv/claude', { HOME }).CLAUDE_CONFIG_DIR).toBe('/srv/claude');
		expect(profileEnv('~/logins/work', { HOME }).CLAUDE_CONFIG_DIR).toBe('/home/ann/logins/work');
	});

	it('means ~/.claude by `default`: no config folder, and still no token', () => {
		const env = profileEnv('default', {
			HOME,
			CLAUDE_CONFIG_DIR: '/x',
			CLAUDE_CODE_OAUTH_TOKEN: 't'
		});
		expect(env).toEqual({ HOME });
	});
});

describe('parseAccount', () => {
	it('reads either spelling of the fields', () => {
		const a = parseAccount(
			JSON.stringify({
				loggedIn: true,
				email: 'ann@x.io',
				orgName: 'Acme',
				subscriptionType: 'max',
				authMethod: 'claude.ai',
				configDirectory: '/home/ann/.claude-work'
			})
		);
		const b = parseAccount(
			JSON.stringify({
				loggedIn: true,
				emailAddress: 'ann@x.io',
				organizationName: 'Acme',
				subscriptionType: 'max',
				authMethod: 'claude.ai',
				configDirectory: '/home/ann/.claude-work'
			})
		);
		expect(a).toEqual(b);
		expect(accountLine(a ?? { loggedIn: false })).toBe(
			'ann@x.io, Acme, max plan, claude.ai login, config /home/ann/.claude-work'
		);
	});

	it('names what a token login gives: only loggedIn, authMethod and configDirectory', () => {
		const a = parseAccount(
			JSON.stringify({
				loggedIn: true,
				authMethod: 'oauth_token',
				configDirectory: '/home/ann/.claude'
			})
		);
		expect(a).not.toBeNull();
		expect(accountLine(a ?? { loggedIn: false })).toBe(
			'oauth_token login, config /home/ann/.claude'
		);
	});

	it('knows a signed-out login', () => {
		expect(parseAccount('{"loggedIn": false}')).toEqual({ loggedIn: false });
	});

	it('gives null for what is not JSON', () => {
		expect(parseAccount('not json')).toBeNull();
		expect(parseAccount('[]')).toBeNull();
	});
});
