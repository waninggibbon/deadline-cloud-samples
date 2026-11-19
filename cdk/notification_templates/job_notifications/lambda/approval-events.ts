// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.

// Step approval events.
//
// `Step Approval Requested` is published when a gated step opens an approval
// request, and `Step Approval Decided` when the request is approved, rejected,
// or expires. Both carry IDs and statuses only, never the approval message,
// its links, a comment, or any names:
//
//   {
//     "farmId": "farm-...", "queueId": "queue-...", "jobId": "job-...", "stepId": "step-...",
//     "approvalRequestId": "approvalrequest-...", "requestNumber": 1, "approvalOnly": true,
//     "approvalStatus": "WAITING",                         // Requested
//     "previousApprovalStatus": "WAITING",                 // Decided, with approvalStatus
//     "approvalStatus": "APPROVED|REJECTED|EXPIRED",       //   one of these
//     "requestedAt": "...", "expiresAt": "...", "decidedAt": "...",
//     "decidedBy": "...",                                  // Decided, absent for EXPIRED
//     "jobCreatedBy": "...",                               // the job's createdBy
//     "approvers": [{ "principalType": "USER|GROUP", "principalId": "...", "identityStoreId": "d-..." }]
//   }

import type { ApprovalDecidedTrigger, ApprovalRequestedTrigger } from './events';
import { PermanentError } from './errors';
import { DETAIL_TYPES, optionalStringField, principalFromCreatedBy, stringField } from './fields';
import { ApprovalDecision, Principal } from './types';

const APPROVAL_REQUEST_ID = /^approvalrequest-[0-9a-f]{32}$/;
/** An IAM Identity Center user or group ID. */
const IDENTITY_CENTER_ID =
  /^([0-9a-f]{10}-|)[A-Fa-f0-9]{8}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{12}$/;
const IDENTITY_STORE_ID = /^d-[0-9a-f]{10}$|^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DECISIONS: readonly ApprovalDecision[] = ['APPROVED', 'REJECTED', 'EXPIRED'];

/**
 * The approvers named in an event. An entry that is not a well-formed Identity
 * Center user or group is dropped rather than failing the event, so one bad
 * entry in a queue's configuration does not silence the others.
 */
export function parseApprovers(value: unknown): Principal[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): Principal[] => {
    if (!entry || typeof entry !== 'object') return [];
    const { principalType, principalId, identityStoreId } = entry as Record<string, unknown>;
    if (
      (principalType !== 'USER' && principalType !== 'GROUP') ||
      typeof principalId !== 'string' ||
      !IDENTITY_CENTER_ID.test(principalId)
    ) {
      return [];
    }
    return [
      {
        type: principalType,
        id: principalId,
        identityStoreId:
          typeof identityStoreId === 'string' && IDENTITY_STORE_ID.test(identityStoreId)
            ? identityStoreId
            : undefined,
      },
    ];
  });
}

function approvalIds(detail: Record<string, unknown>) {
  const approvalRequestId = stringField(detail, 'approvalRequestId');
  if (!APPROVAL_REQUEST_ID.test(approvalRequestId)) {
    throw new PermanentError('Malformed approvalRequestId in event.', 'MalformedEvent');
  }
  return {
    farmId: stringField(detail, 'farmId'),
    queueId: stringField(detail, 'queueId'),
    jobId: stringField(detail, 'jobId'),
    stepId: stringField(detail, 'stepId'),
    approvalRequestId,
  };
}

export function parseApprovalEvent(
  detailType: string,
  detail: Record<string, unknown>,
): ApprovalRequestedTrigger | ApprovalDecidedTrigger | undefined {
  const jobCreatedBy = optionalStringField(detail, 'jobCreatedBy');
  const jobOwner = jobCreatedBy ? principalFromCreatedBy(jobCreatedBy) : undefined;

  if (detailType === DETAIL_TYPES.stepApprovalRequested) {
    if (detail.approvalStatus !== 'WAITING') return undefined;
    return {
      kind: 'APPROVAL_REQUESTED',
      ids: approvalIds(detail),
      approvers: parseApprovers(detail.approvers),
      jobOwner,
    };
  }

  if (detailType === DETAIL_TYPES.stepApprovalDecided) {
    const decision = detail.approvalStatus as ApprovalDecision;
    if (!DECISIONS.includes(decision)) return undefined;
    const decidedBy = optionalStringField(detail, 'decidedBy');
    return {
      kind: 'APPROVAL_DECIDED',
      ids: approvalIds(detail),
      decision,
      approvers: parseApprovers(detail.approvers),
      jobOwner,
      decidedBy,
    };
  }

  return undefined;
}
