// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.

// The whole flow for one event: parse it, work out who it is for, resolve them
// to destinations, and deliver. Every AWS call goes through the interfaces in
// `Dependencies`, so the unit tests can run all of it against fakes.

import { Config } from './config';
import { DeliveryLedger, DeliveryStatus, Transport, deliverAll, planDeliveries } from './delivery';
import { isPermanent } from './errors';
import { DeadlineEvent, Trigger, parseEvent, principalFromCreatedBy } from './events';
import { composeMessage } from './format';
import { monitorLink, validateIds } from './links';
import { Logger } from './log';
import { IdentityDirectory, PreferencesStore, resolveRecipients } from './recipients';
import { Notification, Principal, ResourceIds } from './types';

/** Deadline Cloud lookups. */
export interface JobDirectory {
  /** The job's submitter and name. Throws a `PermanentError` for a job that cannot be read. */
  getJob(ids: ResourceIds): Promise<{ createdBy: string; name?: string }>;
  getStepName(ids: ResourceIds): Promise<string | undefined>;
}

export interface Dependencies {
  readonly jobs: JobDirectory;
  readonly identity: IdentityDirectory;
  readonly preferences: PreferencesStore;
  readonly ledger: DeliveryLedger;
  readonly transport: Transport;
  readonly log: Logger;
}

export interface Summary {
  readonly eventId: string;
  readonly detailType: string;
  readonly kind?: string;
  readonly ignoredReason?: string;
  readonly recipients: number;
  readonly unresolved: number;
  readonly skipped: number;
  readonly outcomes: Record<DeliveryStatus, number>;
}

/** Thrown when some deliveries failed transiently, so Lambda retries the event. */
export class RetryableDeliveryError extends Error {
  constructor(public readonly summary: Summary) {
    super(`${summary.outcomes.RETRY} deliveries failed transiently and will be retried.`);
    this.name = 'RetryableDeliveryError';
  }
}

function emptyOutcomes(): Record<DeliveryStatus, number> {
  return { SENT: 0, DUPLICATE: 0, FAILED: 0, RETRY: 0 };
}

async function audienceFor(
  trigger: Trigger,
  config: Config,
  jobOwner: () => Promise<Principal>,
): Promise<Principal[]> {
  switch (trigger.kind) {
    case 'JOB_FAILED':
    case 'STEP_FAILED':
    case 'TASK_FAILED':
      return [await jobOwner()];
    case 'APPROVAL_REQUESTED':
      return [...trigger.approvers];
    case 'APPROVAL_DECIDED':
      return [
        trigger.jobOwner ?? (await jobOwner()),
        ...(config.notifyApproversOfDecision ? trigger.approvers : []),
      ];
  }
}

export async function handleEvent(
  event: DeadlineEvent,
  config: Config,
  deps: Dependencies,
): Promise<Summary> {
  const { log } = deps;
  const base = { eventId: event.id, detailType: event['detail-type'] };
  const ignored = (reason: string, kind?: string): Summary => {
    const summary = {
      ...base,
      kind,
      ignoredReason: reason,
      recipients: 0,
      unresolved: 0,
      skipped: 0,
      outcomes: emptyOutcomes(),
    };
    log.info('Event not notified', { ...summary });
    return summary;
  };

  let trigger: Trigger | undefined;
  try {
    trigger = parseEvent(event);
    if (trigger) validateIds(trigger.ids, event.region);
  } catch (error) {
    if (isPermanent(error)) return ignored(error.code);
    throw error;
  }
  if (!trigger) return ignored('NotANotifiableEvent');
  const { kind, ids } = trigger;

  // The job is read at most once, and only when something needs it: the
  // submitter for a failure or decision, or the names for MessageDetail=NAMES.
  let job: Promise<{ createdBy: string; name?: string }> | undefined;
  const getJob = () => (job ??= deps.jobs.getJob(ids));

  let audience: Principal[];
  let jobName: string | undefined;
  let stepName: string | undefined;
  try {
    audience = await audienceFor(trigger, config, async () =>
      principalFromCreatedBy((await getJob()).createdBy),
    );
    if (config.messageDetail === 'NAMES') {
      jobName = (await getJob()).name;
      stepName = ids.stepId ? await deps.jobs.getStepName(ids) : undefined;
    }
  } catch (error) {
    if (isPermanent(error)) {
      log.error('Could not read the job', { ...base, ...ids, reason: error.code });
      return ignored(error.code, kind);
    }
    throw error;
  }

  const notification: Notification = {
    kind,
    eventId: event.id,
    region: event.region,
    ids,
    link: monitorLink(config.monitorUrl, event.region, ids),
    audience,
    decision: trigger.kind === 'APPROVAL_DECIDED' ? trigger.decision : undefined,
    jobName,
    stepName,
  };

  const { recipients, unresolved } = await resolveRecipients(audience, {
    identity: deps.identity,
    preferences: deps.preferences,
    maxGroupMembers: config.maxGroupMembers,
    log,
  });
  for (const { principal, reason } of unresolved) {
    log.warn('Principal not notified', {
      ...base,
      principalType: principal.type,
      principalId: principal.id,
      reason,
    });
  }

  const { deliveries, skipped } = planDeliveries(recipients, kind, {
    emailConfigured: config.senderEmailAddress !== undefined,
    webhookSecretArnPrefix: config.webhookSecretArnPrefix,
  });
  for (const skip of skipped) {
    log.info('Channel skipped for recipient', { ...base, ...skip });
  }

  const outcomes = emptyOutcomes();
  const results = await deliverAll(deliveries, {
    eventId: event.id,
    message: composeMessage(notification),
    ledger: deps.ledger,
    transport: deps.transport,
    log,
  });
  for (const result of results) outcomes[result.status] += 1;

  const summary: Summary = {
    ...base,
    kind,
    recipients: recipients.length,
    unresolved: unresolved.length,
    skipped: skipped.length,
    outcomes,
  };
  log.info('Event processed', {
    ...summary,
    ...ids,
    audience: audience.map((principal) => `${principal.type}:${principal.id}`),
  });
  if (outcomes.RETRY > 0) {
    throw new RetryableDeliveryError(summary);
  }
  return summary;
}
