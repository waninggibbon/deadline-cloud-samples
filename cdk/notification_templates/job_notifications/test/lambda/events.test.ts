// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.

// Parsing Deadline Cloud events and preferences items.

import { PermanentError } from '../../lambda/errors';
import { parseEvent, principalFromCreatedBy } from '../../lambda/events';
import { channelsFor, parsePreferences } from '../../lambda/preferences';
import {
  ALEX,
  FARM_ID,
  JOB_ID,
  PIPELINE_ROLE,
  QUEUE_ID,
  STEP_ID,
  TASK_ID,
  jobFailedEvent,
  stepFailedEvent,
  taskFailedEvent,
} from './fakes';

describe('parseEvent', () => {
  test.each([
    ['a failed job', jobFailedEvent(), 'JOB_FAILED', { farmId: FARM_ID, queueId: QUEUE_ID, jobId: JOB_ID }],
    [
      'a failed step',
      stepFailedEvent(),
      'STEP_FAILED',
      { farmId: FARM_ID, queueId: QUEUE_ID, jobId: JOB_ID, stepId: STEP_ID },
    ],
    [
      'a failed task',
      taskFailedEvent(),
      'TASK_FAILED',
      { farmId: FARM_ID, queueId: QUEUE_ID, jobId: JOB_ID, stepId: STEP_ID, taskId: TASK_ID },
    ],
  ])('reads %s', (_, event, kind, ids) => {
    expect(parseEvent(event)).toEqual({ kind, ids });
  });

  test.each(['SUCCEEDED', 'CANCELED', 'RUNNING', undefined])(
    'ignores a job entering %s',
    (status) => {
      const event = jobFailedEvent();
      expect(parseEvent({ ...event, detail: { ...event.detail, taskRunStatus: status } })).toBeUndefined();
    },
  );

  test('treats a FAILED event with no job ID as malformed', () => {
    const event = jobFailedEvent();
    const { jobId: _, ...detail } = event.detail;
    expect(() => parseEvent({ ...event, detail })).toThrow(PermanentError);
  });
});

describe('principalFromCreatedBy', () => {
  test('an ARN is an IAM principal', () => {
    expect(principalFromCreatedBy(PIPELINE_ROLE)).toEqual({ type: 'IAM', id: PIPELINE_ROLE });
  });

  test('anything else is an Identity Center user ID', () => {
    expect(principalFromCreatedBy(ALEX)).toEqual({ type: 'USER', id: ALEX });
  });
});

describe('preferences', () => {
  test('drops unknown channels and notification kinds', () => {
    const preferences = parsePreferences({
      principalId: ALEX,
      channels: new Set(['EMAIL', 'SMS']),
      mutedNotifications: ['JOB_FAILED', 'EVERYTHING'],
      email: '  ',
    });
    expect(preferences).toEqual({
      principalId: ALEX,
      channels: ['EMAIL'],
      email: undefined,
      slackWebhookSecretArn: undefined,
      chimeWebhookSecretArn: undefined,
      mutedNotifications: ['JOB_FAILED'],
    });
  });

  test('defaults a user to email and a group to nothing', () => {
    expect(channelsFor('USER', undefined, 'JOB_FAILED')).toEqual(['EMAIL']);
    expect(channelsFor('GROUP', undefined, 'APPROVAL_REQUESTED')).toEqual([]);
  });
});
