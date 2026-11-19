// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.

// Posting to Slack and Amazon Chime incoming webhooks.

import { PermanentError } from './errors';
import { Channel } from './types';

/**
 * The hosts a webhook secret may point at, per channel.
 *
 * The function only ever posts to these. A secret holding any other URL is
 * refused, so a mistaken or tampered secret cannot turn the function into a
 * way to send requests to arbitrary hosts.
 */
export const WEBHOOK_HOSTS: Record<Exclude<Channel, 'EMAIL'>, readonly string[]> = {
  SLACK: ['hooks.slack.com', 'hooks.slack-gov.com'],
  CHIME: ['hooks.chime.aws'],
};

/** Parse and check a webhook URL read from a secret. */
export function validateWebhookUrl(channel: Exclude<Channel, 'EMAIL'>, value: string): URL {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new PermanentError('Webhook secret does not hold a URL.', 'InvalidWebhookUrl');
  }
  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.port !== '' ||
    !WEBHOOK_HOSTS[channel].includes(url.hostname)
  ) {
    throw new PermanentError(
      `Webhook URL is not an allowed ${channel} webhook host.`,
      'WebhookHostNotAllowed',
    );
  }
  return url;
}

export type FetchLike = (url: URL, init: RequestInit) => Promise<Response>;

/**
 * POST a JSON payload to a webhook.
 *
 * A 4xx response other than 429 means the webhook was revoked or the payload
 * was refused, which retrying will not fix. Anything else that is not a 2xx,
 * and any network error, is left to the Lambda retry.
 */
export async function postWebhook(
  url: URL,
  payload: Record<string, unknown>,
  fetchImpl: FetchLike = fetch,
): Promise<void> {
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    // A webhook host redirecting elsewhere is not something to follow.
    redirect: 'error',
    signal: AbortSignal.timeout(5000),
  });
  if (response.ok) {
    return;
  }
  if (response.status >= 400 && response.status < 500 && response.status !== 429) {
    throw new PermanentError(
      `Webhook refused the message with HTTP ${response.status}.`,
      `WebhookHttp${response.status}`,
    );
  }
  throw new Error(`Webhook returned HTTP ${response.status}.`);
}
