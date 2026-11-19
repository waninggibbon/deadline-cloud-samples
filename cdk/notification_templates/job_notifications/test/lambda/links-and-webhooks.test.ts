// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.

// Monitor deep links, event ID validation, and webhook URL checks.

import { PermanentError } from '../../lambda/errors';
import { monitorLink, validateIds } from '../../lambda/links';
import { postWebhook, validateWebhookUrl } from '../../lambda/webhooks';
import { FARM_ID, JOB_ID, MONITOR_URL, QUEUE_ID, REGION, STEP_ID, TASK_ID } from './fakes';

describe('monitorLink', () => {
  const base = `${MONITOR_URL}/${REGION}/farms/${FARM_ID}/queues/${QUEUE_ID}`;

  test('opens the job on its queue page', () => {
    expect(monitorLink(MONITOR_URL, REGION, { farmId: FARM_ID, queueId: QUEUE_ID, jobId: JOB_ID })).toBe(
      `${base}?jobId=${JOB_ID}`,
    );
  });

  test('opens a step and a task', () => {
    const ids = { farmId: FARM_ID, queueId: QUEUE_ID, jobId: JOB_ID, stepId: STEP_ID, taskId: TASK_ID };
    expect(monitorLink(MONITOR_URL, REGION, ids)).toBe(
      `${base}?jobId=${JOB_ID}&stepId=${STEP_ID}&taskId=${TASK_ID}`,
    );
  });

  test('tolerates a trailing slash on the monitor URL', () => {
    expect(
      monitorLink(`${MONITOR_URL}/`, REGION, { farmId: FARM_ID, queueId: QUEUE_ID, jobId: JOB_ID }),
    ).toBe(`${base}?jobId=${JOB_ID}`);
  });
});

describe('validateIds', () => {
  const ids = { farmId: FARM_ID, queueId: QUEUE_ID, jobId: JOB_ID };

  test('accepts Deadline Cloud IDs', () => {
    expect(() => validateIds({ ...ids, stepId: STEP_ID, taskId: TASK_ID }, REGION)).not.toThrow();
  });

  test.each([
    ['a path in a job ID', { ...ids, jobId: 'job-../../x' }, REGION],
    ['a missing queue ID', { ...ids, queueId: '' }, REGION],
    ['a query string in a step ID', { ...ids, stepId: `${STEP_ID}?approve=1` }, REGION],
    ['a task without its step', { ...ids, taskId: TASK_ID }, REGION],
    ['a host in the region', ids, 'evil.example/us-west-2'],
  ])('rejects %s', (_, badIds, region) => {
    expect(() => validateIds(badIds, region)).toThrow(PermanentError);
  });
});

describe('validateWebhookUrl', () => {
  test.each([
    ['SLACK', 'https://hooks.slack.com/services/T0/B0/x'],
    ['SLACK', 'https://hooks.slack-gov.com/services/T0/B0/x'],
    ['CHIME', 'https://hooks.chime.aws/incomingwebhooks/abc?token=x'],
  ] as const)('accepts a %s webhook', (channel, url) => {
    expect(validateWebhookUrl(channel, url).toString()).toBe(url);
  });

  test.each([
    ['SLACK', 'http://hooks.slack.com/services/T0/B0/x', 'plain HTTP'],
    ['SLACK', 'https://hooks.slack.com.evil.example/services/x', 'a lookalike host'],
    ['SLACK', 'https://hooks.chime.aws/incomingwebhooks/abc', "another channel's host"],
    ['SLACK', 'https://user:pass@hooks.slack.com/services/x', 'credentials'],
    ['SLACK', 'https://hooks.slack.com:8443/services/x', 'a port'],
    ['CHIME', 'https://169.254.169.254/latest/meta-data/', 'an internal address'],
    ['CHIME', 'not a url', 'something other than a URL'],
  ] as const)('refuses a %s webhook with %s', (channel, url, _reason) => {
    expect(() => validateWebhookUrl(channel, url)).toThrow(PermanentError);
  });
});

describe('postWebhook', () => {
  const url = new URL('https://hooks.slack.com/services/T0/B0/x');

  function respondingWith(status: number) {
    const calls: RequestInit[] = [];
    const fetchImpl = async (_: URL, init: RequestInit) => {
      calls.push(init);
      return new Response(null, { status });
    };
    return { calls, fetchImpl };
  }

  test('posts JSON and refuses to follow redirects', async () => {
    const { calls, fetchImpl } = respondingWith(200);
    await postWebhook(url, { text: 'hi' }, fetchImpl);
    expect(calls[0]).toEqual(
      expect.objectContaining({ method: 'POST', body: '{"text":"hi"}', redirect: 'error' }),
    );
  });

  test.each([400, 403, 404, 410])('treats HTTP %i as permanent', async (status) => {
    await expect(postWebhook(url, {}, respondingWith(status).fetchImpl)).rejects.toThrow(
      PermanentError,
    );
  });

  test.each([429, 500, 503])('leaves HTTP %i to the retry', async (status) => {
    const failure = postWebhook(url, {}, respondingWith(status).fetchImpl);
    await expect(failure).rejects.toThrow(`HTTP ${status}`);
    await expect(failure).rejects.not.toBeInstanceOf(PermanentError);
  });
});
