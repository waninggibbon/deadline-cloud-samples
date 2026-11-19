// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.

// Per-person notification preferences, stored one item per principal in the
// preferences DynamoDB table. scripts/preferences.ts writes them.
//
// An item looks like this:
//
//   {
//     "principalId": "906742a1b2-1234abcd-...",        // partition key
//     "channels": ["EMAIL", "SLACK"],
//     "email": "alex@example.com",                      // optional override
//     "slackWebhookSecretArn": "arn:aws:secretsmanager:...",
//     "chimeWebhookSecretArn": "arn:aws:secretsmanager:...",
//     "mutedNotifications": ["TASK_FAILED"]
//   }
//
// Webhook URLs are never stored in the table, only the ARN of the Secrets
// Manager secret that holds one, because a webhook URL is itself the
// credential that lets anyone post to the channel.

import { CHANNELS, Channel, NOTIFICATION_KINDS, NotificationKind, PrincipalType } from './types';

export interface Preferences {
  readonly principalId: string;
  /** The channels to deliver on. Unset means the default for the principal's type. */
  readonly channels?: readonly Channel[];
  /** An email address to use instead of the one in IAM Identity Center. */
  readonly email?: string;
  readonly slackWebhookSecretArn?: string;
  readonly chimeWebhookSecretArn?: string;
  readonly mutedNotifications: readonly NotificationKind[];
}

/**
 * The channels a principal with no preferences, or with preferences that do
 * not name any channels, is notified on.
 *
 * An Identity Center user has an email address in the identity store, so they
 * get email by default. An IAM principal only has whatever its preferences say.
 * A group's own preferences reach a team channel; with no preferences, the
 * group is only expanded to its members.
 */
export const DEFAULT_CHANNELS: Record<PrincipalType, readonly Channel[]> = {
  USER: ['EMAIL'],
  IAM: ['EMAIL'],
  GROUP: [],
};

function stringList(value: unknown): string[] {
  if (value instanceof Set) {
    return [...value].filter((item): item is string => typeof item === 'string');
  }
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === 'string');
  }
  return [];
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

/**
 * Read a preferences item defensively. Anything unrecognized is dropped, so a
 * hand-edited item with a typo in a channel name narrows delivery rather than
 * failing it.
 */
export function parsePreferences(item: Record<string, unknown>): Preferences {
  const channels =
    item.channels === undefined
      ? undefined
      : stringList(item.channels).filter((c): c is Channel =>
          (CHANNELS as readonly string[]).includes(c),
        );
  return {
    principalId: String(item.principalId),
    channels,
    email: optionalString(item.email),
    slackWebhookSecretArn: optionalString(item.slackWebhookSecretArn),
    chimeWebhookSecretArn: optionalString(item.chimeWebhookSecretArn),
    mutedNotifications: stringList(item.mutedNotifications).filter(
      (kind): kind is NotificationKind => (NOTIFICATION_KINDS as readonly string[]).includes(kind),
    ),
  };
}

/** The channels to notify a principal on for one kind of notification. */
export function channelsFor(
  type: PrincipalType,
  preferences: Preferences | undefined,
  kind: NotificationKind,
): readonly Channel[] {
  if (preferences?.mutedNotifications.includes(kind)) {
    return [];
  }
  return preferences?.channels ?? DEFAULT_CHANNELS[type];
}
