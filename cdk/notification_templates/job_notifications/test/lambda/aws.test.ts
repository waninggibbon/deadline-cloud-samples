// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.

// The AWS SDK adapters, against a stub `send` that records each command and
// answers or fails it the way the service would.

import { DeadlineClient } from '@aws-sdk/client-deadline';
import { IdentitystoreClient } from '@aws-sdk/client-identitystore';
import { SESv2Client } from '@aws-sdk/client-sesv2';
import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import {
  AwsTransport,
  DeadlineJobDirectory,
  DynamoDeliveryLedger,
  DynamoPreferencesStore,
  IdentityStoreDirectory,
  TtlCache,
} from '../../lambda/aws';
import { PermanentError } from '../../lambda/errors';
import { ALEX, FARM_ID, JOB_ID, QUEUE_ID, SAM } from './fakes';

type Command = { constructor: { name: string }; input: Record<string, any> };

function stubClient<T>(respond: (command: Command) => unknown) {
  const commands: Command[] = [];
  const client = {
    send: async (command: Command) => {
      commands.push(command);
      return respond(command);
    },
  } as unknown as T;
  return { client, commands };
}

function serviceError(name: string, extra: Record<string, unknown> = {}): Error {
  return Object.assign(new Error(name), { name, ...extra });
}

const IDS = { farmId: FARM_ID, queueId: QUEUE_ID, jobId: JOB_ID };

describe('DeadlineJobDirectory', () => {
  test("returns the job's submitter and name", async () => {
    const { client, commands } = stubClient<DeadlineClient>(() => ({
      createdBy: ALEX,
      name: 'shot_010',
    }));
    await expect(new DeadlineJobDirectory(client).getJob(IDS)).resolves.toEqual({
      createdBy: ALEX,
      name: 'shot_010',
    });
    expect(commands[0].constructor.name).toBe('GetJobCommand');
    expect(commands[0].input).toEqual(IDS);
  });

  test.each(['ResourceNotFoundException', 'AccessDeniedException', 'ValidationException'])(
    'maps %s to a permanent error',
    async (name) => {
      const { client } = stubClient<DeadlineClient>(() => {
        throw serviceError(name);
      });
      await expect(new DeadlineJobDirectory(client).getJob(IDS)).rejects.toThrow(PermanentError);
    },
  );

  test('leaves throttling to the retry', async () => {
    const { client } = stubClient<DeadlineClient>(() => {
      throw serviceError('ThrottlingException');
    });
    const failure = new DeadlineJobDirectory(client).getJob(IDS);
    await expect(failure).rejects.toThrow('ThrottlingException');
    await expect(failure).rejects.not.toBeInstanceOf(PermanentError);
  });
});

describe('IdentityStoreDirectory', () => {
  test("returns a user's primary email, and caches it", async () => {
    const { client, commands } = stubClient<IdentitystoreClient>(() => ({
      Emails: [
        { Value: 'alex.old@studio.example.com' },
        { Value: 'alex@studio.example.com', Primary: true },
      ],
    }));
    const directory = new IdentityStoreDirectory(client, 'd-1234567890');
    expect(await directory.userEmail(ALEX)).toBe('alex@studio.example.com');
    expect(await directory.userEmail(ALEX)).toBe('alex@studio.example.com');
    expect(commands).toHaveLength(1);
    expect(commands[0].input).toEqual({ IdentityStoreId: 'd-1234567890', UserId: ALEX });
  });

  test('returns nothing for an unknown user', async () => {
    const { client } = stubClient<IdentitystoreClient>(() => {
      throw serviceError('ResourceNotFoundException');
    });
    expect(await new IdentityStoreDirectory(client, 'd-1234567890').userEmail(ALEX)).toBeUndefined();
  });

  test('pages through group memberships up to the limit', async () => {
    const pages = [
      { GroupMemberships: [{ MemberId: { UserId: ALEX } }], NextToken: 'page-2' },
      { GroupMemberships: [{ MemberId: { UserId: SAM } }, { MemberId: { UserId: 'third' } }] },
    ];
    const { client, commands } = stubClient<IdentitystoreClient>(() => pages.shift());
    const members = await new IdentityStoreDirectory(client, 'd-1234567890').groupMembers('g', 2);
    expect(members).toEqual({ userIds: [ALEX, SAM], truncated: true });
    expect(commands.map((c) => c.input.NextToken)).toEqual([undefined, 'page-2']);
  });
});

describe('DynamoPreferencesStore', () => {
  test('reads and parses one item by principal', async () => {
    const { client, commands } = stubClient<DynamoDBDocumentClient>(() => ({
      Item: { principalId: ALEX, channels: ['SLACK', 'PAGER'], mutedNotifications: ['TASK_FAILED'] },
    }));
    const preferences = await new DynamoPreferencesStore(client, 'Prefs').get(ALEX);
    expect(preferences).toEqual(
      expect.objectContaining({ channels: ['SLACK'], mutedNotifications: ['TASK_FAILED'] }),
    );
    expect(commands[0].input).toEqual({ TableName: 'Prefs', Key: { principalId: ALEX } });
  });
});

describe('DynamoDeliveryLedger', () => {
  const NOW = 1_800_000_000;

  function ledger(respond: (command: Command) => unknown) {
    const stub = stubClient<DynamoDBDocumentClient>(respond);
    return { ...stub, ledger: new DynamoDeliveryLedger(stub.client, 'Deliveries', 45, 3600, () => NOW) };
  }

  test('claims with a conditional put that only takes over a stale claim', async () => {
    const { ledger: l, commands } = ledger(() => ({}));
    expect(await l.claim('key', 'event-1', 'EMAIL')).toBe('CLAIMED');
    const { input } = commands[0];
    expect(input.Item).toEqual({
      deliveryKey: 'key',
      eventId: 'event-1',
      channel: 'EMAIL',
      status: 'PENDING',
      claimedAt: NOW,
      expiresAt: NOW + 3600,
    });
    expect(input.ConditionExpression).toBe(
      'attribute_not_exists(deliveryKey) OR (#status = :pending AND claimedAt < :stale)',
    );
    expect(input.ExpressionAttributeValues[':stale']).toBe(NOW - 45);
    expect(input.ReturnValuesOnConditionCheckFailure).toBe('ALL_OLD');
  });

  test.each([
    ['SENT', 'DONE'],
    ['FAILED', 'DONE'],
    ['PENDING', 'IN_PROGRESS'],
  ])('reports an existing %s record as %s', async (status, expected) => {
    const { ledger: l } = ledger(() => {
      throw serviceError('ConditionalCheckFailedException', { Item: { status: { S: status } } });
    });
    expect(await l.claim('key', 'event-1', 'EMAIL')).toBe(expected);
  });

  test('releases only a claim that is still pending', async () => {
    const { ledger: l, commands } = ledger(() => {
      throw serviceError('ConditionalCheckFailedException');
    });
    await expect(l.release('key')).resolves.toBeUndefined();
    expect(commands[0].input.ConditionExpression).toBe('#status = :pending');
  });
});

describe('AwsTransport', () => {
  const content = { subject: 'S', text: 'T', html: '<p>H</p>' };

  test('sends one email per recipient, from the configured sender', async () => {
    const ses = stubClient<SESv2Client>(() => ({}));
    const secrets = stubClient<SecretsManagerClient>(() => ({}));
    await new AwsTransport(ses.client, secrets.client, 'from@studio.example.com').sendEmail(
      'to@studio.example.com',
      content,
    );
    expect(ses.commands[0].input).toEqual(
      expect.objectContaining({
        FromEmailAddress: 'from@studio.example.com',
        Destination: { ToAddresses: ['to@studio.example.com'] },
      }),
    );
  });

  test('maps an SES rejection to a permanent error', async () => {
    const ses = stubClient<SESv2Client>(() => {
      throw serviceError('MessageRejected');
    });
    const secrets = stubClient<SecretsManagerClient>(() => ({}));
    await expect(
      new AwsTransport(ses.client, secrets.client, 'from@studio.example.com').sendEmail('to@x', content),
    ).rejects.toThrow(PermanentError);
  });

  test('reads a webhook URL from its secret, and caches it', async () => {
    const ses = stubClient<SESv2Client>(() => ({}));
    const secrets = stubClient<SecretsManagerClient>(() => ({ SecretString: 'https://hooks.slack.com/x' }));
    const transport = new AwsTransport(ses.client, secrets.client, undefined);
    expect(await transport.webhookUrl('arn:secret')).toBe('https://hooks.slack.com/x');
    expect(await transport.webhookUrl('arn:secret')).toBe('https://hooks.slack.com/x');
    expect(secrets.commands).toHaveLength(1);
  });

  test('maps a missing webhook secret to a permanent error', async () => {
    const ses = stubClient<SESv2Client>(() => ({}));
    const secrets = stubClient<SecretsManagerClient>(() => {
      throw serviceError('ResourceNotFoundException');
    });
    await expect(
      new AwsTransport(ses.client, secrets.client, undefined).webhookUrl('arn:secret'),
    ).rejects.toThrow(PermanentError);
  });
});

describe('TtlCache', () => {
  test('reloads after the TTL and does not cache failures', async () => {
    let now = 0;
    const cache = new TtlCache<number>(1000, () => now);
    let loads = 0;
    const load = async () => ++loads;
    expect(await cache.get('k', load)).toBe(1);
    expect(await cache.get('k', load)).toBe(1);
    now = 1001;
    expect(await cache.get('k', load)).toBe(2);

    await expect(cache.get('bad', async () => Promise.reject(new Error('x')))).rejects.toThrow('x');
    await new Promise((resolve) => setImmediate(resolve));
    expect(await cache.get('bad', async () => 7)).toBe(7);
  });
});
