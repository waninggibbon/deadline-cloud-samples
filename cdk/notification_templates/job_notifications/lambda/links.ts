// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.

// Deep links into Deadline Cloud monitor.
//
// Every message links to the page where the person can see what happened, and
// for an approval, record their decision. The page requires them to sign in,
// so the link itself grants nothing: it is the same URL they would reach by
// clicking through monitor, and holding it is not enough to approve anything.

import { PermanentError } from './errors';
import { ResourceIds } from './types';

const ID_PATTERNS: Record<keyof ResourceIds, RegExp> = {
  farmId: /^farm-[0-9a-f]{32}$/,
  queueId: /^queue-[0-9a-f]{32}$/,
  jobId: /^job-[0-9a-f]{32}$/,
  stepId: /^step-[0-9a-f]{32}$/,
  taskId: /^task-[0-9a-f]{32}-[0-9]+$/,
};

const REGION_PATTERN = /^[a-z]{2}(-[a-z]+)+-[0-9]+$/;

/**
 * Check that every ID in an event is a well-formed Deadline Cloud ID.
 *
 * The IDs end up in a URL path and in message text, so anything else is
 * rejected rather than escaped: an event carrying a malformed ID did not come
 * from Deadline Cloud.
 */
export function validateIds(ids: ResourceIds, region: string): void {
  if (!REGION_PATTERN.test(region)) {
    throw new PermanentError(`Malformed region in event.`, 'MalformedEvent');
  }
  for (const [key, pattern] of Object.entries(ID_PATTERNS) as [keyof ResourceIds, RegExp][]) {
    const value = ids[key];
    const isRequired = key === 'farmId' || key === 'queueId' || key === 'jobId';
    if (value === undefined && !isRequired) {
      continue;
    }
    if (typeof value !== 'string' || !pattern.test(value)) {
      throw new PermanentError(`Malformed ${key} in event.`, 'MalformedEvent');
    }
  }
  if (ids.taskId && !ids.stepId) {
    throw new PermanentError('A taskId needs a stepId.', 'MalformedEvent');
  }
}

/**
 * The monitor page for a job, step, or task.
 *
 * Monitor's queue page opens the job, step, and task named in its query string
 * (`/{region}/farms/{farmId}/queues/{queueId}?jobId=...&stepId=...&taskId=...`),
 * the same URL monitor itself builds when you select them.
 */
export function monitorLink(monitorUrl: string, region: string, ids: ResourceIds): string {
  const url = new URL(
    `${monitorUrl.replace(/\/+$/, '')}/${region}/farms/${ids.farmId}/queues/${ids.queueId}`,
  );
  url.searchParams.set('jobId', ids.jobId);
  if (ids.stepId) {
    url.searchParams.set('stepId', ids.stepId);
    if (ids.taskId) {
      url.searchParams.set('taskId', ids.taskId);
    }
  }
  return url.toString();
}
