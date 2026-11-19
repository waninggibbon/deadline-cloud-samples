// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.

/**
 * A failure that retrying will not fix, such as a webhook that no longer exists
 * or an email address the sender is not allowed to send to.
 *
 * Any other error is treated as transient: the delivery is released so the
 * Lambda retry of the same event attempts it again.
 */
export class PermanentError extends Error {
  constructor(
    message: string,
    /** A short, log-safe reason code. */
    public readonly code: string,
  ) {
    super(message);
    this.name = 'PermanentError';
  }
}

/** Whether an error is one that retrying will not fix. */
export function isPermanent(error: unknown): error is PermanentError {
  return error instanceof PermanentError;
}

/** A short, log-safe description of an error, never including its payload. */
export function describeError(error: unknown): string {
  if (error instanceof PermanentError) {
    return error.code;
  }
  if (error instanceof Error) {
    return error.name;
  }
  return 'UnknownError';
}
