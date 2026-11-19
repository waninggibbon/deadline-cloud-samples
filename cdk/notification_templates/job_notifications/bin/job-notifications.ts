#!/usr/bin/env node
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.

import * as cdk from 'aws-cdk-lib';

import { JobNotificationsStack } from '../lib/job-notifications-stack';

/**
 * One stack, deployed with the Deadline Cloud monitor URL it links to:
 *
 *   cdk deploy DeadlineJobNotifications --parameters MonitorUrl=https://<name>.<region>.deadlinecloud.amazonaws.com
 *
 * The rest of the stack's parameters, such as the email sender and the level
 * failures are reported at, are described in the README.md alongside this app.
 *
 * Three context values change the stack for a test deployment, without editing
 * this file:
 *
 * - `stackName`: deploy a second copy under another name.
 * - `eventSources`: a comma-separated list of EventBridge sources to match
 *   instead of `aws.deadline`.
 * - `deadlineEndpointUrl`: a Deadline Cloud API endpoint to read jobs from.
 */
const app = new cdk.App();

const stackName: string = app.node.tryGetContext('stackName') ?? 'DeadlineJobNotifications';
const eventSources: string | undefined = app.node.tryGetContext('eventSources');
const deadlineEndpointUrl: string | undefined = app.node.tryGetContext('deadlineEndpointUrl');

new JobNotificationsStack(app, stackName, {
  // Resolve the account and region from the ambient AWS credentials, so ARNs in
  // the function's IAM policy are built for the environment you deploy into.
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
  description:
    'Delivers AWS Deadline Cloud job failure and step approval notifications by email, Slack, ' +
    'and Amazon Chime. See the README.md alongside this CDK app to learn more.',
  eventSources: eventSources?.split(',').map((source) => source.trim()).filter(Boolean),
  deadlineEndpointUrl,
});

app.synth();
