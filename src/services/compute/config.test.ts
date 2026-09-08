/**
 * Config schema tests for compute service (TDD slice 4).
 */

import { describe, expect, test } from 'bun:test';
import { loadConfigFromEnv } from '@/config/loader.ts';

describe('compute config', () => {
  test('compute service is enabled by default', async () => {
    const config = await loadConfigFromEnv({});

    expect(config.services.compute.enabled).toBe(true);
  });

  test('ENABLE_COMPUTE=false disables compute', async () => {
    const config = await loadConfigFromEnv({ ENABLE_COMPUTE: 'false' });

    expect(config.services.compute.enabled).toBe(false);
  });

  test('SERVICES=compute enables compute', async () => {
    const config = await loadConfigFromEnv({ SERVICES: 'compute' });

    expect(config.services.compute.enabled).toBe(true);
    expect(config.services.pubsub.enabled).toBe(false);
  });

  test('COMPUTE_LISTENER_PORT sets listener port', async () => {
    const config = await loadConfigFromEnv({ COMPUTE_LISTENER_PORT: '9090' });

    expect(config.services.compute.listenerPort).toBe(9090);
  });

  test('COMPUTE_ARMOR_DEFAULT_POLICY sets defaultPolicy', async () => {
    const config = await loadConfigFromEnv({ COMPUTE_ARMOR_DEFAULT_POLICY: 'my-policy' });

    expect(config.services.compute.defaultPolicy).toBe('my-policy');
  });

  test('default listener port is 8787', async () => {
    const config = await loadConfigFromEnv({});

    expect(config.services.compute.listenerPort).toBe(8787);
  });

  test('default evaluation server bind is 127.0.0.1', async () => {
    const config = await loadConfigFromEnv({});

    expect(config.services.compute.listenerBind).toBe('127.0.0.1');
  });

  test('COMPUTE_LISTENER_BIND sets listenerBind', async () => {
    const config = await loadConfigFromEnv({ COMPUTE_LISTENER_BIND: '0.0.0.0' });

    expect(config.services.compute.listenerBind).toBe('0.0.0.0');
  });

  test('COMPUTE_LISTENER_BIND rejects an address that is not 127.0.0.1 or 0.0.0.0', async () => {
    const promise = loadConfigFromEnv({ COMPUTE_LISTENER_BIND: '192.0.2.1' });

    await expect(promise).rejects.toThrow();
  });
});
