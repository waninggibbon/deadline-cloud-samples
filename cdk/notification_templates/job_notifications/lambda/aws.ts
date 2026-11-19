// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.

// The AWS SDK implementations of the interfaces in notify.ts. Each one maps
// the service's errors onto the function's two kinds: a `PermanentError` that
// retrying will not fix, and anything else, which the Lambda retry handles.

import { DeadlineClient, GetJobCommand, GetStepCommand } from '@aws-sdk/client-deadline';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DescribeUserCommand,
  IdentitystoreClient,
  ListGroupMembershipsCommand,
} from '@aws-sdk/client-identitystore';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';

import { Config } from './config';
import { ClaimResult, DeliveryLedger, Transport } from './delivery';
import { PermanentError } from './errors';
import { EmailContent } from './format';
import { Logger } from './log';
import { Dependencies, JobDirectory } from './notify';
import { Preferences, parsePreferences } from './preferences';
import { IdentityDirectory, PreferencesStore } from './recipients';
import { Channel, ResourceIds } from './types';
import { FetchLike, postWebhook } from './webhooks';

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : '';
}

/** Rethrow a service error as a `PermanentError` when its name is in `permanent`. */
function mapError(error: unknown, permanent: readonly string[]): never {
  const name = errorName(error);
  if (permanent.includes(name)) {
    throw new PermanentError(`${name} from AWS.`, name);
  }
  throw error;
}

/**
 * A small time-bounded cache, kept for the life of a Lambda execution
 * environment, so a burst of events about the same job or group does not look
 * the same thing up again for every event.
 */
export class TtlCache<V> {
  private readonly entries = new Map<string, { value: Promise<V>; expires: number }>();

  constructor(
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  get(key: string, load: () => Promise<V>): Promise<V> {
    const entry = this.entries.get(key);
    if (entry && entry.expires > this.now()) {
      return entry.value;
    }
    const value = load();
    this.entries.set(key, { value, expires: this.now() + this.ttlMs });
    // A failed lookup is not cached.
    value.catch(() => this.entries.delete(key));
    return value;
  }
}

const CACHE_TTL_MS = 5 * 60 * 1000;

export class DeadlineJobDirectory implements JobDirectory {
  private static readonly PERMANENT = [
    'ResourceNotFoundException',
    'AccessDeniedException',
    'ValidationException',
  ];

  constructor(private readonly client: DeadlineClient) {}

  async getJob(ids: ResourceIds): Promise<{ createdBy: string; name?: string }> {
    let response;
    try {
      response = await this.client.send(
        new GetJobCommand({ farmId: ids.farmId, queueId: ids.queueId, jobId: ids.jobId }),
      );
    } catch (error) {
      mapError(error, DeadlineJobDirectory.PERMANENT);
    }
    if (!response.createdBy) {
      throw new PermanentError('The job has no createdBy.', 'JobWithoutCreatedBy');
    }
    return { createdBy: response.createdBy, name: response.name };
  }

  async getStepName(ids: ResourceIds): Promise<string | undefined> {
    if (!ids.stepId) return undefined;
    try {
      const response = await this.client.send(
        new GetStepCommand({
          farmId: ids.farmId,
          queueId: ids.queueId,
          jobId: ids.jobId,
          stepId: ids.stepId,
        }),
      );
      return response.name;
    } catch (error) {
      mapError(error, DeadlineJobDirectory.PERMANENT);
    }
  }
}

export class IdentityStoreDirectory implements IdentityDirectory {
  /**
   * A user, group, or store that does not exist, or that the function may not
   * read, fails only the principals concerned rather than the whole event.
   */
  private static readonly PERMANENT = [
    'ResourceNotFoundException',
    'AccessDeniedException',
    'ValidationException',
  ];
  private readonly emails = new TtlCache<string | undefined>(CACHE_TTL_MS);

  constructor(private readonly client: IdentitystoreClient) {}

  userEmail(identityStoreId: string, userId: string): Promise<string | undefined> {
    return this.emails.get(`${identityStoreId}/${userId}`, async () => {
      try {
        const user = await this.client.send(
          new DescribeUserCommand({ IdentityStoreId: identityStoreId, UserId: userId }),
        );
        const emails = user.Emails ?? [];
        return (emails.find((email) => email.Primary) ?? emails[0])?.Value;
      } catch (error) {
        mapError(error, IdentityStoreDirectory.PERMANENT);
      }
    });
  }

  async groupMembers(
    identityStoreId: string,
    groupId: string,
    limit: number,
  ): Promise<{ userIds: string[]; truncated: boolean }> {
    const userIds: string[] = [];
    let nextToken: string | undefined;
    try {
      do {
        const page = await this.client.send(
          new ListGroupMembershipsCommand({
            IdentityStoreId: identityStoreId,
            GroupId: groupId,
            NextToken: nextToken,
            MaxResults: 100,
          }),
        );
        for (const membership of page.GroupMemberships ?? []) {
          const userId = membership.MemberId?.UserId;
          if (userId) userIds.push(userId);
        }
        nextToken = page.NextToken;
      } while (nextToken && userIds.length <= limit);
    } catch (error) {
      mapError(error, IdentityStoreDirectory.PERMANENT);
    }
    return { userIds: userIds.slice(0, limit), truncated: userIds.length > limit };
  }
}

export class DynamoPreferencesStore implements PreferencesStore {
  constructor(
    private readonly client: DynamoDBDocumentClient,
    private readonly tableName: string,
  ) {}

  async get(principalId: string): Promise<Preferences | undefined> {
    const { Item } = await this.client.send(
      new GetCommand({ TableName: this.tableName, Key: { principalId } }),
    );
    return Item ? parsePreferences(Item) : undefined;
  }
}

/**
 * Delivery records in DynamoDB, one item per event and destination.
 *
 * A claim is a conditional put that only succeeds when there is no record yet,
 * or when the existing claim is older than the claim timeout and so belongs to
 * an invocation that can no longer be running. Records expire through the
 * table's TTL attribute, well after EventBridge and Lambda have stopped
 * retrying the event.
 */
export class DynamoDeliveryLedger implements DeliveryLedger {
  constructor(
    private readonly client: DynamoDBDocumentClient,
    private readonly tableName: string,
    private readonly claimTimeoutSeconds: number,
    private readonly ttlSeconds: number,
    private readonly now: () => number = () => Math.floor(Date.now() / 1000),
  ) {}

  async claim(key: string, eventId: string, channel: Channel): Promise<ClaimResult> {
    const now = this.now();
    try {
      await this.client.send(
        new PutCommand({
          TableName: this.tableName,
          Item: {
            deliveryKey: key,
            eventId,
            channel,
            status: 'PENDING',
            claimedAt: now,
            expiresAt: now + this.ttlSeconds,
          },
          ConditionExpression:
            'attribute_not_exists(deliveryKey) OR (#status = :pending AND claimedAt < :stale)',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: {
            ':pending': 'PENDING',
            ':stale': now - this.claimTimeoutSeconds,
          },
          ReturnValuesOnConditionCheckFailure: 'ALL_OLD',
        }),
      );
      return 'CLAIMED';
    } catch (error) {
      if (errorName(error) !== 'ConditionalCheckFailedException') throw error;
      // The existing record comes back on the error, in DynamoDB's attribute
      // value form, since the document client does not unmarshall errors.
      const status = (error as { Item?: { status?: { S?: string } | string } }).Item?.status;
      const value = typeof status === 'string' ? status : status?.S;
      return value === 'PENDING' ? 'IN_PROGRESS' : 'DONE';
    }
  }

  async complete(key: string, status: 'SENT' | 'FAILED', reason?: string): Promise<void> {
    await this.client.send(
      new UpdateCommand({
        TableName: this.tableName,
        Key: { deliveryKey: key },
        UpdateExpression: 'SET #status = :status, completedAt = :now, reason = :reason',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: { ':status': status, ':now': this.now(), ':reason': reason ?? '' },
      }),
    );
  }

  async release(key: string): Promise<void> {
    try {
      await this.client.send(
        new DeleteCommand({
          TableName: this.tableName,
          Key: { deliveryKey: key },
          ConditionExpression: '#status = :pending',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: { ':pending': 'PENDING' },
        }),
      );
    } catch (error) {
      if (errorName(error) !== 'ConditionalCheckFailedException') throw error;
    }
  }
}

export class AwsTransport implements Transport {
  private static readonly PERMANENT_SES = [
    'MessageRejected',
    'MailFromDomainNotVerifiedException',
    'AccountSuspendedException',
    'SendingPausedException',
    'NotFoundException',
    'BadRequestException',
  ];
  private static readonly PERMANENT_SECRETS = [
    'ResourceNotFoundException',
    'AccessDeniedException',
    'DecryptionFailure',
    'InvalidRequestException',
  ];
  private readonly webhookUrls = new TtlCache<string>(CACHE_TTL_MS);

  constructor(
    private readonly ses: SESv2Client,
    private readonly secrets: SecretsManagerClient,
    private readonly senderEmailAddress: string | undefined,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  async sendEmail(to: string, content: EmailContent): Promise<void> {
    if (!this.senderEmailAddress) {
      throw new PermanentError('No sender address is configured.', 'EmailNotConfigured');
    }
    try {
      await this.ses.send(
        new SendEmailCommand({
          FromEmailAddress: this.senderEmailAddress,
          Destination: { ToAddresses: [to] },
          Content: {
            Simple: {
              Subject: { Data: content.subject, Charset: 'UTF-8' },
              Body: {
                Text: { Data: content.text, Charset: 'UTF-8' },
                Html: { Data: content.html, Charset: 'UTF-8' },
              },
            },
          },
        }),
      );
    } catch (error) {
      mapError(error, AwsTransport.PERMANENT_SES);
    }
  }

  webhookUrl(secretArn: string): Promise<string> {
    return this.webhookUrls.get(secretArn, async () => {
      try {
        const secret = await this.secrets.send(new GetSecretValueCommand({ SecretId: secretArn }));
        if (!secret.SecretString) {
          throw new PermanentError('The webhook secret is empty.', 'EmptyWebhookSecret');
        }
        return secret.SecretString;
      } catch (error) {
        if (error instanceof PermanentError) throw error;
        mapError(error, AwsTransport.PERMANENT_SECRETS);
      }
    });
  }

  postWebhook(url: URL, payload: Record<string, unknown>): Promise<void> {
    return postWebhook(url, payload, this.fetchImpl);
  }
}

export function createAwsDependencies(config: Config, log: Logger): Dependencies {
  const region = process.env.AWS_REGION;
  const documents = DynamoDBDocumentClient.from(new DynamoDBClient({ region }));
  // A Deadline Cloud API endpoint override serves every operation from one
  // host, so the SDK must not prepend the per-operation host prefix to it.
  const deadline = new DeadlineClient(
    config.deadlineEndpointUrl
      ? { region, endpoint: config.deadlineEndpointUrl, disableHostPrefix: true }
      : { region },
  );
  return {
    jobs: new DeadlineJobDirectory(deadline),
    identity: new IdentityStoreDirectory(
      new IdentitystoreClient({ region: config.identityStoreRegion }),
    ),
    preferences: new DynamoPreferencesStore(documents, config.preferencesTableName),
    ledger: new DynamoDeliveryLedger(
      documents,
      config.deliveryTableName,
      config.claimTimeoutSeconds,
      config.deliveryRecordTtlSeconds,
    ),
    transport: new AwsTransport(
      new SESv2Client({ region }),
      new SecretsManagerClient({ region }),
      config.senderEmailAddress,
    ),
    log,
  };
}
