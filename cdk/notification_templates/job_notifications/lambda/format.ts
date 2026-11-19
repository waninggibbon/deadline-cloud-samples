// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.

// Message text for each channel.
//
// Messages say what happened and link to monitor, and little else. Studio
// work is often under NDA, and an email or chat message travels further than
// monitor does, so job and step names are only included when the stack's
// MessageDetail parameter asks for them, and nothing from the job's
// parameters, logs, or output is ever included.
//
// No message carries an action. There are no approve or reject buttons and no
// one-click links: an approval is recorded on the monitor page, by someone
// signed in to it, so a forwarded or leaked message cannot approve anything.
//
// Job and step names are written by whoever submits the job, so they are
// treated as hostile. `displayName` makes a name inert on every channel: it
// cannot add lines to the message, and clients do not turn anything in it into
// a link or a mention. Each formatter then escapes every value for its own
// markup: HTML for an email's HTML part, mrkdwn for Slack, and Markdown for
// Amazon Chime. An email's plain-text part has no markup to escape.

import { Notification } from './types';

/** The channel-independent content of a message. */
export interface Message {
  readonly subject: string;
  readonly summary: string;
  readonly linkText: string;
  readonly link: string;
  /** Label and value pairs identifying the resources, such as the job ID. */
  readonly details: readonly (readonly [string, string])[];
}

const FOOTER =
  'You received this because of your AWS Deadline Cloud notification preferences. ' +
  'Ask your Deadline Cloud administrator to change them.';

const ZERO_WIDTH_SPACE = '\u200B';

/**
 * A job or step name, made safe to show in any message.
 *
 * Line breaks and other control characters become spaces, so a name cannot
 * add lines to a message, and invisible formatting characters, such as
 * bidirectional overrides, are removed, so it cannot reorder the text around
 * it. Then a zero-width space goes after each character that lets a client
 * recognize a link or a mention: the dots of a domain name, the colon of
 * `https://`, and the `@` of an email address or of a mention such as `@here`
 * or `@All`. The name reads the same, but `https://example.com/login` in it is
 * no longer a link and `@All` no longer notifies a whole chat room.
 */
export function displayName(name: string | undefined): string | undefined {
  if (name === undefined) return undefined;
  const text = name
    .replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, ' ')
    .replace(/\p{Cf}/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    // Full stops, including the ideographic and fullwidth ones that browsers
    // also accept in domain names.
    .replace(/[.\u3002\uFF0E\uFF61](?=\S)/gu, `$&${ZERO_WIDTH_SPACE}`)
    .replace(/:(?=[/\\])/g, `:${ZERO_WIDTH_SPACE}`)
    .replace(/[@\uFF20]/gu, `$&${ZERO_WIDTH_SPACE}`);
  return text === '' ? undefined : text;
}

export function composeMessage(notification: Notification): Message {
  const { kind, ids, decision } = notification;
  let subject: string;
  let summary: string;
  let linkText = 'Open in Deadline Cloud monitor';
  switch (kind) {
    case 'JOB_FAILED':
      subject = 'Job failed';
      summary = 'A job you submitted to AWS Deadline Cloud failed.';
      break;
    case 'STEP_FAILED':
      subject = 'Step failed';
      summary = 'A step in a job you submitted to AWS Deadline Cloud failed.';
      break;
    case 'TASK_FAILED':
      subject = 'Task failed';
      summary = 'A task in a job you submitted to AWS Deadline Cloud failed.';
      break;
    case 'APPROVAL_REQUESTED':
      subject = 'Step waiting for your approval';
      summary =
        'A step in an AWS Deadline Cloud job is waiting for approval, and you are one of its ' +
        'approvers. Sign in to Deadline Cloud monitor to review the step and record your decision.';
      linkText = 'Review in Deadline Cloud monitor';
      break;
    case 'APPROVAL_DECIDED':
      switch (decision) {
        case 'REJECTED':
          subject = 'Step rejected';
          summary = 'A step waiting for approval in an AWS Deadline Cloud job was rejected.';
          break;
        case 'EXPIRED':
          subject = 'Step approval expired';
          summary =
            'A step waiting for approval in an AWS Deadline Cloud job was not approved in time, ' +
            'and its approval request expired.';
          break;
        default:
          subject = 'Step approved';
          summary = 'A step waiting for approval in an AWS Deadline Cloud job was approved.';
      }
      break;
  }

  const details: [string, string][] = [];
  const jobName = displayName(notification.jobName);
  const stepName = displayName(notification.stepName);
  if (jobName) details.push(['Job', jobName]);
  if (stepName) details.push(['Step', stepName]);
  details.push(['Job ID', ids.jobId]);
  if (ids.stepId) details.push(['Step ID', ids.stepId]);
  if (ids.taskId) details.push(['Task ID', ids.taskId]);

  return {
    subject: `[Deadline Cloud] ${subject}`,
    summary,
    linkText,
    link: notification.link,
    details,
  };
}

export interface EmailContent {
  readonly subject: string;
  readonly text: string;
  readonly html: string;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function formatEmail(message: Message): EmailContent {
  const text = [
    message.summary,
    '',
    `${message.linkText}: ${message.link}`,
    '',
    ...message.details.map(([label, value]) => `${label}: ${value}`),
    '',
    FOOTER,
  ].join('\n');

  const html = [
    '<!DOCTYPE html><html><body style="font-family: sans-serif;">',
    `<p>${escapeHtml(message.summary)}</p>`,
    `<p><a href="${escapeHtml(message.link)}">${escapeHtml(message.linkText)}</a></p>`,
    '<p style="color: #555;">',
    message.details
      .map(([label, value]) => `${escapeHtml(label)}: ${escapeHtml(value)}`)
      .join('<br>'),
    '</p>',
    `<p style="color: #777; font-size: small;">${escapeHtml(FOOTER)}</p>`,
    '</body></html>',
  ].join('');

  return { subject: message.subject, text, html };
}

/**
 * Slack mrkdwn's control characters are `&`, `<`, and `>`. Escaping them is
 * what stops a value forming a `<https://...|link>`, a `<@U123>` user mention,
 * or a `<!here>` or `<!channel>` mention.
 */
function escapeSlack(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * A value as a Slack code span, in which `*`, `_`, and `~` are literal and URLs
 * are not linked. A backtick would end the span early, so it is replaced.
 */
function slackCode(value: string): string {
  return `\`${escapeSlack(value.replace(/`/g, "'"))}\``;
}

/**
 * A Slack incoming webhook payload: text blocks only, with no buttons or other
 * interactive elements, and link unfurling off so Slack does not try to fetch
 * the monitor page. Every text object is `verbatim`, so Slack does not turn
 * URLs, channel names, or mentions in it into links; the monitor link is the
 * only link, written out explicitly.
 */
export function formatSlack(message: Message): Record<string, unknown> {
  const details = message.details
    .map(([label, value]) => `${escapeSlack(label)}: ${slackCode(value)}`)
    .join('  |  ');
  return {
    text: `${escapeSlack(message.subject)}: ${escapeSlack(message.summary)}`,
    unfurl_links: false,
    unfurl_media: false,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          verbatim: true,
          text:
            `*${escapeSlack(message.subject)}*\n${escapeSlack(message.summary)}\n` +
            `<${message.link}|${escapeSlack(message.linkText)}>`,
        },
      },
      { type: 'context', elements: [{ type: 'mrkdwn', verbatim: true, text: details }] },
    ],
  };
}

/**
 * Backslash-escape the characters that start Markdown links, images, emphasis,
 * code, tables, and raw HTML, so a value is shown as typed.
 */
function escapeMarkdown(value: string): string {
  return value.replace(/[\\`*_~[\]()<>|!#&]/g, '\\$&');
}

/**
 * An Amazon Chime incoming webhook payload. A `/md` prefix makes Chime render
 * the content as Markdown, so how it is shown does not depend on what the
 * values in it look like, and every value is escaped for it.
 */
export function formatChime(message: Message): Record<string, unknown> {
  // Parentheses would end the link's destination early.
  const link = message.link.replace(/\(/g, '%28').replace(/\)/g, '%29');
  const paragraphs = [
    `**${escapeMarkdown(message.subject)}**`,
    escapeMarkdown(message.summary),
    `[${escapeMarkdown(message.linkText)}](${link})`,
    message.details
      .map(([label, value]) => `${escapeMarkdown(label)}: ${escapeMarkdown(value)}`)
      .join(', '),
  ];
  return { Content: `/md ${paragraphs.join('\n\n')}` };
}
