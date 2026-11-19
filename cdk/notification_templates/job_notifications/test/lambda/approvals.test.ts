// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.

// Step approval events, from EventBridge envelope to delivered message.

import { parseApprovers } from '../../lambda/approval-events';
import { handleEvent } from '../../lambda/notify';
import {
  ALEX,
  APPROVAL_REQUEST_ID,
  FARM_ID,
  IDENTITY_STORE_ID,
  JOB_ID,
  LEADS_GROUP,
  MONITOR_URL,
  PIPELINE_ROLE,
  QUEUE_ID,
  REGION,
  ROBIN,
  SAM,
  STEP_ID,
  approvalDecidedEvent,
  approvalRequestedEvent,
  approver,
  config,
  fakes,
  urlsIn,
} from './fakes';

const STEP_LINK = `${MONITOR_URL}/${REGION}/farms/${FARM_ID}/queues/${QUEUE_ID}?jobId=${JOB_ID}&stepId=${STEP_ID}`;
const APPROVAL_PAGE =
  `${MONITOR_URL}/${REGION}/farms/${FARM_ID}/queues/${QUEUE_ID}/jobs/${JOB_ID}/approval` +
  `?stepId=${STEP_ID}&approvalRequestId=${APPROVAL_REQUEST_ID}`;

function recipientsOf(deps: ReturnType<typeof fakes>): string[] {
  return deps.transport.emails.map((email) => email.to).sort();
}

describe('Step Approval Requested', () => {
  test('notifies every approver, expanding groups, and not the submitter', async () => {
    const deps = fakes();
    await handleEvent(
      approvalRequestedEvent([approver('USER', SAM), approver('GROUP', LEADS_GROUP)]),
      config(),
      deps,
    );

    expect(recipientsOf(deps)).toEqual(['robin@studio.example.com', 'sam@studio.example.com']);
    expect(deps.transport.emails[0].content.subject).toBe(
      '[Deadline Cloud] Step waiting for your approval',
    );
  });

  test('needs no GetJob call, since the event names everyone', async () => {
    const deps = fakes();
    await handleEvent(approvalRequestedEvent([approver('USER', SAM)]), config(), deps);
    expect(deps.jobs.getJobCalls).toEqual([]);
  });

  test('links to the step, and only to the step', async () => {
    const deps = fakes();
    await handleEvent(approvalRequestedEvent([approver('USER', SAM)]), config(), deps);

    const { text, html } = deps.transport.emails[0].content;
    expect(urlsIn(text)).toEqual([STEP_LINK]);
    expect(urlsIn(html).map((url) => url.replace(/&amp;/g, '&'))).toEqual([STEP_LINK]);
  });

  test("links to monitor's approval page when ApprovalLinkTarget says it exists", async () => {
    const deps = fakes();
    await handleEvent(
      approvalRequestedEvent([approver('USER', SAM)]),
      config({ approvalLinkTarget: 'APPROVAL_PAGE' }),
      deps,
    );
    expect(urlsIn(deps.transport.emails[0].content.text)).toEqual([APPROVAL_PAGE]);
  });

  test('a queue with no approvers notifies nobody, and says so', async () => {
    const deps = fakes();
    const summary = await handleEvent(approvalRequestedEvent([]), config(), deps);
    expect(summary.recipients).toBe(0);
    expect(deps.log.entries.map((entry) => entry.message)).toContain('Event names nobody to notify');
  });

  test('the same request published again under a new event ID is not sent twice', async () => {
    const deps = fakes();
    const approvers = [approver('USER', SAM)];
    await handleEvent(approvalRequestedEvent(approvers, {}, 'first-publish'), config(), deps);
    const again = await handleEvent(approvalRequestedEvent(approvers, {}, 'republished'), config(), deps);

    expect(deps.transport.emails).toHaveLength(1);
    expect(again.outcomes.DUPLICATE).toBe(1);
  });

  test('a new request for the same step is a new notification', async () => {
    const deps = fakes();
    const approvers = [approver('USER', SAM)];
    await handleEvent(approvalRequestedEvent(approvers), config(), deps);
    await handleEvent(
      approvalRequestedEvent(approvers, {
        approvalRequestId: `approvalrequest-${'6'.repeat(32)}`,
        requestNumber: 2,
      }),
      config(),
      deps,
    );
    expect(deps.transport.emails).toHaveLength(2);
  });

  test('looks approvers up in the store the event names when none is configured', async () => {
    const deps = fakes();
    await handleEvent(
      approvalRequestedEvent([approver('USER', SAM, 'd-9999999999')]),
      config({ identityStoreId: undefined }),
      deps,
    );
    expect(deps.identity.lookups).toEqual([`d-9999999999/${SAM}`]);
    expect(recipientsOf(deps)).toEqual(['sam@studio.example.com']);
  });

  test('ignores an event whose status is not WAITING', async () => {
    const deps = fakes();
    const summary = await handleEvent(
      approvalRequestedEvent([approver('USER', SAM)], { approvalStatus: 'APPROVED' }),
      config(),
      deps,
    );
    expect(summary.ignoredReason).toBe('NotANotifiableEvent');
  });

  test('drops an event with a malformed approval request ID', async () => {
    const deps = fakes();
    const summary = await handleEvent(
      approvalRequestedEvent([approver('USER', SAM)], { approvalRequestId: 'approve-now' }),
      config(),
      deps,
    );
    expect(summary.ignoredReason).toBe('MalformedEvent');
    expect(deps.transport.emails).toEqual([]);
  });

  test('NAMES reads the job and step names; MINIMAL never does', async () => {
    const minimal = fakes();
    await handleEvent(approvalRequestedEvent([approver('USER', SAM)]), config(), minimal);
    expect(minimal.jobs.getJobCalls).toEqual([]);
    expect(minimal.jobs.getStepCalls).toEqual([]);
    expect(minimal.transport.emails[0].content.text).not.toContain('Step:');

    const named = fakes();
    await handleEvent(
      approvalRequestedEvent([approver('USER', SAM)]),
      config({ messageDetail: 'NAMES' }),
      named,
    );
    expect(named.transport.emails[0].content.text).toContain('Step: Render');
  });
});

describe('Step Approval Decided', () => {
  test("tells the job's submitter, from the event's jobCreatedBy, without reading the job", async () => {
    const deps = fakes();
    await handleEvent(
      approvalDecidedEvent('APPROVED', [approver('USER', SAM), approver('USER', ROBIN)]),
      config(),
      deps,
    );

    expect(recipientsOf(deps)).toEqual(['alex@studio.example.com']);
    expect(deps.transport.emails[0].content.subject).toBe('[Deadline Cloud] Step approved');
    expect(deps.jobs.getJobCalls).toEqual([]);
  });

  test.each([
    ['REJECTED', '[Deadline Cloud] Step rejected'],
    ['EXPIRED', '[Deadline Cloud] Step approval expired'],
  ] as const)('reports %s', async (status, subject) => {
    const deps = fakes();
    await handleEvent(approvalDecidedEvent(status, [approver('USER', SAM)]), config(), deps);
    expect(deps.transport.emails[0].content.subject).toBe(subject);
  });

  test('also tells the approvers when configured to, except whoever decided', async () => {
    const deps = fakes();
    await handleEvent(
      approvalDecidedEvent('APPROVED', [approver('GROUP', LEADS_GROUP)]),
      config({ notifyApproversOfDecision: true }),
      deps,
    );
    // SAM decided, so only the submitter and the other approver hear about it.
    expect(recipientsOf(deps)).toEqual(['alex@studio.example.com', 'robin@studio.example.com']);
  });

  test('a submitter who decided their own approval is not told about it', async () => {
    const deps = fakes();
    const summary = await handleEvent(
      approvalDecidedEvent('APPROVED', [approver('USER', ALEX)], { decidedBy: ALEX }),
      config(),
      deps,
    );
    expect(summary.recipients).toBe(0);
  });

  test("reads the job's submitter when the event does not name them", async () => {
    const deps = fakes();
    await handleEvent(
      approvalDecidedEvent('REJECTED', [], { jobCreatedBy: undefined }),
      config(),
      deps,
    );
    expect(deps.jobs.getJobCalls).toHaveLength(1);
    expect(recipientsOf(deps)).toEqual(['alex@studio.example.com']);
  });

  test('an IAM submitter is notified through its preferences', async () => {
    const deps = fakes();
    deps.preferences.set(PIPELINE_ROLE, { email: 'pipeline-team@studio.example.com' });
    await handleEvent(
      approvalDecidedEvent('REJECTED', [], { jobCreatedBy: PIPELINE_ROLE }),
      config(),
      deps,
    );
    expect(recipientsOf(deps)).toEqual(['pipeline-team@studio.example.com']);
  });

  test('the request being decided is a different notification from its request', async () => {
    const deps = fakes();
    await handleEvent(approvalRequestedEvent([approver('USER', ALEX)]), config(), deps);
    await handleEvent(approvalDecidedEvent('APPROVED', [approver('USER', ALEX)]), config(), deps);
    expect(deps.transport.emails.map((email) => email.content.subject)).toEqual([
      '[Deadline Cloud] Step waiting for your approval',
      '[Deadline Cloud] Step approved',
    ]);
  });

  test('ignores a status that is not a decision', async () => {
    const deps = fakes();
    const event = approvalDecidedEvent('APPROVED', []);
    const summary = await handleEvent(
      { ...event, detail: { ...event.detail, approvalStatus: 'WITHDRAWN' } },
      config(),
      deps,
    );
    expect(summary.ignoredReason).toBe('NotANotifiableEvent');
  });
});

describe('parseApprovers', () => {
  test('keeps well-formed users and groups and drops anything else', () => {
    expect(
      parseApprovers([
        approver('USER', SAM),
        approver('GROUP', LEADS_GROUP, 'not-a-store'),
        { principalType: 'ROLE', principalId: SAM, identityStoreId: IDENTITY_STORE_ID },
        { principalType: 'USER', principalId: 'arn:aws:iam::123456789012:user/x' },
        'USER',
        null,
      ]),
    ).toEqual([
      { type: 'USER', id: SAM, identityStoreId: IDENTITY_STORE_ID },
      { type: 'GROUP', id: LEADS_GROUP, identityStoreId: undefined },
    ]);
  });

  test('treats a missing list as no approvers', () => {
    expect(parseApprovers(undefined)).toEqual([]);
  });
});
