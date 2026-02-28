/**
 * Cron Engine - wraps cron-parser for scheduling operations
 */

import parser from 'cron-parser';

export interface ValidationResult {
  valid: boolean;
  error?: string;
}

export class CronEngine {
  validate(expression: string): ValidationResult {
    if (!expression.trim()) {
      return { valid: false, error: 'Cron expression cannot be empty' };
    }

    try {
      parser.parseExpression(expression);

      return { valid: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);

      return { valid: false, error: message };
    }
  }

  getNextRunTime(expression: string, timezone?: string, from?: Date): Date {
    const options: Record<string, unknown> = {};

    if (timezone) {
      options.tz = timezone;
    }

    if (from) {
      options.currentDate = from;
    }

    const interval = parser.parseExpression(expression, options);

    return interval.next().toDate();
  }

  getPreviousRunTime(expression: string, timezone?: string, from?: Date): Date {
    const options: Record<string, unknown> = {};

    if (timezone) {
      options.tz = timezone;
    }

    if (from) {
      options.currentDate = from;
    }

    const interval = parser.parseExpression(expression, options);

    return interval.prev().toDate();
  }

  isDue(expression: string, timezone?: string, toleranceMs: number = 60000, now?: Date): boolean {
    const currentTime = now ?? new Date();

    try {
      const prev = this.getPreviousRunTime(expression, timezone, currentTime);
      const diff = currentTime.getTime() - prev.getTime();

      return diff >= 0 && diff <= toleranceMs;
    } catch {
      return false;
    }
  }
}
