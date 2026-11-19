// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.

// One JSON object per log line, so CloudWatch Logs Insights can filter on any
// field. Nothing here logs a webhook URL or a full email address: webhook URLs
// are bearer credentials, and email addresses are personal data.

export type LogFields = Record<string, unknown>;

export interface Logger {
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}

function write(level: string, message: string, fields: LogFields = {}): void {
  console.log(JSON.stringify({ level, message, ...fields }));
}

export const log: Logger = {
  info: (message, fields) => write('INFO', message, fields),
  warn: (message, fields) => write('WARN', message, fields),
  error: (message, fields) => write('ERROR', message, fields),
};

/**
 * An email address with all but the first character of its local part masked,
 * enough to tell two recipients apart in a log without recording who they are.
 */
export function redactEmail(address: string): string {
  const at = address.lastIndexOf('@');
  if (at <= 0) {
    return '***';
  }
  return `${address[0]}***${address.slice(at)}`;
}
