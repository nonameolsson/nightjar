// A delivery as Sentry sends it for an issue alert (resource `event_alert`, action `triggered`), shaped as Sentry's
// integration platform documents it, with placeholder names: no real organisation, project or person.
import { createHmac } from 'node:crypto';

export const SENTRY_CLIENT_SECRET = 'a-client-secret-for-specs';

export const SENTRY_ISSUE_ID = '4501';

export const SENTRY_EVENT_ALERT = {
	action: 'triggered',
	installation: { uuid: '00000000-0000-4000-8000-000000000000' },
	data: {
		event: {
			event_id: '5a0c1f3e9b7d4c2e8f6a1b2c3d4e5f60',
			issue_id: SENTRY_ISSUE_ID,
			project: 1234,
			platform: 'node',
			type: 'error',
			level: 'error',
			environment: 'production',
			title: "TypeError: Cannot read properties of undefined (reading 'id')",
			culprit: 'handleRequest(src/server)',
			location: 'src/server.js',
			message: '',
			datetime: '2026-11-03T08:15:42.000000Z',
			metadata: {
				type: 'TypeError',
				value: "Cannot read properties of undefined (reading 'id')",
				filename: 'src/server.js',
				function: 'handleRequest'
			},
			tags: [
				['environment', 'production'],
				['level', 'error'],
				['runtime', 'node v24.0.0']
			],
			fingerprint: ['{{ default }}'],
			issue_url: `https://sentry.io/api/0/issues/${SENTRY_ISSUE_ID}/`,
			url: 'https://sentry.io/api/0/projects/example-org/example-app/events/5a0c1f3e9b7d4c2e8f6a1b2c3d4e5f60/',
			web_url: `https://sentry.io/organizations/example-org/issues/${SENTRY_ISSUE_ID}/events/5a0c1f3e9b7d4c2e8f6a1b2c3d4e5f60/`
		},
		triggered_rule: 'New errors in production'
	},
	actor: { type: 'application', id: 'sentry', name: 'Sentry' }
};

// The headers Sentry signs a delivery with: the hex HMAC SHA-256 of the raw body, by the integration's client secret.
export function sentryHeaders(
	body: string,
	resource = 'event_alert',
	secret = SENTRY_CLIENT_SECRET
): Record<string, string> {
	return {
		'content-type': 'application/json',
		'sentry-hook-resource': resource,
		'sentry-hook-timestamp': '1793693742',
		'sentry-hook-signature': createHmac('sha256', secret).update(body).digest('hex')
	};
}
