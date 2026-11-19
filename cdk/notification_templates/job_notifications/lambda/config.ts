// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.

// The function's configuration, read once from the environment variables the
// stack sets. Every value here comes from a stack parameter or prop, so see
// lib/job-notifications-stack.ts for what each one means.

export type MessageDetail = 'MINIMAL' | 'NAMES';

export interface Config {
  readonly preferencesTableName: string;
  readonly deliveryTableName: string;
  /** The base URL of Deadline Cloud monitor, without a trailing slash. */
  readonly monitorUrl: string;
  /** Unset when the stack was deployed without an Identity Center identity store. */
  readonly identityStoreId?: string;
  readonly identityStoreRegion: string;
  /** Unset when email is not configured, in which case the email channel is skipped. */
  readonly senderEmailAddress?: string;
  readonly messageDetail: MessageDetail;
  readonly notifyApproversOfDecision: boolean;
  /**
   * The ARN prefix every webhook secret must start with. The function's IAM
   * policy enforces the same prefix; checking it here as well gives a clear log
   * message rather than an AccessDenied.
   */
  readonly webhookSecretArnPrefix: string;
  /** A Deadline Cloud API endpoint override, for a pre-release stage. */
  readonly deadlineEndpointUrl?: string;
  /**
   * How long a claimed delivery stays claimed before another invocation may
   * take it over. It must exceed the function timeout, so a delivery is only
   * taken over once the invocation that claimed it can no longer be running.
   */
  readonly claimTimeoutSeconds: number;
  /** How long delivery records are kept for detecting EventBridge redelivery. */
  readonly deliveryRecordTtlSeconds: number;
  /** The most members of one group that are notified, as a guard against fan-out. */
  readonly maxGroupMembers: number;
}

function optional(value: string | undefined): string | undefined {
  return value && value.trim() !== '' ? value.trim() : undefined;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = optional(env[name]);
  if (!value) {
    throw new Error(`Environment variable ${name} is not set.`);
  }
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const region = required(env, 'AWS_REGION');
  return {
    preferencesTableName: required(env, 'PREFERENCES_TABLE_NAME'),
    deliveryTableName: required(env, 'DELIVERY_TABLE_NAME'),
    monitorUrl: required(env, 'MONITOR_URL').replace(/\/+$/, ''),
    identityStoreId: optional(env.IDENTITY_STORE_ID),
    identityStoreRegion: optional(env.IDENTITY_STORE_REGION) ?? region,
    senderEmailAddress: optional(env.SENDER_EMAIL_ADDRESS),
    messageDetail: env.MESSAGE_DETAIL === 'NAMES' ? 'NAMES' : 'MINIMAL',
    notifyApproversOfDecision: env.NOTIFY_APPROVERS_OF_DECISION === 'true',
    webhookSecretArnPrefix: required(env, 'WEBHOOK_SECRET_ARN_PREFIX'),
    deadlineEndpointUrl: optional(env.DEADLINE_ENDPOINT_URL),
    claimTimeoutSeconds: Number(env.CLAIM_TIMEOUT_SECONDS ?? '90'),
    deliveryRecordTtlSeconds: Number(env.DELIVERY_RECORD_TTL_SECONDS ?? String(3 * 24 * 3600)),
    maxGroupMembers: Number(env.MAX_GROUP_MEMBERS ?? '100'),
  };
}
