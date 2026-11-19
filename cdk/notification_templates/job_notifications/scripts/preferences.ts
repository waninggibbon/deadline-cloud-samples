// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.

// Administer notification preferences for a deployed JobNotifications stack.
//
//   npm run preferences -- show     <principal>
//   npm run preferences -- set      <principal> [--channels EMAIL,SLACK] [--email ADDRESS] [--mute KIND,...]
//   npm run preferences -- webhook  <principal> SLACK|CHIME      (reads the URL from standard input)
//   npm run preferences -- delete   <principal>
//   npm run preferences -- list
//
// Add `--stack <name>` when the stack is not called DeadlineJobNotifications.
//
// <principal> is one of:
//   user:<user name>      an IAM Identity Center user, looked up by user name
//   group:<display name>  an IAM Identity Center group, looked up by display name
//   arn:aws:...           an IAM principal ARN, as it appears in a job's createdBy
//   anything else         an Identity Center user or group ID, used as is
//
// Webhook URLs are written to Secrets Manager, never to the table or the
// command line, because a webhook URL is all anyone needs to post to the
// channel. Only the secret's ARN is stored in the preferences item.

import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';

import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  GetGroupIdCommand,
  GetUserIdCommand,
  IdentitystoreClient,
} from '@aws-sdk/client-identitystore';
import {
  CreateSecretCommand,
  DeleteSecretCommand,
  PutSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  ScanCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';

import { CHANNELS, Channel, NOTIFICATION_KINDS } from '../lambda/types';
import { validateWebhookUrl } from '../lambda/webhooks';

const USAGE = `Usage:
  npm run preferences -- show     <principal>
  npm run preferences -- set      <principal> [--channels EMAIL,SLACK,CHIME|none|default]
                                              [--email ADDRESS|default] [--mute KIND,...|none]
  npm run preferences -- webhook  <principal> SLACK|CHIME   (URL read from standard input)
  npm run preferences -- delete   <principal>
  npm run preferences -- list
Options:
  --stack NAME   the deployed stack (default DeadlineJobNotifications)
Notification kinds: ${NOTIFICATION_KINDS.join(', ')}`;

interface StackInfo {
  tableName: string;
  secretPrefix: string;
  identityStoreId?: string;
  identityStoreRegion?: string;
}

async function describeStack(stackName: string): Promise<StackInfo> {
  const { Stacks } = await new CloudFormationClient({}).send(
    new DescribeStacksCommand({ StackName: stackName }),
  );
  const stack = Stacks?.[0];
  const output = (key: string) => stack?.Outputs?.find((o) => o.OutputKey === key)?.OutputValue;
  const parameter = (key: string) =>
    stack?.Parameters?.find((p) => p.ParameterKey === key)?.ParameterValue || undefined;
  const tableName = output('PreferencesTableName');
  const secretPrefix = output('WebhookSecretPrefix');
  if (!tableName || !secretPrefix) {
    throw new Error(`${stackName} has no PreferencesTableName and WebhookSecretPrefix outputs.`);
  }
  return {
    tableName,
    secretPrefix,
    identityStoreId: parameter('IdentityStoreId'),
    identityStoreRegion: parameter('IdentityStoreRegion'),
  };
}

async function resolvePrincipal(principal: string, stack: StackInfo): Promise<string> {
  const match = /^(user|group):(.+)$/.exec(principal);
  if (!match) {
    return principal;
  }
  if (!stack.identityStoreId) {
    throw new Error(
      `The stack has no IdentityStoreId parameter, so ${principal} cannot be looked up. Pass an ID instead.`,
    );
  }
  const client = new IdentitystoreClient(
    stack.identityStoreRegion ? { region: stack.identityStoreRegion } : {},
  );
  const [, kind, name] = match;
  if (kind === 'user') {
    const { UserId } = await client.send(
      new GetUserIdCommand({
        IdentityStoreId: stack.identityStoreId,
        AlternateIdentifier: { UniqueAttribute: { AttributePath: 'userName', AttributeValue: name } },
      }),
    );
    return UserId!;
  }
  const { GroupId } = await client.send(
    new GetGroupIdCommand({
      IdentityStoreId: stack.identityStoreId,
      AlternateIdentifier: { UniqueAttribute: { AttributePath: 'displayName', AttributeValue: name } },
    }),
  );
  return GroupId!;
}

function parseList<T extends string>(value: string, allowed: readonly T[], what: string): T[] {
  if (value === 'none') return [];
  const items = value.split(',').map((item) => item.trim().toUpperCase()).filter(Boolean);
  for (const item of items) {
    if (!(allowed as readonly string[]).includes(item)) {
      throw new Error(`Unknown ${what} ${item}. Expected one of ${allowed.join(', ')}.`);
    }
  }
  return items as T[];
}

/** A secret name for a principal and channel that is valid whatever characters the principal ID has. */
function secretName(prefix: string, principalId: string, channel: Channel): string {
  const digest = createHash('sha256').update(principalId).digest('hex').slice(0, 24);
  return `${prefix}${digest}-${channel.toLowerCase()}`;
}

async function readWebhookUrl(): Promise<string> {
  const lines = createInterface({ input: process.stdin, output: process.stderr, terminal: false });
  if (process.stdin.isTTY) {
    process.stderr.write('Paste the webhook URL and press Enter: ');
  }
  for await (const line of lines) {
    lines.close();
    return line.trim();
  }
  throw new Error('No webhook URL on standard input.');
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      stack: { type: 'string', default: 'DeadlineJobNotifications' },
      channels: { type: 'string' },
      email: { type: 'string' },
      mute: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const [command, principalArg, channelArg] = positionals;
  if (values.help || !command) {
    console.log(USAGE);
    return;
  }

  const stack = await describeStack(values.stack!);
  const documents = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  const secrets = new SecretsManagerClient({});

  // Items hold secret ARNs, never webhook URLs, so they are safe to print.
  if (command === 'list') {
    const { Items = [] } = await documents.send(new ScanCommand({ TableName: stack.tableName }));
    for (const item of Items) console.log(JSON.stringify(item));
    return;
  }

  if (!principalArg) throw new Error(`${command} needs a principal.\n\n${USAGE}`);
  const principalId = await resolvePrincipal(principalArg, stack);
  const key = { principalId };

  switch (command) {
    case 'show': {
      const { Item } = await documents.send(new GetCommand({ TableName: stack.tableName, Key: key }));
      console.log(
        Item
          ? JSON.stringify(Item, null, 2)
          : `No preferences for ${principalId}; the defaults apply.`,
      );
      return;
    }

    case 'set': {
      const set: string[] = ['updatedAt = :updatedAt'];
      const remove: string[] = [];
      const valuesToSet: Record<string, unknown> = { ':updatedAt': new Date().toISOString() };
      if (values.channels !== undefined) {
        if (values.channels === 'default') remove.push('channels');
        else {
          set.push('channels = :channels');
          valuesToSet[':channels'] = parseList(values.channels, CHANNELS, 'channel');
        }
      }
      if (values.email !== undefined) {
        if (values.email === 'default') remove.push('email');
        else if (!/^[^\s@]+@[^\s@]+$/.test(values.email)) throw new Error('--email is not an email address.');
        else {
          set.push('email = :email');
          valuesToSet[':email'] = values.email;
        }
      }
      if (values.mute !== undefined) {
        set.push('mutedNotifications = :muted');
        valuesToSet[':muted'] = parseList(values.mute, NOTIFICATION_KINDS, 'notification kind');
      }
      const { Attributes } = await documents.send(
        new UpdateCommand({
          TableName: stack.tableName,
          Key: key,
          UpdateExpression: `SET ${set.join(', ')}${remove.length ? ` REMOVE ${remove.join(', ')}` : ''}`,
          ExpressionAttributeValues: valuesToSet,
          ReturnValues: 'ALL_NEW',
        }),
      );
      console.log(JSON.stringify(Attributes ?? {}, null, 2));
      return;
    }

    case 'webhook': {
      const channel = channelArg?.toUpperCase();
      if (channel !== 'SLACK' && channel !== 'CHIME') {
        throw new Error('webhook needs a channel: SLACK or CHIME.');
      }
      const url = validateWebhookUrl(channel, await readWebhookUrl()).toString();
      const name = secretName(stack.secretPrefix, principalId, channel);
      let arn: string | undefined;
      try {
        ({ ARN: arn } = await secrets.send(
          new CreateSecretCommand({
            Name: name,
            SecretString: url,
            Description: `Deadline Cloud notification ${channel} webhook for ${principalId}`,
            Tags: [{ Key: 'principalId', Value: principalId.slice(0, 256) }],
          }),
        ));
      } catch (error) {
        if ((error as Error).name !== 'ResourceExistsException') throw error;
        ({ ARN: arn } = await secrets.send(new PutSecretValueCommand({ SecretId: name, SecretString: url })));
      }
      // Turn the channel on as well, keeping whatever channels were already on.
      // With none set, that is the default: email for a person, nothing for a group.
      const { Item } = await documents.send(new GetCommand({ TableName: stack.tableName, Key: key }));
      const current: string[] = Item?.channels ?? (principalArg.startsWith('group:') ? [] : ['EMAIL']);
      const channels = [...new Set([...current, channel])];
      const attribute = channel === 'SLACK' ? 'slackWebhookSecretArn' : 'chimeWebhookSecretArn';
      await documents.send(
        new UpdateCommand({
          TableName: stack.tableName,
          Key: key,
          UpdateExpression: `SET ${attribute} = :arn, channels = :channels, updatedAt = :updatedAt`,
          ExpressionAttributeValues: {
            ':arn': arn,
            ':channels': channels,
            ':updatedAt': new Date().toISOString(),
          },
        }),
      );
      console.log(
        `Stored the ${channel} webhook for ${principalId} in ${name}. Its channels are now ${channels.join(', ')}.`,
      );
      return;
    }

    case 'delete': {
      const { Attributes } = await documents.send(
        new DeleteCommand({ TableName: stack.tableName, Key: key, ReturnValues: 'ALL_OLD' }),
      );
      for (const attribute of ['slackWebhookSecretArn', 'chimeWebhookSecretArn']) {
        const arn = Attributes?.[attribute];
        if (typeof arn === 'string') {
          await secrets.send(new DeleteSecretCommand({ SecretId: arn, RecoveryWindowInDays: 7 }));
          console.log(`Scheduled ${arn} for deletion in 7 days.`);
        }
      }
      console.log(Attributes ? `Deleted the preferences for ${principalId}.` : `${principalId} had no preferences.`);
      return;
    }

    default:
      throw new Error(`Unknown command ${command}.\n\n${USAGE}`);
  }
}

main().catch((error: Error) => {
  console.error(error.message);
  process.exitCode = 1;
});
