// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.

// Message content per channel: what it says, what it links to, and what it
// must never contain.

import { composeMessage, formatChime, formatEmail, formatSlack } from '../../lambda/format';
import { monitorLink } from '../../lambda/links';
import { Notification, NOTIFICATION_KINDS, NotificationKind } from '../../lambda/types';
import { FARM_ID, JOB_ID, MONITOR_URL, QUEUE_ID, REGION, STEP_ID, urlsIn } from './fakes';

const IDS = { farmId: FARM_ID, queueId: QUEUE_ID, jobId: JOB_ID, stepId: STEP_ID };
const LINK = monitorLink(MONITOR_URL, REGION, IDS);

function notification(kind: NotificationKind, extra: Partial<Notification> = {}): Notification {
  return {
    kind,
    eventId: 'event-1',
    region: REGION,
    ids: IDS,
    link: LINK,
    audience: [],
    decision: kind === 'APPROVAL_DECIDED' ? 'APPROVED' : undefined,
    ...extra,
  };
}

/** Every string anywhere in a webhook payload. */
function strings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (value && typeof value === 'object') return Object.values(value).flatMap(strings);
  return [];
}

/** Everything a recipient could see or click, on every channel. */
function rendered(n: Notification): string[] {
  const message = composeMessage(n);
  const email = formatEmail(message);
  return [
    email.subject,
    email.text,
    email.html,
    ...strings(formatSlack(message)),
    ...strings(formatChime(message)),
  ];
}

describe.each(NOTIFICATION_KINDS)('%s messages', (kind) => {
  test('link only to the monitor page', () => {
    for (const part of rendered(notification(kind))) {
      for (const url of urlsIn(part)) {
        // The HTML form escapes the ampersands in the query string.
        expect(url.replace(/&amp;/g, '&')).toBe(LINK);
      }
    }
  });

  test('carry no approve or reject action', () => {
    const slack = formatSlack(composeMessage(notification(kind)));
    const blockTypes = (slack.blocks as { type: string }[]).map((block) => block.type);
    expect(blockTypes).not.toContain('actions');
    expect(JSON.stringify(slack)).not.toMatch(/"type":"button"|"action_id"|"value":/);

    for (const part of rendered(notification(kind))) {
      expect(part).not.toMatch(/<form|<button|approve=|decision=|action=/i);
    }
  });

  test('leave out job and step names unless they are provided', () => {
    for (const part of rendered(notification(kind))) {
      expect(part).not.toContain('Job:');
      expect(part).not.toContain('Step:');
    }
  });
});

describe('composeMessage', () => {
  test('asks approvers to sign in to monitor to decide', () => {
    const message = composeMessage(notification('APPROVAL_REQUESTED'));
    expect(message.subject).toBe('[Deadline Cloud] Step waiting for your approval');
    expect(message.summary).toContain('Sign in to Deadline Cloud monitor');
    expect(message.linkText).toBe('Review in Deadline Cloud monitor');
  });

  test('reports the decision of an approval', () => {
    expect(composeMessage(notification('APPROVAL_DECIDED')).subject).toBe(
      '[Deadline Cloud] Step approved',
    );
    expect(
      composeMessage(notification('APPROVAL_DECIDED', { decision: 'REJECTED' })).subject,
    ).toBe('[Deadline Cloud] Step rejected');
  });

  test('includes the IDs, which carry no project information', () => {
    const { details } = composeMessage(notification('STEP_FAILED'));
    expect(details).toEqual([
      ['Job ID', JOB_ID],
      ['Step ID', STEP_ID],
    ]);
  });
});

describe('escaping names', () => {
  const hostile = notification('JOB_FAILED', {
    jobName: '<script>alert(1)</script> & <https://evil.example|click>',
    stepName: '"quoted"',
  });

  test('HTML email escapes names', () => {
    const { html } = formatEmail(composeMessage(hostile));
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&quot;quoted&quot;');
  });

  test('Slack escapes names so they cannot form links or mentions', () => {
    const slack = JSON.stringify(formatSlack(composeMessage(hostile)));
    expect(slack).not.toContain('<https://evil.example|click>');
    expect(slack).toContain('&lt;https://evil.example|click&gt;');
  });
});

describe('formatSlack', () => {
  test('turns off link unfurling', () => {
    const slack = formatSlack(composeMessage(notification('JOB_FAILED')));
    expect(slack.unfurl_links).toBe(false);
    expect(slack.unfurl_media).toBe(false);
  });
});

describe('formatChime', () => {
  test('is a single Content string with the link', () => {
    const chime = formatChime(composeMessage(notification('JOB_FAILED')));
    expect(Object.keys(chime)).toEqual(['Content']);
    expect(chime.Content).toContain(LINK);
  });
});
