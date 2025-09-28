/**
 * Tests for runtime dependencies to ensure they're properly installed
 */

import { test, expect, describe } from 'bun:test';

describe('Runtime Dependencies', () => {
  test('should import @grpc/grpc-js', async () => {
    const grpc = await import('@grpc/grpc-js');
    expect(grpc).toBeDefined();
    expect(grpc.Server).toBeDefined();
    expect(grpc.ServerCredentials).toBeDefined();
  });

  test('should import @grpc/proto-loader', async () => {
    const protoLoader = await import('@grpc/proto-loader');
    expect(protoLoader).toBeDefined();
    expect(protoLoader.loadSync).toBeDefined();
  });

  test('should import zod', async () => {
    const { z } = await import('zod');
    expect(z).toBeDefined();
    expect(z.string).toBeDefined();
    expect(z.object).toBeDefined();

    // Test basic zod functionality
    const schema = z.object({
      name: z.string(),
      age: z.number(),
    });

    const result = schema.parse({ name: 'test', age: 25 });
    expect(result.name).toBe('test');
    expect(result.age).toBe(25);
  });

  test('should import pino', async () => {
    const pino = await import('pino');
    expect(pino.default).toBeDefined();

    // Test basic pino functionality
    const logger = pino.default({ level: 'error' });
    expect(logger).toBeDefined();
    expect(logger.info).toBeDefined();
    expect(logger.error).toBeDefined();
  });

  test('should import cron-parser', async () => {
    const parser = await import('cron-parser');
    expect(parser).toBeDefined();
    expect(parser.parseExpression).toBeDefined();

    // Test basic cron parsing
    const interval = parser.parseExpression('0 9 * * 1'); // Every Monday at 9 AM
    expect(interval).toBeDefined();
    expect(interval.next).toBeDefined();

    // Test that it actually works
    const nextRun = interval.next();
    expect(nextRun).toBeDefined();
    expect(nextRun.toDate).toBeDefined();
    expect(nextRun.toDate()).toBeInstanceOf(Date);
  });
});
