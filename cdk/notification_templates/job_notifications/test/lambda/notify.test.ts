// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.

// The whole flow for one event, from EventBridge envelope to delivered message.

import { deliveryKey } from '../../lambda/delivery';
import { PermanentError } from '../../lambda/errors';
import { RetryableDeliveryError, handleEvent } from '../../lambda/notify';
import {
  ALEX,
  FARM_ID,
  JOB_ID,
  MONITOR_URL,
  PIPELINE_ROLE,
  QUEUE_ID,
  REGION,
  STEP_ID,
  TASK_ID,
  config,
  deadlineEvent,
  fakes,
  jobFailedEvent,
  secretArn,
  stepFailedEvent,
  taskFailedEvent,
} from './fakes';

const JOB_LINK = `${MONITOR_URL}/${REGION}/farms/${FARM_ID}/queues/${QUEUE_ID}?jobId=${JOB_ID}`;
const SLACK_URL = 'https://hooks.slack.com/services/T0000/B0000/alexsecret';

describe('job failure', () => {
  test("emails the job's submitter at their Identity Center address", async () => {
    const deps = fakes();
    const summary = await handleEvent(jobFailedEvent(), config(), deps);

    expect(deps.jobs.getJobCalls).toEqual([{ farmId: FARM_ID, queueId: QUEUE_ID, jobId: JOB_ID }]);
    expect(deps.transport.emails).toHaveLength(1);
    const [email] = deps.transport.emails;
    expect(email.to).toBe('alex@studio.example.com');
    expect(email.content.subject).toBe('[Deadline Cloud] Job failed');
    expect(email.content.text).toContain(JOB_LINK);
    expect(summary.outcomes).toEqual({ SENT: 1, DUPLICATE: 0, FAILED: 0, RETRY: 0 });
  });

  test('links a step failure to the step and a task failure to the task', async () => {
    const deps = fakes();
    await handleEvent(stepFailedEvent(), config(), deps);
    await handleEvent(taskFailedEvent(), config(), deps);

    const [step, task] = deps.transport.emails;
    expect(step.content.subject).toBe('[Deadline Cloud] Step failed');
    expect(step.content.text).toContain(`${JOB_LINK}&stepId=${STEP_ID}\n`);
    expect(task.content.subject).toBe('[Deadline Cloud] Task failed');
    expect(task.content.text).toContain(`${JOB_LINK}&stepId=${STEP_ID}&taskId=${TASK_ID}`);
  });

  test('prefers the email override in preferences to the identity store', async () => {
    const deps = fakes();
    deps.preferences.set(ALEX, { email: 'alex.renders@studio.example.com' });
    await handleEvent(jobFailedEvent(), config(), deps);

    expect(deps.transport.emails.map((email) => email.to)).toEqual([
      'alex.renders@studio.example.com',
    ]);
    expect(deps.identity.lookups).toEqual([]);
  });

  test('delivers on every channel the submitter chose', async () => {
    const deps = fakes();
    deps.preferences.set(ALEX, {
      channels: ['EMAIL', 'SLACK'],
      slackWebhookSecretArn: secretArn('alex-slack'),
    });
    deps.transport.secrets.set(secretArn('alex-slack'), SLACK_URL);
    await handleEvent(jobFailedEvent(), config(), deps);

    expect(deps.transport.emails).toHaveLength(1);
    expect(deps.transport.webhooks.map((webhook) => webhook.url)).toEqual([SLACK_URL]);
  });

  test('sends nothing for a kind of notification the submitter muted', async () => {
    const deps = fakes();
    deps.preferences.set(ALEX, { mutedNotifications: ['JOB_FAILED'] });
    const summary = await handleEvent(jobFailedEvent(), config(), deps);

    expect(deps.transport.emails).toEqual([]);
    expect(summary.outcomes.SENT).toBe(0);
  });

  test('skips an IAM submitter with no preferences, and logs why', async () => {
    const deps = fakes();
    deps.jobs.createdBy = PIPELINE_ROLE;
    const summary = await handleEvent(jobFailedEvent(), config(), deps);

    expect(deps.transport.emails).toEqual([]);
    expect(summary.unresolved).toBe(1);
    expect(deps.log.entries).toContainEqual(
      expect.objectContaining({
        message: 'Principal could not be resolved',
        fields: expect.objectContaining({
          principalId: PIPELINE_ROLE,
          reason: 'IamPrincipalWithoutPreferences',
        }),
      }),
    );
  });

  test('notifies an IAM submitter through its preferences', async () => {
    const deps = fakes();
    deps.jobs.createdBy = PIPELINE_ROLE;
    deps.preferences.set(PIPELINE_ROLE, { email: 'pipeline-team@studio.example.com' });
    await handleEvent(jobFailedEvent(), config(), deps);

    expect(deps.transport.emails.map((email) => email.to)).toEqual([
      'pipeline-team@studio.example.com',
    ]);
  });

  test('skips email, with a logged reason, when no sender is configured', async () => {
    const deps = fakes();
    const summary = await handleEvent(
      jobFailedEvent(),
      config({ senderEmailAddress: undefined }),
      deps,
    );

    expect(deps.transport.emails).toEqual([]);
    expect(summary.skipped).toBe(1);
    expect(deps.log.entries).toContainEqual(
      expect.objectContaining({ fields: expect.objectContaining({ reason: 'EmailNotConfigured' }) }),
    );
  });

  test('ignores a run status change that is not a failure, without reading the job', async () => {
    const deps = fakes();
    const event = jobFailedEvent();
    const summary = await handleEvent(
      { ...event, detail: { ...event.detail, taskRunStatus: 'SUCCEEDED' } },
      config(),
      deps,
    );

    expect(summary.ignoredReason).toBe('NotANotifiableEvent');
    expect(deps.jobs.getJobCalls).toEqual([]);
  });

  test('drops an event with a malformed ID, without reading the job', async () => {
    const deps = fakes();
    const event = jobFailedEvent();
    const summary = await handleEvent(
      { ...event, detail: { ...event.detail, jobId: '../../admin' } },
      config(),
      deps,
    );

    expect(summary.ignoredReason).toBe('MalformedEvent');
    expect(deps.jobs.getJobCalls).toEqual([]);
    expect(deps.transport.emails).toEqual([]);
  });

  test('drops the event when the job cannot be read', async () => {
    const deps = fakes();
    deps.jobs.failWith = new PermanentError('gone', 'ResourceNotFoundException');
    const summary = await handleEvent(jobFailedEvent(), config(), deps);

    expect(summary.ignoredReason).toBe('ResourceNotFoundException');
    expect(deps.transport.emails).toEqual([]);
  });

  test('throws, so Lambda retries, when reading the job fails transiently', async () => {
    const deps = fakes();
    deps.jobs.failWith = Object.assign(new Error('slow down'), { name: 'ThrottlingException' });
    await expect(handleEvent(jobFailedEvent(), config(), deps)).rejects.toThrow('slow down');
  });
});

describe('message detail', () => {
  test('MINIMAL leaves out job and step names and never reads the step', async () => {
    const deps = fakes();
    await handleEvent(stepFailedEvent(), config({ messageDetail: 'MINIMAL' }), deps);

    const { text, html, subject } = deps.transport.emails[0].content;
    for (const part of [text, html, subject]) {
      expect(part).not.toContain('shot_042_lighting_v3');
      expect(part).not.toContain('Render');
    }
    expect(deps.jobs.getStepCalls).toEqual([]);
  });

  test('NAMES includes the job and step names', async () => {
    const deps = fakes();
    await handleEvent(stepFailedEvent(), config({ messageDetail: 'NAMES' }), deps);

    const { text } = deps.transport.emails[0].content;
    expect(text).toContain('Job: shot_042_lighting_v3');
    expect(text).toContain('Step: Render');
    expect(deps.jobs.getJobCalls).toHaveLength(1);
  });
});

describe('EventBridge redelivery', () => {
  test('a redelivered event sends nothing a second time', async () => {
    const deps = fakes();
    deps.preferences.set(ALEX, {
      channels: ['EMAIL', 'SLACK'],
      slackWebhookSecretArn: secretArn('alex-slack'),
    });
    deps.transport.secrets.set(secretArn('alex-slack'), SLACK_URL);

    await handleEvent(jobFailedEvent('same-event'), config(), deps);
    const second = await handleEvent(jobFailedEvent('same-event'), config(), deps);

    expect(deps.transport.emails).toHaveLength(1);
    expect(deps.transport.webhooks).toHaveLength(1);
    expect(second.outcomes).toEqual({ SENT: 0, DUPLICATE: 2, FAILED: 0, RETRY: 0 });
  });

  test('a different event about the same job is delivered again', async () => {
    // A job that is requeued and fails a second time publishes a new event, and
    // its submitter should hear about it.
    const deps = fakes();
    await handleEvent(jobFailedEvent('first-failure'), config(), deps);
    await handleEvent(jobFailedEvent('second-failure'), config(), deps);

    expect(deps.transport.emails).toHaveLength(2);
  });

  test('a transient failure throws, and the retry sends only what did not go out', async () => {
    const deps = fakes();
    deps.preferences.set(ALEX, {
      channels: ['EMAIL', 'SLACK'],
      slackWebhookSecretArn: secretArn('alex-slack'),
    });
    deps.transport.secrets.set(secretArn('alex-slack'), SLACK_URL);
    deps.transport.failures.set(SLACK_URL, new Error('socket hang up'));

    const first = handleEvent(jobFailedEvent('flaky'), config(), deps);
    await expect(first).rejects.toBeInstanceOf(RetryableDeliveryError);
    expect(deps.transport.emails).toHaveLength(1);

    deps.transport.failures.clear();
    const retry = await handleEvent(jobFailedEvent('flaky'), config(), deps);

    expect(deps.transport.emails).toHaveLength(1);
    expect(deps.transport.webhooks).toHaveLength(1);
    expect(retry.outcomes).toEqual({ SENT: 1, DUPLICATE: 1, FAILED: 0, RETRY: 0 });
  });

  test('a permanent failure is recorded and not retried', async () => {
    const deps = fakes();
    deps.preferences.set(ALEX, {
      channels: ['SLACK'],
      slackWebhookSecretArn: secretArn('alex-slack'),
    });
    deps.transport.secrets.set(secretArn('alex-slack'), SLACK_URL);
    deps.transport.failures.set(SLACK_URL, new PermanentError('revoked', 'WebhookHttp404'));

    const summary = await handleEvent(jobFailedEvent('revoked'), config(), deps);
    expect(summary.outcomes.FAILED).toBe(1);

    deps.transport.failures.clear();
    const again = await handleEvent(jobFailedEvent('revoked'), config(), deps);
    expect(again.outcomes.DUPLICATE).toBe(1);
    expect(deps.transport.webhooks).toEqual([]);
  });

  test('a delivery another invocation is still making is retried, not dropped', async () => {
    const deps = fakes();
    // Claim the delivery as a concurrent invocation would, without finishing it.
    const event = jobFailedEvent('concurrent');
    await deps.ledger.claim(
      deliveryKey(`event:${event.id}`, { channel: 'EMAIL', address: 'alex@studio.example.com' }),
      event.id,
      'EMAIL',
    );

    await expect(handleEvent(event, config(), deps)).rejects.toBeInstanceOf(RetryableDeliveryError);
    expect(deps.transport.emails).toEqual([]);
  });
});

describe('logging', () => {
  test('never logs a webhook URL or a full email address', async () => {
    const deps = fakes();
    deps.preferences.set(ALEX, {
      channels: ['EMAIL', 'SLACK'],
      slackWebhookSecretArn: secretArn('alex-slack'),
    });
    deps.transport.secrets.set(secretArn('alex-slack'), SLACK_URL);
    await handleEvent(jobFailedEvent(), config(), deps);

    const logged = deps.log.text();
    expect(logged).not.toContain('alexsecret');
    expect(logged).not.toContain('alex@studio.example.com');
    expect(logged).toContain('a***@studio.example.com');
  });

  test('records a summary line for every event', async () => {
    const deps = fakes();
    await handleEvent(jobFailedEvent('summarized'), config(), deps);
    expect(deps.log.entries).toContainEqual(
      expect.objectContaining({
        message: 'Event processed',
        fields: expect.objectContaining({ eventId: 'summarized', kind: 'JOB_FAILED' }),
      }),
    );
  });
});

describe('unrelated events', () => {
  test('an event type the function does not handle is ignored', async () => {
    const deps = fakes();
    const summary = await handleEvent(
      deadlineEvent('Fleet Size Recommendation Change', { farmId: FARM_ID }),
      config(),
      deps,
    );
    expect(summary.ignoredReason).toBe('NotANotifiableEvent');
  });
});
