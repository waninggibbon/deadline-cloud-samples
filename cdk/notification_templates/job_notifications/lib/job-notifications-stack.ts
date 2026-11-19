// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.

import * as path from 'node:path';

import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as destinations from 'aws-cdk-lib/aws-lambda-destinations';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';

import { DETAIL_TYPES } from '../lambda/events';

/** The level failures are reported at, chosen with the `FailureNotificationLevel` parameter. */
export const FAILURE_LEVELS = ['JOB', 'STEP', 'TASK', 'NONE'] as const;

export interface JobNotificationsStackProps extends cdk.StackProps {
  /**
   * The EventBridge `source` values the rules match.
   *
   * Deadline Cloud publishes as `aws.deadline`. Only AWS services can publish
   * events with an `aws.` source, so with the default no principal in the
   * account can forge an event that makes this stack send messages. Add another
   * source only for a test deployment, since anyone allowed to call
   * `events:PutEvents` on the default event bus could then trigger
   * notifications.
   *
   * @default ['aws.deadline']
   */
  readonly eventSources?: readonly string[];
  /**
   * A Deadline Cloud API endpoint to read jobs from instead of the default
   * regional endpoint, such as a pre-release stage that publishes test events.
   *
   * @default the regional Deadline Cloud endpoint
   */
  readonly deadlineEndpointUrl?: string;
}

/**
 * Sends AWS Deadline Cloud job failure and step approval notifications to the
 * people involved, by email, Slack, or Amazon Chime.
 *
 * EventBridge rules on the account's default event bus forward the Deadline
 * Cloud events to a Lambda function. The function works out who each event is
 * for (a failed job's submitter, or a step's approvers), applies each
 * person's preferences from a DynamoDB table, and sends a short message
 * linking to the job or step in Deadline Cloud monitor.
 *
 * Nothing in the stack accepts inbound requests. There is no function URL and
 * no API, and no message carries an approve or reject action: approvals are
 * recorded in monitor by someone signed in to it.
 */
export class JobNotificationsStack extends cdk.Stack {
  /** One item per principal: the channels, addresses, and mutes from scripts/preferences.ts. */
  public readonly preferencesTable: dynamodb.TableV2;
  /** Records of deliveries already made, so a redelivered event is not sent twice. */
  public readonly deliveryTable: dynamodb.TableV2;
  /** The function that resolves recipients and sends messages. */
  public readonly function: nodejs.NodejsFunction;
  /** Events and invocations that still failed after every retry. */
  public readonly deadLetterQueue: sqs.Queue;
  /** The name prefix every webhook secret must have for the function to read it. */
  public readonly webhookSecretPrefix: string;

  constructor(scope: Construct, id: string, props: JobNotificationsStackProps = {}) {
    super(scope, id, props);

    const eventSources = props.eventSources ?? ['aws.deadline'];
    if (eventSources.length === 0) {
      throw new Error('eventSources must name at least one EventBridge source.');
    }

    // ----------------------------------------------------------------- Inputs

    const monitorUrl = new cdk.CfnParameter(this, 'MonitorUrl', {
      type: 'String',
      description:
        'The URL of your Deadline Cloud monitor, such as https://<name>.<region>.deadlinecloud.amazonaws.com. ' +
        'Every message links to the job or step on it.',
      allowedPattern: '^(https://[^\\s|<>]+|http://localhost(:[0-9]+)?(/[^\\s|<>]*)?)$',
      constraintDescription: 'must be an https:// URL, or http://localhost for local development.',
    });
    const identityStoreId = new cdk.CfnParameter(this, 'IdentityStoreId', {
      type: 'String',
      default: '',
      description:
        'The ID of the IAM Identity Center identity store your monitor uses, such as d-1234567890. ' +
        'It is used to look up email addresses and group members. Leave empty to rely on preferences only.',
      allowedPattern: '^(d-[0-9a-f]{10}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?$',
    });
    const identityStoreRegion = new cdk.CfnParameter(this, 'IdentityStoreRegion', {
      type: 'String',
      default: '',
      description:
        'The Region of your IAM Identity Center instance, when it is not the Region of this stack.',
      allowedPattern: '^([a-z]{2}(-[a-z]+)+-[0-9]+)?$',
    });
    const senderEmailAddress = new cdk.CfnParameter(this, 'SenderEmailAddress', {
      type: 'String',
      default: '',
      description:
        'The address email is sent from. It must be an Amazon SES verified identity, or in a verified domain. ' +
        'Leave empty to disable email.',
      allowedPattern: '^([^\\s@]+@[^\\s@]+)?$',
    });
    const failureLevel = new cdk.CfnParameter(this, 'FailureNotificationLevel', {
      type: 'String',
      default: 'JOB',
      allowedValues: [...FAILURE_LEVELS],
      description:
        'JOB sends one message when a job fails. STEP sends one per failed step, and TASK one per failed task, ' +
        'which can be many for a large job. NONE turns failure notifications off.',
    });
    const messageDetail = new cdk.CfnParameter(this, 'MessageDetail', {
      type: 'String',
      default: 'MINIMAL',
      allowedValues: ['MINIMAL', 'NAMES'],
      description:
        'MINIMAL messages say what happened and link to monitor. NAMES also includes the job and step names, ' +
        'which may be confidential.',
    });
    const notifyApprovers = new cdk.CfnParameter(this, 'NotifyApproversOfDecision', {
      type: 'String',
      default: 'false',
      allowedValues: ['true', 'false'],
      description:
        "Whether a step's approvers are told when an approval is decided, as well as the job's submitter.",
    });

    this.templateOptions.metadata = {
      'AWS::CloudFormation::Interface': {
        ParameterGroups: [
          {
            Label: { default: 'Where messages link to and come from' },
            Parameters: [monitorUrl.logicalId, senderEmailAddress.logicalId],
          },
          {
            Label: { default: 'Who is notified' },
            Parameters: [
              identityStoreId.logicalId,
              identityStoreRegion.logicalId,
              notifyApprovers.logicalId,
            ],
          },
          {
            Label: { default: 'What is notified' },
            Parameters: [failureLevel.logicalId, messageDetail.logicalId],
          },
        ],
      },
    };

    // ---------------------------------------------------------------- Storage

    this.preferencesTable = new dynamodb.TableV2(this, 'PreferencesTable', {
      partitionKey: { name: 'principalId', type: dynamodb.AttributeType.STRING },
      billing: dynamodb.Billing.onDemand(),
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    this.deliveryTable = new dynamodb.TableV2(this, 'DeliveryTable', {
      partitionKey: { name: 'deliveryKey', type: dynamodb.AttributeType.STRING },
      billing: dynamodb.Billing.onDemand(),
      timeToLiveAttribute: 'expiresAt',
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    this.deadLetterQueue = new sqs.Queue(this, 'DeadLetterQueue', {
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      retentionPeriod: cdk.Duration.days(14),
    });

    // Webhook URLs live in Secrets Manager, one secret per person and channel,
    // created by scripts/preferences.ts under this prefix. The function can
    // read secrets under it and no others.
    this.webhookSecretPrefix = `${this.stackName}/webhooks/`;

    // --------------------------------------------------------------- Function

    const timeout = cdk.Duration.seconds(30);

    const logGroup = new logs.LogGroup(this, 'FunctionLogs', {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    this.function = new nodejs.NodejsFunction(this, 'Function', {
      description: 'Delivers AWS Deadline Cloud job failure and step approval notifications.',
      entry: path.join(__dirname, '..', 'lambda', 'index.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 256,
      timeout,
      logGroup,
      // EventBridge invokes the function asynchronously. An invocation that
      // throws, which it does when a delivery fails transiently, is retried
      // twice, and then recorded on the dead-letter queue.
      retryAttempts: 2,
      maxEventAge: cdk.Duration.hours(6),
      onFailure: new destinations.SqsDestination(this.deadLetterQueue),
      bundling: {
        // Bundle the SDK clients rather than using the runtime's copy, so the
        // function runs the versions in package-lock.json.
        externalModules: [],
        minify: true,
        sourceMap: true,
      },
      environment: {
        NODE_OPTIONS: '--enable-source-maps',
        PREFERENCES_TABLE_NAME: this.preferencesTable.tableName,
        DELIVERY_TABLE_NAME: this.deliveryTable.tableName,
        MONITOR_URL: monitorUrl.valueAsString,
        IDENTITY_STORE_ID: identityStoreId.valueAsString,
        IDENTITY_STORE_REGION: identityStoreRegion.valueAsString,
        SENDER_EMAIL_ADDRESS: senderEmailAddress.valueAsString,
        MESSAGE_DETAIL: messageDetail.valueAsString,
        NOTIFY_APPROVERS_OF_DECISION: notifyApprovers.valueAsString,
        WEBHOOK_SECRET_ARN_PREFIX: this.formatArn({
          service: 'secretsmanager',
          resource: 'secret',
          resourceName: this.webhookSecretPrefix,
          arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME,
        }),
        // Longer than the timeout, so a claim is only taken over once the
        // invocation that made it has certainly stopped.
        CLAIM_TIMEOUT_SECONDS: String(timeout.toSeconds() + 15),
        ...(props.deadlineEndpointUrl ? { DEADLINE_ENDPOINT_URL: props.deadlineEndpointUrl } : {}),
      },
    });

    // ------------------------------------------------------------ Permissions

    this.preferencesTable.grant(this.function, 'dynamodb:GetItem');
    this.deliveryTable.grant(
      this.function,
      'dynamodb:PutItem',
      'dynamodb:UpdateItem',
      'dynamodb:DeleteItem',
    );

    this.function.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'ReadJobs',
        // GetJob for the submitter; GetStep only when MessageDetail is NAMES.
        // Deadline Cloud authorizes both against the job.
        actions: ['deadline:GetJob', 'deadline:GetStep'],
        resources: [
          this.formatArn({ service: 'deadline', resource: 'farm', resourceName: '*/queue/*/job/*' }),
        ],
      }),
    );

    this.function.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'ResolveIdentityCenterPrincipals',
        actions: ['identitystore:DescribeUser', 'identitystore:ListGroupMemberships'],
        resources: [
          cdk.Arn.format({
            partition: this.partition,
            service: 'identitystore',
            region: '',
            account: this.account,
            resource: 'identitystore',
            resourceName: identityStoreId.valueAsString,
          }),
          ...['user/*', 'group/*', 'membership/*'].map((resource) =>
            cdk.Arn.format({
              partition: this.partition,
              service: 'identitystore',
              region: '',
              account: '',
              resource,
            }),
          ),
        ],
      }),
    );

    this.function.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'ReadWebhookSecrets',
        actions: ['secretsmanager:GetSecretValue'],
        resources: [
          this.formatArn({
            service: 'secretsmanager',
            resource: 'secret',
            resourceName: `${this.webhookSecretPrefix}*`,
            arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME,
          }),
        ],
      }),
    );

    this.function.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'SendEmailFromSender',
        actions: ['ses:SendEmail'],
        resources: [this.formatArn({ service: 'ses', resource: 'identity', resourceName: '*' })],
        // Only ever as the configured sender, whichever identity verifies it.
        conditions: { StringEquals: { 'ses:FromAddress': senderEmailAddress.valueAsString } },
      }),
    );

    // ------------------------------------------------------------------ Rules

    const target = new targets.LambdaFunction(this.function, {
      deadLetterQueue: this.deadLetterQueue,
      retryAttempts: 8,
      maxEventAge: cdk.Duration.hours(2),
    });

    // One rule per failure level, all deployed, with the one the
    // FailureNotificationLevel parameter picks enabled. Changing the level is
    // then a parameter update that switches rules on and off.
    const failureRules: [string, string, Record<string, string[]>][] = [
      ['JOB', DETAIL_TYPES.jobRunStatusChange, { taskRunStatus: ['FAILED'] }],
      ['STEP', DETAIL_TYPES.stepRunStatusChange, { taskRunStatus: ['FAILED'] }],
      ['TASK', DETAIL_TYPES.taskRunStatusChange, { runStatus: ['FAILED'] }],
    ];
    for (const [level, detailType, detail] of failureRules) {
      const name = level.charAt(0) + level.slice(1).toLowerCase();
      const rule = new events.Rule(this, `${name}FailedRule`, {
        description: `Forwards Deadline Cloud ${detailType} events for FAILED to the notification function.`,
        eventPattern: { source: [...eventSources], detailType: [detailType], detail },
        targets: [target],
      });
      const enabled = new cdk.CfnCondition(this, `${name}FailureNotificationsEnabled`, {
        expression: cdk.Fn.conditionEquals(failureLevel.valueAsString, level),
      });
      (rule.node.defaultChild as events.CfnRule).state = cdk.Fn.conditionIf(
        enabled.logicalId,
        'ENABLED',
        'DISABLED',
      ).toString();
    }

    new events.Rule(this, 'StepApprovalRule', {
      description: 'Forwards Deadline Cloud step approval events to the notification function.',
      eventPattern: {
        source: [...eventSources],
        detailType: [DETAIL_TYPES.stepApprovalRequested, DETAIL_TYPES.stepApprovalDecided],
      },
      targets: [target],
    });

    // --------------------------------------------------------------- Alarming

    new cloudwatch.Alarm(this, 'DeadLetterQueueAlarm', {
      alarmDescription:
        'Notifications that could not be delivered after every retry are waiting on the dead-letter queue.',
      metric: this.deadLetterQueue.metricApproximateNumberOfMessagesVisible({
        period: cdk.Duration.minutes(5),
      }),
      threshold: 0,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    // ---------------------------------------------------------------- Outputs

    new cdk.CfnOutput(this, 'PreferencesTableName', {
      value: this.preferencesTable.tableName,
      description: 'The DynamoDB table of notification preferences. Edit it with scripts/preferences.ts.',
    });
    new cdk.CfnOutput(this, 'WebhookSecretPrefix', {
      value: this.webhookSecretPrefix,
      description: 'The Secrets Manager name prefix the function reads webhook URLs from.',
    });
    new cdk.CfnOutput(this, 'FunctionName', {
      value: this.function.functionName,
      description: 'The notification function. Its log group shows every event and delivery.',
    });
    new cdk.CfnOutput(this, 'FunctionLogGroupName', {
      value: logGroup.logGroupName,
      description: 'The log group of the notification function.',
    });
    new cdk.CfnOutput(this, 'DeadLetterQueueUrl', {
      value: this.deadLetterQueue.queueUrl,
      description: 'Events and invocations that failed after every retry.',
    });
  }
}
