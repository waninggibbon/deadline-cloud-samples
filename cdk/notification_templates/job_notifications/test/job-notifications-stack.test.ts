// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.

// Assertions over the synthesized template: what the stack deploys, what it
// listens for, what its function may do, and what it must never expose.

import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';

import { JobNotificationsStack, JobNotificationsStackProps } from '../lib/job-notifications-stack';

const ENV = { account: '123456789012', region: 'us-west-2' };

function synth(props: JobNotificationsStackProps = {}): Template {
  // Skip bundling the function: these tests are about the template, and the
  // function's code is tested on its own under test/lambda/.
  const app = new cdk.App({ context: { 'aws:cdk:bundling-stacks': [] } });
  return Template.fromStack(new JobNotificationsStack(app, 'Notifications', { env: ENV, ...props }));
}

interface Statement {
  Sid?: string;
  Effect: string;
  Action: string | string[];
  Resource: unknown;
  Condition?: Record<string, unknown>;
}

function functionStatements(template: Template): Statement[] {
  return Object.values(template.findResources('AWS::IAM::Policy')).flatMap(
    (policy) => policy.Properties.PolicyDocument.Statement as Statement[],
  );
}

function actions(statement: Statement): string[] {
  return Array.isArray(statement.Action) ? statement.Action : [statement.Action];
}

function rulesByDetailType(template: Template): Record<string, any> {
  return Object.fromEntries(
    Object.values(template.findResources('AWS::Events::Rule')).flatMap((rule) =>
      (rule.Properties.EventPattern['detail-type'] as string[]).map((type) => [type, rule.Properties]),
    ),
  );
}

describe('resources', () => {
  const template = synth();

  test('one function, on a current Node.js runtime', () => {
    template.resourceCountIs('AWS::Lambda::Function', 1);
    template.hasResourceProperties('AWS::Lambda::Function', {
      Runtime: 'nodejs24.x',
      Architectures: ['arm64'],
      Timeout: 30,
    });
  });

  test('a preferences table keyed by principal, with point-in-time recovery', () => {
    template.hasResourceProperties('AWS::DynamoDB::GlobalTable', {
      KeySchema: [{ AttributeName: 'principalId', KeyType: 'HASH' }],
      Replicas: [Match.objectLike({ PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true } })],
    });
  });

  test('a delivery table whose records expire', () => {
    template.hasResourceProperties('AWS::DynamoDB::GlobalTable', {
      KeySchema: [{ AttributeName: 'deliveryKey', KeyType: 'HASH' }],
      TimeToLiveSpecification: { AttributeName: 'expiresAt', Enabled: true },
    });
  });

  test('an encrypted dead-letter queue for both EventBridge and the function', () => {
    template.resourceCountIs('AWS::SQS::Queue', 1);
    template.hasResourceProperties('AWS::SQS::Queue', { SqsManagedSseEnabled: true });
    template.hasResourceProperties('AWS::Lambda::EventInvokeConfig', {
      MaximumRetryAttempts: 2,
      DestinationConfig: { OnFailure: { Destination: Match.anyValue() } },
    });
    for (const rule of Object.values(template.findResources('AWS::Events::Rule'))) {
      expect(rule.Properties.Targets[0].DeadLetterConfig).toBeDefined();
    }
  });

  test('a log group with a retention period', () => {
    template.hasResourceProperties('AWS::Logs::LogGroup', { RetentionInDays: 30 });
  });

  test('outputs what scripts/preferences.ts needs', () => {
    expect(Object.keys(template.findOutputs('*'))).toEqual(
      expect.arrayContaining(['PreferencesTableName', 'WebhookSecretPrefix', 'FunctionName']),
    );
    template.hasOutput('WebhookSecretPrefix', { Value: 'Notifications/webhooks/' });
  });
});

describe('no inbound endpoints', () => {
  const template = synth();

  test.each([
    'AWS::Lambda::Url',
    'AWS::ApiGateway::RestApi',
    'AWS::ApiGatewayV2::Api',
    'AWS::AppSync::GraphQLApi',
    'AWS::ElasticLoadBalancingV2::LoadBalancer',
  ])('has no %s', (type) => {
    template.resourceCountIs(type, 0);
  });

  test('only EventBridge rules in this stack may invoke the function', () => {
    const permissions = Object.values(template.findResources('AWS::Lambda::Permission'));
    expect(permissions.length).toBeGreaterThan(0);
    for (const permission of permissions) {
      expect(permission.Properties.Principal).toBe('events.amazonaws.com');
      expect(permission.Properties.SourceArn).toEqual({ 'Fn::GetAtt': [expect.any(String), 'Arn'] });
    }
  });
});

describe('event rules', () => {
  test('match only events from Deadline Cloud by default', () => {
    for (const rule of Object.values(synth().findResources('AWS::Events::Rule'))) {
      expect(rule.Properties.EventPattern.source).toEqual(['aws.deadline']);
      expect(rule.Properties.EventBusName).toBeUndefined();
    }
  });

  test('match the sources a test deployment names', () => {
    const template = synth({ eventSources: ['aws.deadline-test', 'test.deadline'] });
    for (const rule of Object.values(template.findResources('AWS::Events::Rule'))) {
      expect(rule.Properties.EventPattern.source).toEqual(['aws.deadline-test', 'test.deadline']);
    }
  });

  test('match only FAILED status changes', () => {
    const rules = rulesByDetailType(synth());
    expect(rules['Job Run Status Change'].EventPattern.detail).toEqual({ taskRunStatus: ['FAILED'] });
    expect(rules['Step Run Status Change'].EventPattern.detail).toEqual({ taskRunStatus: ['FAILED'] });
    expect(rules['Task Run Status Change'].EventPattern.detail).toEqual({ runStatus: ['FAILED'] });
  });

  test('enable one failure level, chosen by FailureNotificationLevel, defaulting to JOB', () => {
    const template = synth();
    template.hasParameter('FailureNotificationLevel', {
      Default: 'JOB',
      AllowedValues: ['JOB', 'STEP', 'TASK', 'NONE'],
    });
    const rules = rulesByDetailType(template);
    const conditions = template.toJSON().Conditions;
    for (const [type, level] of [
      ['Job Run Status Change', 'JOB'],
      ['Step Run Status Change', 'STEP'],
      ['Task Run Status Change', 'TASK'],
    ]) {
      const [conditionName, whenTrue, whenFalse] = rules[type].State['Fn::If'];
      expect([whenTrue, whenFalse]).toEqual(['ENABLED', 'DISABLED']);
      expect(conditions[conditionName]).toEqual({
        'Fn::Equals': [{ Ref: 'FailureNotificationLevel' }, level],
      });
    }
  });

  test('forward both step approval events, always enabled', () => {
    const rules = rulesByDetailType(synth());
    for (const type of ['Step Approval Requested', 'Step Approval Decided']) {
      expect(rules[type].State).toBe('ENABLED');
      expect(rules[type].EventPattern.detail).toBeUndefined();
    }
  });
});

describe('function permissions', () => {
  const template = synth();
  const statements = functionStatements(template);

  test('never grant every resource', () => {
    for (const statement of statements) {
      expect(statement.Effect).toBe('Allow');
      expect(statement.Resource).not.toEqual('*');
      for (const action of actions(statement)) {
        expect(action).not.toMatch(/\*$/);
      }
    }
  });

  test('read jobs, and nothing else in Deadline Cloud', () => {
    const deadline = statements.filter((s) => actions(s).some((a) => a.startsWith('deadline:')));
    expect(deadline).toHaveLength(1);
    expect(actions(deadline[0]).sort()).toEqual(['deadline:GetJob', 'deadline:GetStep']);
    expect(JSON.stringify(deadline[0].Resource)).toContain(':farm/*/queue/*/job/*');
  });

  test('read secrets under the webhook prefix only', () => {
    const [secrets] = statements.filter((s) => s.Sid === 'ReadWebhookSecrets');
    expect(actions(secrets)).toEqual(['secretsmanager:GetSecretValue']);
    expect(JSON.stringify(secrets.Resource)).toContain(':secret:Notifications/webhooks/*');
  });

  test('send email only as the configured sender', () => {
    const [ses] = statements.filter((s) => s.Sid === 'SendEmailFromSender');
    expect(actions(ses)).toEqual(['ses:SendEmail']);
    expect(ses.Condition).toEqual({
      StringEquals: { 'ses:FromAddress': { Ref: 'SenderEmailAddress' } },
    });
  });

  test('only read preferences, and only write delivery records', () => {
    const dynamo = statements.filter((s) => actions(s).some((a) => a.startsWith('dynamodb:')));
    const granted = dynamo.flatMap(actions).sort();
    expect(granted).toEqual([
      'dynamodb:DeleteItem',
      'dynamodb:GetItem',
      'dynamodb:PutItem',
      'dynamodb:UpdateItem',
    ]);
    const getItem = dynamo.find((s) => actions(s).includes('dynamodb:GetItem'))!;
    expect(JSON.stringify(getItem.Resource)).toContain('PreferencesTable');
    expect(JSON.stringify(getItem.Resource)).not.toContain('DeliveryTable');
  });

  test('look up only users, groups, and memberships in the configured identity store', () => {
    const [identity] = statements.filter((s) => s.Sid === 'ResolveIdentityCenterPrincipals');
    expect(actions(identity).sort()).toEqual([
      'identitystore:DescribeUser',
      'identitystore:ListGroupMemberships',
    ]);
    expect(JSON.stringify(identity.Resource)).toContain('{"Ref":"IdentityStoreId"}');
  });
});

describe('function configuration', () => {
  function environment(template: Template): Record<string, unknown> {
    const [fn] = Object.values(template.findResources('AWS::Lambda::Function'));
    return fn.Properties.Environment.Variables;
  }

  test('passes the monitor URL and every setting through from parameters', () => {
    const template = synth();
    template.hasParameter('MonitorUrl', { Type: 'String' });
    expect(template.toJSON().Parameters.MonitorUrl.Default).toBeUndefined();
    expect(environment(template)).toEqual(
      expect.objectContaining({
        MONITOR_URL: { Ref: 'MonitorUrl' },
        IDENTITY_STORE_ID: { Ref: 'IdentityStoreId' },
        SENDER_EMAIL_ADDRESS: { Ref: 'SenderEmailAddress' },
        MESSAGE_DETAIL: { Ref: 'MessageDetail' },
        NOTIFY_APPROVERS_OF_DECISION: { Ref: 'NotifyApproversOfDecision' },
        CLAIM_TIMEOUT_SECONDS: '45',
      }),
    );
  });

  test('keeps webhook URLs out of the environment', () => {
    expect(JSON.stringify(environment(synth()))).not.toMatch(/hooks\.(slack|chime)/);
  });

  test('defaults messages to the minimal detail level', () => {
    synth().hasParameter('MessageDetail', { Default: 'MINIMAL' });
  });

  test('reads jobs from an endpoint override only when one is given', () => {
    expect(environment(synth())).not.toHaveProperty('DEADLINE_ENDPOINT_URL');
    expect(
      environment(synth({ deadlineEndpointUrl: 'https://deadline.example.com' })),
    ).toHaveProperty('DEADLINE_ENDPOINT_URL', 'https://deadline.example.com');
  });

  test('refuses an empty list of event sources', () => {
    expect(() => synth({ eventSources: [] })).toThrow('eventSources');
  });
});
