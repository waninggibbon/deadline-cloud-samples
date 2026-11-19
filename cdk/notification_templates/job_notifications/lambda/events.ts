// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.

// Turns a Deadline Cloud EventBridge event into a trigger: what happened, to
// which resources, and who should hear about it.
//
// The status change events are documented in the Deadline Cloud events detail
// reference:
// https://docs.aws.amazon.com/deadline-cloud/latest/developerguide/events-detail-reference.html

import { parseApprovalEvent } from './approval-events';
import { DETAIL_TYPES, stringField } from './fields';
import { ApprovalDecision, NotificationKind, Principal, ResourceIds } from './types';

export { DETAIL_TYPES, optionalStringField, principalFromCreatedBy, stringField } from './fields';

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
  /** The job's submitter, from the event. Only used for MessageDetail=NAMES lookups. */
  readonly jobOwner?: Principal;
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
  /**
   * Who recorded the decision, in the same form as a job's `createdBy`. Absent
   * when the request expired. They are not notified of their own decision.
   */
  readonly decidedBy?: string;
}

export type Trigger = FailureTrigger | ApprovalRequestedTrigger | ApprovalDecidedTrigger;

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
