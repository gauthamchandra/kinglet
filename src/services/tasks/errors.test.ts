import { expect, test } from 'bun:test';
import { TasksError } from './errors.ts';

test('TasksError carries a typed code', () => {
  const err = new TasksError('NOT_FOUND', 'Queue not found');

  expect(err).toBeInstanceOf(Error);
  expect(err.name).toBe('TasksError');
  expect(err.code).toBe('NOT_FOUND');
  expect(err.message).toBe('Queue not found');
});
