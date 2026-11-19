// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.

// Reading fields from Deadline Cloud event details.

import { PermanentError } from './errors';
import { Principal } from './types';

export const DETAIL_TYPES = {
  jobRunStatusChange: 'Job Run Status Change',
  stepRunStatusChange: 'Step Run Status Change',
  taskRunStatusChange: 'Task Run Status Change',
  stepApprovalRequested: 'Step Approval Requested',
  stepApprovalDecided: 'Step Approval Decided',
} as const;

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
