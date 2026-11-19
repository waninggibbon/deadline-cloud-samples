// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.

// Turning principals into recipients, and recipients into destinations.

import { planDeliveries } from '../../lambda/delivery';
import { PermanentError } from '../../lambda/errors';
import { resolveRecipients } from '../../lambda/recipients';
import {
  ALEX,
  IDENTITY_STORE_ID,
  LEADS_GROUP,
  PIPELINE_ROLE,
  ROBIN,
  SAM,
  SECRET_PREFIX,
  fakes,
  secretArn,
} from './fakes';

function resolve(deps: ReturnType<typeof fakes>, ...audience: Parameters<typeof resolveRecipients>[0]) {
  return resolveRecipients(audience, {
    identity: deps.identity,
    identityStoreId: IDENTITY_STORE_ID,
    preferences: deps.preferences,
    maxGroupMembers: 100,
    log: deps.log,
  });
}

const PLAN = { emailConfigured: true, webhookSecretArnPrefix: SECRET_PREFIX };

describe('resolveRecipients', () => {
  test('resolves an Identity Center user to their email address', async () => {
    const deps = fakes();
    const { recipients } = await resolve(deps, { type: 'USER', id: ALEX });
    expect(recipients).toEqual([
      { type: 'USER', principalId: ALEX, email: 'alex@studio.example.com', preferences: undefined },
    ]);
  });

  test('expands a group to its members', async () => {
    const deps = fakes();
    const { recipients } = await resolve(deps, { type: 'GROUP', id: LEADS_GROUP });
    expect(recipients.map((r) => r.principalId)).toEqual([SAM, ROBIN]);
  });

  test('notifies a person once when they are named directly and through a group', async () => {
    const deps = fakes();
    const { recipients } = await resolve(
      deps,
      { type: 'USER', id: SAM },
      { type: 'GROUP', id: LEADS_GROUP },
      { type: 'USER', id: SAM },
    );
    expect(recipients.map((r) => r.principalId)).toEqual([SAM, ROBIN]);
  });

  test("adds a group with preferences as a recipient, for the team's own channel", async () => {
    const deps = fakes();
    deps.preferences.set(LEADS_GROUP, {
      channels: ['SLACK'],
      slackWebhookSecretArn: secretArn('leads-slack'),
    });
    const { recipients } = await resolve(deps, { type: 'GROUP', id: LEADS_GROUP });
    expect(recipients.map((r) => [r.type, r.principalId])).toEqual([
      ['GROUP', LEADS_GROUP],
      ['USER', SAM],
      ['USER', ROBIN],
    ]);
  });

  test('caps how many members of a group are notified', async () => {
    const deps = fakes();
    const many = Array.from({ length: 5 }, (_, i) => `90670a1b2c-0000000${i}-0000-0000-0000-000000000000`);
    deps.identity.groups.set(LEADS_GROUP, many);
    const { recipients } = await resolveRecipients([{ type: 'GROUP', id: LEADS_GROUP }], {
      identity: deps.identity,
      preferences: deps.preferences,
      identityStoreId: IDENTITY_STORE_ID,
      maxGroupMembers: 3,
      log: deps.log,
    });
    expect(recipients).toHaveLength(3);
    expect(deps.log.entries.some((entry) => entry.level === 'WARN')).toBe(true);
  });

  test('skips an IAM principal with no preferences', async () => {
    const deps = fakes();
    const { recipients, unresolved } = await resolve(deps, { type: 'IAM', id: PIPELINE_ROLE });
    expect(recipients).toEqual([]);
    expect(unresolved).toEqual([
      { principal: { type: 'IAM', id: PIPELINE_ROLE }, reason: 'IamPrincipalWithoutPreferences' },
    ]);
  });

  test('without an identity store, uses only the email in preferences', async () => {
    const deps = fakes();
    deps.preferences.set(SAM, { email: 'sam.home@studio.example.com' });
    const { recipients, unresolved } = await resolveRecipients(
      [
        { type: 'USER', id: ALEX },
        { type: 'USER', id: SAM },
        { type: 'GROUP', id: LEADS_GROUP },
      ],
      { identity: deps.identity, preferences: deps.preferences, maxGroupMembers: 100, log: deps.log },
    );
    expect(recipients.map((r) => [r.principalId, r.email])).toEqual([
      [ALEX, undefined],
      [SAM, 'sam.home@studio.example.com'],
    ]);
    expect(unresolved.map((u) => u.reason)).toEqual(['IdentityStoreNotConfigured']);
    expect(deps.identity.lookups).toEqual([]);
  });

  test("without a configured identity store, uses the one the event names", async () => {
    const deps = fakes();
    const { recipients } = await resolveRecipients(
      [{ type: 'GROUP', id: LEADS_GROUP, identityStoreId: 'd-9999999999' }],
      { identity: deps.identity, preferences: deps.preferences, maxGroupMembers: 100, log: deps.log },
    );
    expect(recipients.map((r) => r.email)).toEqual([
      'sam@studio.example.com',
      'robin@studio.example.com',
    ]);
    expect(deps.identity.lookups).toEqual([
      `d-9999999999/${LEADS_GROUP}`,
      `d-9999999999/${SAM}`,
      `d-9999999999/${ROBIN}`,
    ]);
  });

  test('does not look up a principal in a store other than the configured one', async () => {
    const deps = fakes();
    const { recipients, unresolved } = await resolve(
      deps,
      { type: 'USER', id: ALEX, identityStoreId: 'd-9999999999' },
      { type: 'GROUP', id: LEADS_GROUP, identityStoreId: 'd-9999999999' },
    );
    expect(recipients.map((r) => [r.principalId, r.email])).toEqual([[ALEX, undefined]]);
    expect(unresolved.map((u) => u.reason)).toEqual(['IdentityStoreMismatch']);
    expect(deps.identity.lookups).toEqual([]);
  });

  test('a store the function cannot read leaves only those principals unresolved', async () => {
    const deps = fakes();
    deps.identity.groupMembers = async () => {
      throw new PermanentError('denied', 'AccessDeniedException');
    };
    const { recipients, unresolved } = await resolve(
      deps,
      { type: 'GROUP', id: LEADS_GROUP },
      { type: 'USER', id: ALEX },
    );
    expect(recipients.map((r) => r.principalId)).toEqual([ALEX]);
    expect(unresolved).toEqual([
      { principal: { type: 'GROUP', id: LEADS_GROUP }, reason: 'AccessDeniedException' },
    ]);
  });

  test('a transient identity store failure fails the whole event, for a retry', async () => {
    const deps = fakes();
    deps.identity.userEmail = async () => {
      throw Object.assign(new Error('slow down'), { name: 'ThrottlingException' });
    };
    await expect(resolve(deps, { type: 'USER', id: ALEX })).rejects.toThrow('slow down');
  });

  test('never notifies an excluded principal, even through a group', async () => {
    const deps = fakes();
    const { recipients } = await resolveRecipients(
      [
        { type: 'USER', id: SAM },
        { type: 'GROUP', id: LEADS_GROUP },
      ],
      {
        identity: deps.identity,
        identityStoreId: IDENTITY_STORE_ID,
        preferences: deps.preferences,
        maxGroupMembers: 100,
        exclude: new Set([SAM]),
        log: deps.log,
      },
    );
    expect(recipients.map((r) => r.principalId)).toEqual([ROBIN]);
  });
});

describe('planDeliveries', () => {
  test('emails a user with no preferences', async () => {
    const deps = fakes();
    const { recipients } = await resolve(deps, { type: 'USER', id: ALEX });
    const { deliveries } = planDeliveries(recipients, 'JOB_FAILED', PLAN);
    expect(deliveries).toEqual([
      { principalId: ALEX, target: { channel: 'EMAIL', address: 'alex@studio.example.com' } },
    ]);
  });

  test('sends to a shared destination once', async () => {
    const deps = fakes();
    const teamChannel = { channels: ['SLACK'], slackWebhookSecretArn: secretArn('team') };
    deps.preferences.set(SAM, teamChannel);
    deps.preferences.set(ROBIN, teamChannel);
    deps.preferences.set(ALEX, { email: 'SAM@studio.example.com' });
    deps.identity.emails.set(SAM, 'sam@studio.example.com');
    const { recipients } = await resolve(
      deps,
      { type: 'USER', id: SAM },
      { type: 'USER', id: ROBIN },
      { type: 'USER', id: ALEX },
    );
    const { deliveries } = planDeliveries(recipients, 'APPROVAL_REQUESTED', PLAN);
    expect(deliveries.map((d) => d.target)).toEqual([
      { channel: 'SLACK', secretArn: secretArn('team') },
      { channel: 'EMAIL', address: 'SAM@studio.example.com' },
    ]);
  });

  test('honours a mute for one kind of notification only', async () => {
    const deps = fakes();
    deps.preferences.set(ALEX, { mutedNotifications: ['TASK_FAILED'] });
    const { recipients } = await resolve(deps, { type: 'USER', id: ALEX });
    expect(planDeliveries(recipients, 'TASK_FAILED', PLAN).deliveries).toEqual([]);
    expect(planDeliveries(recipients, 'APPROVAL_REQUESTED', PLAN).deliveries).toHaveLength(1);
  });

  test('an explicitly empty channel list turns notifications off', async () => {
    const deps = fakes();
    deps.preferences.set(ALEX, { channels: [] });
    const { recipients } = await resolve(deps, { type: 'USER', id: ALEX });
    expect(planDeliveries(recipients, 'JOB_FAILED', PLAN).deliveries).toEqual([]);
  });

  test('records why a channel could not be used', async () => {
    const deps = fakes();
    deps.preferences.set(ALEX, {
      channels: ['SLACK', 'CHIME'],
      chimeWebhookSecretArn: 'arn:aws:secretsmanager:us-west-2:123456789012:secret:someone-else',
    });
    deps.preferences.set(SAM, { channels: ['EMAIL'] });
    deps.identity.emails.delete(SAM);
    const { recipients } = await resolve(deps, { type: 'USER', id: ALEX }, { type: 'USER', id: SAM });
    const { deliveries, skipped } = planDeliveries(recipients, 'JOB_FAILED', PLAN);
    expect(deliveries).toEqual([]);
    expect(skipped).toEqual([
      { principalId: ALEX, channel: 'SLACK', reason: 'NoWebhookSecret' },
      { principalId: ALEX, channel: 'CHIME', reason: 'WebhookSecretOutsidePrefix' },
      { principalId: SAM, channel: 'EMAIL', reason: 'NoEmailAddress' },
    ]);
  });

  test('a group with no preferences of its own is not a destination', async () => {
    const deps = fakes();
    deps.identity.groups.set(LEADS_GROUP, []);
    deps.preferences.set(LEADS_GROUP, { email: 'leads@studio.example.com' });
    const { recipients } = await resolve(deps, { type: 'GROUP', id: LEADS_GROUP });
    // The group has preferences but names no channels, and a group's default is none.
    expect(planDeliveries(recipients, 'APPROVAL_REQUESTED', PLAN).deliveries).toEqual([]);
  });
});
