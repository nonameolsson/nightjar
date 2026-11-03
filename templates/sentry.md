# Fix the Sentry error: {{ data.event.title }}

Sentry raised an alert for an error in this code.

- Level: {{ data.event.level }}
- Where: {{ data.event.culprit }}
- Alert rule: {{ data.triggered_rule }}
- Sentry: {{ data.event.web_url }}

## Ticket 1: Find the cause and fix it

Find why the error happens in this repo's code, and fix it. Write a test that fails before the fix and passes after it.

### Acceptance criteria

- [ ] a test reproduces the error and fails without the fix
- [ ] the fix makes that test pass, and the repo's check passes
- [ ] the fix changes only what the error needs
