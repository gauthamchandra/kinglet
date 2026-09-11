/**
 * Domain errors for Cloud Tasks. Live next to the service, not in the
 * repository — repositories used to import `TasksError` from `queue-service.ts`
 * and closed a cycle.
 */

export type TasksErrorCode =
  | 'NOT_FOUND'
  | 'ALREADY_EXISTS'
  | 'INVALID_ARGUMENT'
  | 'FAILED_PRECONDITION';

export class TasksError extends Error {
  readonly code: TasksErrorCode;

  constructor(code: TasksErrorCode, message: string) {
    super(message);
    this.name = 'TasksError';
    this.code = code;
  }
}
