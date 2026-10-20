/**
 * A task outcome that retrying cannot fix: the evidence is missing, the agent
 * violated a scope rule, or an operator decision is required. The dispatcher
 * records these as terminal failures instead of burning attempts.
 */
export class TaskBlockedError extends Error {
  readonly retryable = false;

  constructor(
    message: string,
    readonly detail?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'TaskBlockedError';
  }
}
