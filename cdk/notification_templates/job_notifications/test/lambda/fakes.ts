// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.

// In-memory stand-ins for every AWS call the notification function makes, so
// the tests exercise the whole flow in notify.ts without a network.

import { Config } from '../../lambda/config';
import { ClaimResult, DeliveryLedger, Transport } from '../../lambda/delivery';
import { PermanentError } from '../../lambda/errors';
import { DeadlineEvent } from '../../lambda/events';
import { EmailContent } from '../../lambda/format';
import { LogFields, Logger } from '../../lambda/log';
import { Dependencies, JobDirectory } from '../../lambda/notify';
import { Preferences, parsePreferences } from '../../lambda/preferences';
import { IdentityDirectory, PreferencesStore } from '../../lambda/recipients';
import { Channel, ResourceIds } from '../../lambda/types';

export const REGION = 'us-west-2';
export const ACCOUNT = '123456789012';
export const FARM_ID = `farm-${'1'.repeat(32)}`;
export const QUEUE_ID = `queue-${'2'.repeat(32)}`;
export const JOB_ID = `job-${'3'.repeat(32)}`;
export const STEP_ID = `step-${'4'.repeat(32)}`;
export const TASK_ID = `task-${'4'.repeat(32)}-7`;
export const MONITOR_URL = 'https://studio.us-west-2.deadlinecloud.amazonaws.com';
export const IDENTITY_STORE_ID = 'd-1234567890';
export const SECRET_PREFIX = `arn:aws:secretsmanager:${REGION}:${ACCOUNT}:secret:Notifications/webhooks/`;

/** An Identity Center user ID, in the shape Deadline Cloud records in `createdBy`. */
export const ALEX = '90670a1b2c-11111111-2222-3333-4444-555555555555';
export const SAM = '90670a1b2c-66666666-7777-8888-9999-000000000000';
export const ROBIN = '90670a1b2c-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
export const LEADS_GROUP = '90670a1b2c-12121212-3434-5656-7878-909090909090';
export const PIPELINE_ROLE = `arn:aws:sts::${ACCOUNT}:assumed-role/RenderPipeline/submitter`;

export function secretArn(name: string): string {
  return `${SECRET_PREFIX}${name}-AbCdEf`;
}

export function config(overrides: Partial<Config> = {}): Config {
  return {
    preferencesTableName: 'Preferences',
    deliveryTableName: 'Deliveries',
    monitorUrl: MONITOR_URL,
    identityStoreId: IDENTITY_STORE_ID,
    identityStoreRegion: REGION,
    senderEmailAddress: 'render-notifications@studio.example.com',
    messageDetail: 'MINIMAL',
    notifyApproversOfDecision: false,
    approvalLinkTarget: 'STEP_PAGE',
    webhookSecretArnPrefix: SECRET_PREFIX,
    claimTimeoutSeconds: 45,
    deliveryRecordTtlSeconds: 3 * 24 * 3600,
    maxGroupMembers: 100,
    ...overrides,
  };
}

let eventCounter = 0;

/** An EventBridge envelope around a Deadline Cloud event detail. */
export function deadlineEvent(
  detailType: string,
  detail: Record<string, unknown>,
  id = `event-${++eventCounter}`,
): DeadlineEvent {
  return {
    id,
    'detail-type': detailType,
    source: 'aws.deadline',
    account: ACCOUNT,
    region: REGION,
    time: '2026-11-19T00:00:00Z',
    detail,
  };
}

export function jobFailedEvent(id?: string): DeadlineEvent {
  return deadlineEvent(
    'Job Run Status Change',
    {
      farmId: FARM_ID,
      queueId: QUEUE_ID,
      jobId: JOB_ID,
      previousTaskRunStatus: 'RUNNING',
      taskRunStatus: 'FAILED',
      taskRunStatusCounts: { FAILED: 1, SUCCEEDED: 9 },
    },
    id,
  );
}

export function stepFailedEvent(id?: string): DeadlineEvent {
  return deadlineEvent(
    'Step Run Status Change',
    {
      farmId: FARM_ID,
      queueId: QUEUE_ID,
      jobId: JOB_ID,
      stepId: STEP_ID,
      previousTaskRunStatus: 'RUNNING',
      taskRunStatus: 'FAILED',
      taskRunStatusCounts: { FAILED: 1 },
    },
    id,
  );
}

export function taskFailedEvent(id?: string): DeadlineEvent {
  return deadlineEvent(
    'Task Run Status Change',
    {
      farmId: FARM_ID,
      queueId: QUEUE_ID,
      jobId: JOB_ID,
      stepId: STEP_ID,
      taskId: TASK_ID,
      previousRunStatus: 'RUNNING',
      runStatus: 'FAILED',
    },
    id,
  );
}

export const APPROVAL_REQUEST_ID = `approvalrequest-${'5'.repeat(32)}`;

export function approver(type: 'USER' | 'GROUP', id: string, identityStoreId = IDENTITY_STORE_ID) {
  return { principalType: type, principalId: id, identityStoreId };
}

/** A `Step Approval Requested` event, in the shape of the contract's example. */
export function approvalRequestedEvent(
  approvers: unknown[],
  overrides: Record<string, unknown> = {},
  id?: string,
): DeadlineEvent {
  return deadlineEvent(
    'Step Approval Requested',
    {
      farmId: FARM_ID,
      queueId: QUEUE_ID,
      jobId: JOB_ID,
      stepId: STEP_ID,
      approvalRequestId: APPROVAL_REQUEST_ID,
      requestNumber: 1,
      approvalStatus: 'WAITING',
      approvalOnly: true,
      requestedAt: '2026-11-19T10:00:00.000Z',
      expiresAt: '2026-11-22T10:00:00.000Z',
      jobCreatedBy: ALEX,
      approvers,
      ...overrides,
    },
    id,
  );
}

/** A `Step Approval Decided` event, in the shape of the contract's example. */
export function approvalDecidedEvent(
  approvalStatus: 'APPROVED' | 'REJECTED' | 'EXPIRED',
  approvers: unknown[],
  overrides: Record<string, unknown> = {},
  id?: string,
): DeadlineEvent {
  return deadlineEvent(
    'Step Approval Decided',
    {
      farmId: FARM_ID,
      queueId: QUEUE_ID,
      jobId: JOB_ID,
      stepId: STEP_ID,
      approvalRequestId: APPROVAL_REQUEST_ID,
      requestNumber: 1,
      approvalOnly: true,
      previousApprovalStatus: 'WAITING',
      approvalStatus,
      requestedAt: '2026-11-19T10:00:00.000Z',
      decidedAt: '2026-11-19T11:00:00.000Z',
      ...(approvalStatus === 'EXPIRED' ? {} : { decidedBy: SAM }),
      jobCreatedBy: ALEX,
      approvers,
      ...overrides,
    },
    id,
  );
}

export class FakeJobs implements JobDirectory {
  readonly getJobCalls: ResourceIds[] = [];
  readonly getStepCalls: ResourceIds[] = [];
  failWith?: Error;

  constructor(
    public createdBy = ALEX,
    public name = 'shot_042_lighting_v3',
    public stepName = 'Render',
  ) {}

  async getJob(ids: ResourceIds): Promise<{ createdBy: string; name?: string }> {
    this.getJobCalls.push(ids);
    if (this.failWith) throw this.failWith;
    return { createdBy: this.createdBy, name: this.name };
  }

  async getStepName(ids: ResourceIds): Promise<string | undefined> {
    this.getStepCalls.push(ids);
    return this.stepName;
  }
}

export class FakeIdentity implements IdentityDirectory {
  readonly emails = new Map<string, string>([
    [ALEX, 'alex@studio.example.com'],
    [SAM, 'sam@studio.example.com'],
    [ROBIN, 'robin@studio.example.com'],
  ]);
  readonly groups = new Map<string, string[]>([[LEADS_GROUP, [SAM, ROBIN]]]);
  /** Every lookup made, as `<identity store>/<user or group ID>`. */
  readonly lookups: string[] = [];

  async userEmail(identityStoreId: string, userId: string): Promise<string | undefined> {
    this.lookups.push(`${identityStoreId}/${userId}`);
    return this.emails.get(userId);
  }

  async groupMembers(identityStoreId: string, groupId: string, limit: number) {
    this.lookups.push(`${identityStoreId}/${groupId}`);
    const members = this.groups.get(groupId) ?? [];
    return { userIds: members.slice(0, limit), truncated: members.length > limit };
  }
}

export class FakePreferences implements PreferencesStore {
  readonly items = new Map<string, Preferences>();

  set(principalId: string, item: Record<string, unknown>): void {
    this.items.set(principalId, parsePreferences({ principalId, ...item }));
  }

  async get(principalId: string): Promise<Preferences | undefined> {
    return this.items.get(principalId);
  }
}

/** The same claim semantics as the DynamoDB ledger, in memory. */
export class InMemoryLedger implements DeliveryLedger {
  readonly records = new Map<string, { status: 'PENDING' | 'SENT' | 'FAILED'; reason?: string }>();

  async claim(key: string, _eventId: string, _channel: Channel): Promise<ClaimResult> {
    const existing = this.records.get(key);
    if (existing) return existing.status === 'PENDING' ? 'IN_PROGRESS' : 'DONE';
    this.records.set(key, { status: 'PENDING' });
    return 'CLAIMED';
  }

  async complete(key: string, status: 'SENT' | 'FAILED', reason?: string): Promise<void> {
    this.records.set(key, { status, reason });
  }

  async release(key: string): Promise<void> {
    if (this.records.get(key)?.status === 'PENDING') this.records.delete(key);
  }
}

export interface SentEmail {
  readonly to: string;
  readonly content: EmailContent;
}

export interface PostedWebhook {
  readonly url: string;
  readonly payload: Record<string, unknown>;
}

export class FakeTransport implements Transport {
  readonly emails: SentEmail[] = [];
  readonly webhooks: PostedWebhook[] = [];
  /** Secret ARN to the webhook URL it holds. */
  readonly secrets = new Map<string, string>();
  /** Destination (email address or webhook URL) to the error sending to it throws. */
  readonly failures = new Map<string, Error>();

  async sendEmail(to: string, content: EmailContent): Promise<void> {
    const failure = this.failures.get(to);
    if (failure) throw failure;
    this.emails.push({ to, content });
  }

  async webhookUrl(arn: string): Promise<string> {
    const url = this.secrets.get(arn);
    if (!url) throw new PermanentError('No such secret.', 'ResourceNotFoundException');
    return url;
  }

  async postWebhook(url: URL, payload: Record<string, unknown>): Promise<void> {
    const failure = this.failures.get(url.toString());
    if (failure) throw failure;
    this.webhooks.push({ url: url.toString(), payload });
  }
}

export class CapturingLogger implements Logger {
  readonly entries: { level: string; message: string; fields: LogFields }[] = [];
  info(message: string, fields: LogFields = {}) {
    this.entries.push({ level: 'INFO', message, fields });
  }
  warn(message: string, fields: LogFields = {}) {
    this.entries.push({ level: 'WARN', message, fields });
  }
  error(message: string, fields: LogFields = {}) {
    this.entries.push({ level: 'ERROR', message, fields });
  }
  /** Every log line as the JSON the real logger would write. */
  text(): string {
    return this.entries.map((entry) => JSON.stringify(entry)).join('\n');
  }
}

export interface Fakes extends Dependencies {
  readonly jobs: FakeJobs;
  readonly identity: FakeIdentity;
  readonly preferences: FakePreferences;
  readonly ledger: InMemoryLedger;
  readonly transport: FakeTransport;
  readonly log: CapturingLogger;
}

export function fakes(): Fakes {
  return {
    jobs: new FakeJobs(),
    identity: new FakeIdentity(),
    preferences: new FakePreferences(),
    ledger: new InMemoryLedger(),
    transport: new FakeTransport(),
    log: new CapturingLogger(),
  };
}

/** Every URL in a string, so a test can check a message links nowhere unexpected. */
export function urlsIn(text: string): string[] {
  return [...text.matchAll(/https?:\/\/[^\s"<>|)]+/g)].map((match) => match[0]);
}
