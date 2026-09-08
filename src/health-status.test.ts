import { describe, expect, test } from 'bun:test';
import { buildHealthBody } from './health-status.ts';

describe('buildHealthBody', () => {
  test('omits the evaluation server when Compute is disabled', () => {
    expect(buildHealthBody()).toEqual({ status: 'ok' });
  });

  test('reports a bound evaluation server', () => {
    expect(
      buildHealthBody({
        started: true,
        port: 8787,
        bind: '0.0.0.0',
      })
    ).toEqual({
      status: 'ok',
      kingletCloudArmorEvaluationServer: {
        started: true,
        port: 8787,
        bind: '0.0.0.0',
      },
    });
  });

  test('reports a requested evaluation server that did not bind', () => {
    expect(
      buildHealthBody({
        started: false,
        bind: '127.0.0.1',
      })
    ).toEqual({
      status: 'ok',
      kingletCloudArmorEvaluationServer: {
        started: false,
        bind: '127.0.0.1',
      },
    });
  });
});
