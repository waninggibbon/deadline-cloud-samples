// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.

// Types shared by every part of the notification function.

/** The channels a notification can be delivered on. */
export const CHANNELS = ['EMAIL', 'SLACK', 'CHIME'] as const;
export type Channel = (typeof CHANNELS)[number];

/**
 * The kinds of notification the function sends. A person can mute any of them
 * in their preferences.
 */
export const NOTIFICATION_KINDS = [
  'JOB_FAILED',
  'STEP_FAILED',
  'TASK_FAILED',
  'APPROVAL_REQUESTED',
  'APPROVAL_DECIDED',
] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

/**
 * Someone a notification is addressed to, before they are resolved to an email
 * address or webhook.
 *
 * - `USER` is an IAM Identity Center user ID, which is what a job's `createdBy`
 *   holds when it was submitted by someone signed in to Deadline Cloud monitor.
 * - `GROUP` is an IAM Identity Center group ID, which is expanded to its members.
 * - `IAM` is an IAM principal ARN, which is what `createdBy` holds when a job was
 *   submitted with IAM credentials. It has no email address of its own, so it is
 *   only notified when it has preferences.
 */
export type PrincipalType = 'USER' | 'GROUP' | 'IAM';

export interface Principal {
  readonly type: PrincipalType;
  readonly id: string;
}

/** The Deadline Cloud resources a notification is about. */
export interface ResourceIds {
  readonly farmId: string;
  readonly queueId: string;
  readonly jobId: string;
  readonly stepId?: string;
  readonly taskId?: string;
}

/** The outcome of a step approval. */
export type ApprovalDecision = 'APPROVED' | 'REJECTED';

/** One notification, ready to be addressed and delivered. */
export interface Notification {
  readonly kind: NotificationKind;
  /**
   * The ID of the EventBridge event this notification came from. EventBridge
   * delivers at least once, so the same ID can arrive more than once; deliveries
   * are made idempotent on it.
   */
  readonly eventId: string;
  readonly region: string;
  readonly ids: ResourceIds;
  /** The Deadline Cloud monitor page the message links to. */
  readonly link: string;
  /** Who the notification is for. */
  readonly audience: readonly Principal[];
  readonly decision?: ApprovalDecision;
  /** Only set when the stack's `MessageDetail` parameter is `NAMES`. */
  readonly jobName?: string;
  /** Only set when the stack's `MessageDetail` parameter is `NAMES`. */
  readonly stepName?: string;
}
