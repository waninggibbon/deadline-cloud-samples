// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.

// The Lambda entry point. EventBridge invokes it asynchronously with one event
// at a time, and Lambda retries an invocation that throws.

import type { Context } from 'aws-lambda';

import { createAwsDependencies } from './aws';
import { loadConfig } from './config';
import { DeadlineEvent } from './events';
import { log, setLogContext } from './log';
import { Summary, handleEvent } from './notify';

const config = loadConfig();
const dependencies = createAwsDependencies(config, log);

export async function handler(event: DeadlineEvent, context: Context): Promise<Summary> {
  setLogContext({ requestId: context.awsRequestId });
  return handleEvent(event, config, dependencies);
}
