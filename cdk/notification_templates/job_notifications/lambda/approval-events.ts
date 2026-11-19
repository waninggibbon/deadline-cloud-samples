// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.

// Step approval events. PROVISIONAL: replaced once the event schema is final.

import type { ApprovalDecidedTrigger, ApprovalRequestedTrigger } from './events';

export function parseApprovalEvent(
  _detailType: string,
  _detail: Record<string, unknown>,
): ApprovalRequestedTrigger | ApprovalDecidedTrigger | undefined {
  return undefined;
}
