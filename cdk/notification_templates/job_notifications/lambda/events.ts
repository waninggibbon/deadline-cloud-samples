// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.

// Turns a Deadline Cloud EventBridge event into a trigger: what happened, to
// which resources, and who should hear about it.
//
// The status change events are documented in the Deadline Cloud events detail
// reference:
// https://docs.aws.amazon.com/deadline-cloud/latest/developerguide/events-detail-reference.html

import { parseApprovalEvent } from './approval-events';
import { PermanentError } from './errors';
import { ApprovalDecision, NotificationKind, Principal, ResourceIds } from './types';

export const DETAIL_TYPES = {
  jobRunStatusChange: 'Job Run Status Change',
  stepRunStatusChange: 'Step Run Status Change',
  taskRunStatusChange: 'Task Run Status Change',
  stepApprovalRequested: 'Step Approval Requested',
  stepApprovalDecided: 'Step Approval Decided',
} as const;

/** The parts of an EventBridge event envelope the function reads. */
export interface DeadlineEvent {
  readonly id: string;
  readonly 'detail-type': string;
  readonly source: string;
  readonly account: string;
  readonly region: string;
  readonly time: string;
  readonly detail: Record<string, unknown>;
}

/** A failure, addressed to whoever submitted the job. */
export interface FailureTrigger {
  readonly kind: Extract<NotificationKind, 'JOB_FAILED' | 'STEP_FAILED' | 'TASK_FAILED'>;
  readonly ids: ResourceIds;
}

/** A step waiting for approval, addressed to the people who can approve it. */
export interface ApprovalRequestedTrigger {
  readonly kind: 'APPROVAL_REQUESTED';
  readonly ids: ResourceIds;
  readonly approvers: readonly Principal[];
}

/**
 * A recorded approval decision, addressed to the job's submitter and, when the
 * stack is configured to, the approvers.
 */
export interface ApprovalDecidedTrigger {
  readonly kind: 'APPROVAL_DECIDED';
  readonly ids: ResourceIds;
  readonly decision: ApprovalDecision;
  readonly approvers: readonly Principal[];
  /** Set when the event names the job's submitter, saving a GetJob call. */
  readonly jobOwner?: Principal;
}

export type Trigger = FailureTrigger | ApprovalRequestedTrigger | ApprovalDecidedTrigger;

/** Read a string field from an event detail, or fail the event as malformed. */
export function stringField(detail: Record<string, unknown>, name: string): string {
  const value = detail[name];
  if (typeof value !== 'string' || value === '') {
    throw new PermanentError(`Event detail is missing ${name}.`, 'MalformedEvent');
  }
  return value;
}

/** Read an optional string field from an event detail. */
export function optionalStringField(
  detail: Record<string, unknown>,
  name: string,
): string | undefined {
  const value = detail[name];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/**
 * The trigger for an event, or `undefined` for an event this function does not
 * notify about, such as a status change to anything other than `FAILED`.
 *
 * The EventBridge rules only forward the events the stack is configured for,
 * so `undefined` means the rules and this function disagree, which is logged
 * rather than treated as an error.
 */
export function parseEvent(event: DeadlineEvent): Trigger | undefined {
  const detail = event.detail ?? {};
  switch (event['detail-type']) {
    case DETAIL_TYPES.jobRunStatusChange:
      if (detail.taskRunStatus !== 'FAILED') return undefined;
      return {
        kind: 'JOB_FAILED',
        ids: {
          farmId: stringField(detail, 'farmId'),
          queueId: stringField(detail, 'queueId'),
          jobId: stringField(detail, 'jobId'),
        },
      };
    case DETAIL_TYPES.stepRunStatusChange:
      if (detail.taskRunStatus !== 'FAILED') return undefined;
      return {
        kind: 'STEP_FAILED',
        ids: {
          farmId: stringField(detail, 'farmId'),
          queueId: stringField(detail, 'queueId'),
          jobId: stringField(detail, 'jobId'),
          stepId: stringField(detail, 'stepId'),
        },
      };
    case DETAIL_TYPES.taskRunStatusChange:
      if (detail.runStatus !== 'FAILED') return undefined;
      return {
        kind: 'TASK_FAILED',
        ids: {
          farmId: stringField(detail, 'farmId'),
          queueId: stringField(detail, 'queueId'),
          jobId: stringField(detail, 'jobId'),
          stepId: stringField(detail, 'stepId'),
          taskId: stringField(detail, 'taskId'),
        },
      };
    case DETAIL_TYPES.stepApprovalRequested:
    case DETAIL_TYPES.stepApprovalDecided:
      return parseApprovalEvent(event['detail-type'], detail);
    default:
      return undefined;
  }
}

/**
 * The principal a job's `createdBy` names.
 *
 * Deadline Cloud records either an IAM principal ARN or an IAM Identity Center
 * user ID there, depending on how the job was submitted.
 */
export function principalFromCreatedBy(createdBy: string): Principal {
  return createdBy.startsWith('arn:')
    ? { type: 'IAM', id: createdBy }
    : { type: 'USER', id: createdBy };
}
