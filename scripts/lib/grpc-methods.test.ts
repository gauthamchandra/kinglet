import { describe, expect, test } from 'bun:test';
import * as grpc from '@grpc/grpc-js';
import { handlerAnswersUnimplemented } from './grpc-methods.ts';

describe('handlerAnswersUnimplemented', () => {
  test('a unary handler that callbacks UNIMPLEMENTED is a stub', async () => {
    const handler = (
      _call: { request: Record<string, never> },
      callback: (err: unknown) => void
    ) => {
      callback(
        Object.assign(new Error('GetIamPolicy not implemented'), {
          code: grpc.status.UNIMPLEMENTED,
        })
      );
    };

    expect(await handlerAnswersUnimplemented(handler)).toBe(true);
  });

  test('any other callback status is an implementation', async () => {
    const handler = (
      _call: { request: Record<string, never> },
      callback: (err: unknown) => void
    ) => {
      callback(
        Object.assign(new Error('name is required'), { code: grpc.status.INVALID_ARGUMENT })
      );
    };

    expect(await handlerAnswersUnimplemented(handler)).toBe(false);
  });

  test('a null callback error is an implementation', async () => {
    const handler = (
      _call: { request: Record<string, never> },
      callback: (err: unknown) => void
    ) => {
      callback(null);
    };

    expect(await handlerAnswersUnimplemented(handler)).toBe(false);
  });

  test('a handler that throws is an implementation', async () => {
    const handler = (
      _call: { request: Record<string, never> },
      _callback: (err: unknown) => void
    ) => {
      throw new Error('boom');
    };

    expect(await handlerAnswersUnimplemented(handler)).toBe(false);
  });

  test('a rejected promise is an implementation', async () => {
    const handler = async (
      _call: { request: Record<string, never> },
      _callback: (err: unknown) => void
    ) => {
      throw new Error('boom');
    };

    expect(await handlerAnswersUnimplemented(handler)).toBe(false);
  });

  test('a handler that never settles is an implementation', async () => {
    const handler = (
      _call: { request: Record<string, never> },
      _callback: (err: unknown) => void
    ) => {
      return undefined;
    };

    expect(await handlerAnswersUnimplemented(handler)).toBe(false);
  });

  test('a non-unary handler is an implementation', async () => {
    const handler = (_call: { request: Record<string, never> }) => {
      return undefined;
    };

    expect(await handlerAnswersUnimplemented(handler)).toBe(false);
  });
});
