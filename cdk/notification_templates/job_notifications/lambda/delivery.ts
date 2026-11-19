// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.

// Deciding where a notification goes, and delivering it exactly once per
// destination even when EventBridge delivers the same event more than once.

import { createHash } from 'node:crypto';

import { describeError, isPermanent } from './errors';
import { EmailContent, Message, formatChime, formatEmail, formatSlack } from './format';
import { Logger, redactEmail } from './log';
import { channelsFor } from './preferences';
import { Recipient } from './recipients';
import { Channel, NotificationKind } from './types';
import { validateWebhookUrl } from './webhooks';

export type DeliveryTarget =
  | { readonly channel: 'EMAIL'; readonly address: string }
  | { readonly channel: 'SLACK' | 'CHIME'; readonly secretArn: string };

export interface PlannedDelivery {
  readonly principalId: string;
  readonly target: DeliveryTarget;
}

export interface Skipped {
  readonly principalId: string;
  readonly channel: Channel;
  readonly reason: string;
}

export interface PlanOptions {
  /** Whether a sender address is configured. Without one, email is skipped. */
  readonly emailConfigured: boolean;
  /** The ARN prefix every webhook secret must start with. */
  readonly webhookSecretArnPrefix: string;
}

function targetKey(target: DeliveryTarget): string {
  return target.channel === 'EMAIL'
    ? `EMAIL:${target.address.toLowerCase()}`
    : `${target.channel}:${target.secretArn}`;
}

/**
 * Work out every destination for a notification, at most once each.
 *
 * Two recipients who share a destination, such as a person who is both the
 * job's submitter and one of its approvers, or two people whose preferences
 * point at the same team channel, get one message there rather than two.
 */
export function planDeliveries(
  recipients: readonly Recipient[],
  kind: NotificationKind,
  options: PlanOptions,
): { deliveries: PlannedDelivery[]; skipped: Skipped[] } {
  const deliveries = new Map<string, PlannedDelivery>();
  const skipped: Skipped[] = [];

  for (const recipient of recipients) {
    const { principalId, preferences } = recipient;
    for (const channel of channelsFor(recipient.type, preferences, kind)) {
      let target: DeliveryTarget | undefined;
      let reason: string | undefined;
      if (channel === 'EMAIL') {
        if (!options.emailConfigured) reason = 'EmailNotConfigured';
        else if (!recipient.email) reason = 'NoEmailAddress';
        else target = { channel, address: recipient.email };
      } else {
        const secretArn =
          channel === 'SLACK'
            ? preferences?.slackWebhookSecretArn
            : preferences?.chimeWebhookSecretArn;
        if (!secretArn) reason = 'NoWebhookSecret';
        else if (!secretArn.startsWith(options.webhookSecretArnPrefix))
          reason = 'WebhookSecretOutsidePrefix';
        else target = { channel, secretArn };
      }
      if (target) {
        const key = targetKey(target);
        if (!deliveries.has(key)) deliveries.set(key, { principalId, target });
      } else {
        skipped.push({ principalId, channel, reason: reason! });
      }
    }
  }
  return { deliveries: [...deliveries.values()], skipped };
}

/**
 * The idempotency key for one delivery: the same EventBridge event to the same
 * destination always maps to the same key. It is a hash so the delivery table
 * holds no email addresses.
 */
export function deliveryKey(eventId: string, target: DeliveryTarget): string {
  return createHash('sha256').update(`${eventId}\n${targetKey(target)}`).digest('hex');
}

/**
 * The result of claiming a delivery:
 *
 * - `CLAIMED`: this invocation owns the delivery and should make it.
 * - `DONE`: it was already sent, or already failed permanently.
 * - `IN_PROGRESS`: another invocation claimed it recently and may still be
 *   making it. This invocation backs off and lets the Lambda retry check again,
 *   by which time the claim is either done or old enough to take over.
 */
export type ClaimResult = 'CLAIMED' | 'DONE' | 'IN_PROGRESS';

/** Records which deliveries have been made, for detecting redelivered events. */
export interface DeliveryLedger {
  claim(key: string, eventId: string, channel: Channel): Promise<ClaimResult>;
  complete(key: string, status: 'SENT' | 'FAILED', reason?: string): Promise<void>;
  /** Give up a claim after a transient failure, so a retry can make the delivery. */
  release(key: string): Promise<void>;
}

/** The ways a message leaves the function. */
export interface Transport {
  sendEmail(to: string, content: EmailContent): Promise<void>;
  /** The webhook URL held in a secret. */
  webhookUrl(secretArn: string): Promise<string>;
  postWebhook(url: URL, payload: Record<string, unknown>): Promise<void>;
}

export type DeliveryStatus = 'SENT' | 'DUPLICATE' | 'FAILED' | 'RETRY';

export interface DeliveryOutcome {
  readonly delivery: PlannedDelivery;
  readonly status: DeliveryStatus;
  readonly reason?: string;
}

export interface DeliverOptions {
  readonly eventId: string;
  readonly message: Message;
  readonly ledger: DeliveryLedger;
  readonly transport: Transport;
  readonly log: Logger;
  readonly concurrency?: number;
}

async function send(delivery: PlannedDelivery, options: DeliverOptions): Promise<void> {
  const { target } = delivery;
  if (target.channel === 'EMAIL') {
    await options.transport.sendEmail(target.address, formatEmail(options.message));
    return;
  }
  const url = validateWebhookUrl(target.channel, await options.transport.webhookUrl(target.secretArn));
  const payload =
    target.channel === 'SLACK' ? formatSlack(options.message) : formatChime(options.message);
  await options.transport.postWebhook(url, payload);
}

async function deliverOne(
  delivery: PlannedDelivery,
  options: DeliverOptions,
): Promise<DeliveryOutcome> {
  const { target } = delivery;
  const key = deliveryKey(options.eventId, target);
  const logFields = {
    eventId: options.eventId,
    principalId: delivery.principalId,
    channel: target.channel,
    destination: target.channel === 'EMAIL' ? redactEmail(target.address) : target.secretArn,
    deliveryKey: key,
  };

  let claim: ClaimResult;
  try {
    claim = await options.ledger.claim(key, options.eventId, target.channel);
  } catch (error) {
    const reason = describeError(error);
    options.log.warn('Could not claim delivery; it will be retried', { ...logFields, reason });
    return { delivery, status: 'RETRY', reason };
  }
  if (claim === 'DONE') {
    options.log.info('Already delivered for this event; skipping', logFields);
    return { delivery, status: 'DUPLICATE' };
  }
  if (claim === 'IN_PROGRESS') {
    options.log.info('Delivery claimed by another invocation; it will be checked again', logFields);
    return { delivery, status: 'RETRY', reason: 'ClaimedElsewhere' };
  }

  options.log.info('Sending notification', logFields);
  try {
    await send(delivery, options);
  } catch (error) {
    const reason = describeError(error);
    if (isPermanent(error)) {
      options.log.error('Delivery failed permanently', { ...logFields, reason });
      await recordQuietly(() => options.ledger.complete(key, 'FAILED', reason), logFields, options);
      return { delivery, status: 'FAILED', reason };
    }
    options.log.warn('Delivery failed; it will be retried', { ...logFields, reason });
    await recordQuietly(() => options.ledger.release(key), logFields, options);
    return { delivery, status: 'RETRY', reason };
  }
  // The message is out. Failing to record that must not fail the invocation,
  // since a retry would send it again; an unrecorded claim simply expires.
  await recordQuietly(() => options.ledger.complete(key, 'SENT'), logFields, options);
  options.log.info('Notification sent', logFields);
  return { delivery, status: 'SENT' };
}

async function recordQuietly(
  record: () => Promise<void>,
  logFields: Record<string, unknown>,
  options: DeliverOptions,
): Promise<void> {
  try {
    await record();
  } catch (error) {
    options.log.warn('Could not update the delivery record', {
      ...logFields,
      reason: describeError(error),
    });
  }
}

/** Deliver to every destination, a few at a time. */
export async function deliverAll(
  deliveries: readonly PlannedDelivery[],
  options: DeliverOptions,
): Promise<DeliveryOutcome[]> {
  const outcomes: DeliveryOutcome[] = new Array(deliveries.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < deliveries.length) {
      const index = next++;
      outcomes[index] = await deliverOne(deliveries[index], options);
    }
  };
  const workers = Math.max(1, Math.min(options.concurrency ?? 5, deliveries.length));
  await Promise.all(Array.from({ length: workers }, worker));
  return outcomes;
}
