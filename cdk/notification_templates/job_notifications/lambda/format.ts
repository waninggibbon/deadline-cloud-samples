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
      subject = decision === 'REJECTED' ? 'Step rejected' : 'Step approved';
      summary =
        decision === 'REJECTED'
          ? 'A step waiting for approval in an AWS Deadline Cloud job was rejected.'
          : 'A step waiting for approval in an AWS Deadline Cloud job was approved.';
      break;
  }

  const details: [string, string][] = [];
  if (notification.jobName) details.push(['Job', notification.jobName]);
  if (notification.stepName) details.push(['Step', notification.stepName]);
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

/** Slack's mrkdwn treats these three characters as control characters. */
function escapeSlack(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * A Slack incoming webhook payload: text blocks only, with no buttons or other
 * interactive elements, and link unfurling off so Slack does not try to fetch
 * the monitor page.
 */
export function formatSlack(message: Message): Record<string, unknown> {
  const details = message.details
    .map(([label, value]) => `${escapeSlack(label)}: \`${escapeSlack(value)}\``)
    .join('  |  ');
  return {
    text: `${message.subject}: ${message.summary}`,
    unfurl_links: false,
    unfurl_media: false,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text:
            `*${escapeSlack(message.subject)}*\n${escapeSlack(message.summary)}\n` +
            `<${message.link}|${escapeSlack(message.linkText)}>`,
        },
      },
      { type: 'context', elements: [{ type: 'mrkdwn', text: details }] },
    ],
  };
}

/** An Amazon Chime incoming webhook payload, as plain text. */
export function formatChime(message: Message): Record<string, unknown> {
  const lines = [
    message.subject,
    message.summary,
    `${message.linkText}: ${message.link}`,
    message.details.map(([label, value]) => `${label}: ${value}`).join(', '),
  ];
  return { Content: lines.join('\n') };
}
