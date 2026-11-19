// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.

// Message content per channel: what it says, what it links to, and what it
// must never contain.

import {
  composeMessage,
  displayName,
  formatChime,
  formatEmail,
  formatSlack,
} from '../../lambda/format';
import { monitorLink } from '../../lambda/links';
import { Notification, NOTIFICATION_KINDS, NotificationKind } from '../../lambda/types';
import { FARM_ID, JOB_ID, MONITOR_URL, QUEUE_ID, REGION, STEP_ID, urlsIn } from './fakes';

const IDS = { farmId: FARM_ID, queueId: QUEUE_ID, jobId: JOB_ID, stepId: STEP_ID };
const LINK = monitorLink(MONITOR_URL, REGION, IDS);

function notification(kind: NotificationKind, extra: Partial<Notification> = {}): Notification {
  return {
    kind,
    eventId: 'event-1',
    idempotencyKey: 'event:event-1',
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

describe('hostile job and step names', () => {
  /** Names a submitter could give a job or step to phish or ping its recipients. */
  const HOSTILE = {
    html: '<script>alert(1)</script><a href="https://evil.example/login">"fix it"</a>',
    slackLink: '<https://evil.example/login|Re-run the job>',
    slackMentions: '<!channel> <!here> <@U012AB3CD> @here',
    slackCodeBreakout: 'Render` <https://evil.example|approve> `x',
    markdown: '[Approve here](https://evil.example) ![x](https://evil.example/p.png) **urgent**',
    chimeMentions: '@All @Present',
    bareUrl: 'see https://evil.example/login or www.evil.example or evil.example',
    email: 'mail it-support@evil.example',
    newlines: 'Render\n\nApprove here: evil.example\r\nThanks',
    bidi: 'shot_042\u202Egnp.exe\u2066',
    lookalikeDots: 'evil\u3002example and evil\uFF0Eexample',
  };

  function hostile(name: string): Notification {
    return notification('APPROVAL_REQUESTED', { jobName: name, stepName: name });
  }

  function slackTexts(n: Notification): string[] {
    const slack = formatSlack(composeMessage(n)) as {
      text: string;
      blocks: { text?: { text: string }; elements?: { text: string }[] }[];
    };
    return [
      slack.text,
      ...slack.blocks.flatMap((block) => [
        ...(block.text ? [block.text.text] : []),
        ...(block.elements ?? []).map((element) => element.text),
      ]),
    ];
  }

  test.each(Object.entries(HOSTILE))('%s: links only to monitor, on every channel', (_, name) => {
    for (const part of rendered(hostile(name))) {
      for (const url of urlsIn(part)) {
        expect(url.replace(/&amp;/g, '&')).toBe(LINK);
      }
      // No client can recognize the attacker's domain, email address, or a
      // mention, since a zero-width space breaks each of them up.
      expect(part).not.toMatch(/evil[.\u3002\uFF0E]example/);
      expect(part).not.toMatch(/@(All|Present|here|channel)\b/);
      expect(part).not.toMatch(/[\u202A-\u202E\u2066-\u2069]/);
    }
  });

  test('names stay on one line, so they cannot add lines to a message', () => {
    const n = hostile(HOSTILE.newlines);
    const { text } = formatEmail(composeMessage(n));
    expect(text).not.toMatch(/^Approve here/m);
    expect(text).toContain('Job: Render Approve here: evil.\u200Bexample Thanks');
    for (const part of slackTexts(n)) {
      expect(part).not.toContain('Approve here:\n');
    }
  });

  test('HTML email escapes names', () => {
    const { html } = formatEmail(composeMessage(hostile(HOSTILE.html)));
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&lt;a href=&quot;https:\u200B//evil.\u200Bexample/login&quot;&gt;');
    expect(html.match(/<a /g)).toHaveLength(1);
  });

  test('the plain-text email part shows names as typed, apart from the link breaks', () => {
    const { text } = formatEmail(composeMessage(hostile(HOSTILE.html)));
    expect(text).toContain(
      'Job: <script>alert(1)</script><a href="https:\u200B//evil.\u200Bexample/login">',
    );
  });

  test('Slack escapes names so they cannot form links or mentions', () => {
    for (const name of [HOSTILE.slackLink, HOSTILE.slackMentions, HOSTILE.slackCodeBreakout]) {
      const texts = slackTexts(hostile(name));
      const context = texts[texts.length - 1];
      // The only `<...>` left is the monitor link.
      expect(texts.join('\n').match(/<[^>]*>/g)).toEqual([
        `<${LINK}|Review in Deadline Cloud monitor>`,
      ]);
      expect(context).toContain('&lt;');
      // Job, Step, Job ID, and Step ID are one code span each: a backtick in a
      // name cannot end its span early.
      expect(context.match(/`/g)).toHaveLength(2 * 4);
    }
  });

  test('Slack does not preprocess the text for links or mentions', () => {
    const slack = formatSlack(composeMessage(hostile(HOSTILE.bareUrl))) as {
      blocks: { text?: { verbatim?: boolean }; elements?: { verbatim?: boolean }[] }[];
    };
    const textObjects = slack.blocks.flatMap((block) => [
      ...(block.text ? [block.text] : []),
      ...(block.elements ?? []),
    ]);
    expect(textObjects.length).toBeGreaterThan(0);
    for (const text of textObjects) expect(text.verbatim).toBe(true);
  });

  test('Chime renders Markdown, with names escaped so they cannot form links or images', () => {
    const { Content } = formatChime(composeMessage(hostile(HOSTILE.markdown))) as {
      Content: string;
    };
    expect(Content.startsWith('/md ')).toBe(true);
    // The only Markdown link is the monitor link.
    expect(Content.match(/(?<!\\)\[[^\]]*(?<!\\)\]\(/g)).toEqual([
      '[Review in Deadline Cloud monitor](',
    ]);
    expect(Content).toContain('\\[Approve here\\]\\(https:\u200B//evil.\u200Bexample\\)');
    expect(Content).toContain('\\*\\*urgent\\*\\*');
    expect(Content).not.toMatch(/(?<!\\)!\[/);
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
  test('is a single Markdown Content string with the link', () => {
    const chime = formatChime(composeMessage(notification('JOB_FAILED')));
    expect(Object.keys(chime)).toEqual(['Content']);
    expect(chime.Content).toContain(`[Open in Deadline Cloud monitor](${LINK})`);
    expect(chime.Content).toContain('**\\[Deadline Cloud\\] Job failed**');
  });
});

describe('displayName', () => {
  test('leaves ordinary names readable', () => {
    expect(displayName('shot_042_lighting_v3')).toBe('shot_042_lighting_v3');
    expect(displayName('  Render   comp ')).toBe('Render comp');
    expect(displayName('scene.ma')).toBe('scene.\u200Bma');
  });

  test('treats a name with nothing visible as no name', () => {
    expect(displayName(undefined)).toBeUndefined();
    expect(displayName('\u202E\u200B \n')).toBeUndefined();
    const { details } = composeMessage(notification('JOB_FAILED', { jobName: '\u2066\u2069' }));
    expect(details.map(([label]) => label)).not.toContain('Job');
  });
});
