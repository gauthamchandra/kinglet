/**
 * Basic End-to-End Workflow Test
 *
 * This test verifies that the basic server startup and health check work.
 * More comprehensive E2E tests will be added as services are implemented.
 */

import { describe, test, expect } from 'bun:test';
import { getBaseUrl, getE2EConfig } from './setup.ts';

describe('Basic E2E Workflow', () => {
  test.skip('server health check responds correctly', async () => {
    // TODO: Enable this test once the main server is implemented
    const baseUrl = getBaseUrl();
    const response = await fetch(`${baseUrl}/healthcheck`);

    expect(response.ok).toBe(true);
    expect(response.status).toBe(200);

    const health = await response.json();
    expect(health).toHaveProperty('status', 'healthy');
    expect(health).toHaveProperty('timestamp');
    expect(health).toHaveProperty('services');
  });

  test.skip('discovery API returns service list', async () => {
    // TODO: Enable this test once Discovery API is implemented
    const baseUrl = getBaseUrl();
    const response = await fetch(`${baseUrl}/$discovery/rest?version=v1`);

    expect(response.ok).toBe(true);
    expect(response.status).toBe(200);

    const discovery = await response.json();
    expect(discovery).toHaveProperty('kind', 'discovery#directoryList');
    expect(discovery).toHaveProperty('items');
    expect(Array.isArray(discovery.items)).toBe(true);
  });

  test.skip('pub/sub service integration workflow', async () => {
    // TODO: Enable this test once Pub/Sub service is implemented
    const baseUrl = getBaseUrl();

    // 1. Create a topic
    const createTopicResponse = await fetch(
      `${baseUrl}/v1/projects/test-project/topics/test-topic`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'projects/test-project/topics/test-topic' }),
      }
    );

    expect(createTopicResponse.ok).toBe(true);

    // 2. Create a subscription
    const createSubResponse = await fetch(
      `${baseUrl}/v1/projects/test-project/subscriptions/test-sub`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'projects/test-project/subscriptions/test-sub',
          topic: 'projects/test-project/topics/test-topic',
        }),
      }
    );

    expect(createSubResponse.ok).toBe(true);

    // 3. Publish a message
    const publishResponse = await fetch(
      `${baseUrl}/v1/projects/test-project/topics/test-topic:publish`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [{ data: Buffer.from('Hello E2E Test').toString('base64') }],
        }),
      }
    );

    expect(publishResponse.ok).toBe(true);

    // 4. Pull the message
    const pullResponse = await fetch(
      `${baseUrl}/v1/projects/test-project/subscriptions/test-sub:pull`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ maxMessages: 1 }),
      }
    );

    expect(pullResponse.ok).toBe(true);

    const pullResult = await pullResponse.json();
    expect(pullResult).toHaveProperty('receivedMessages');
    expect(Array.isArray(pullResult.receivedMessages)).toBe(true);
    expect(pullResult.receivedMessages.length).toBeGreaterThan(0);
  });

  test('e2e test configuration is accessible', () => {
    // This test verifies the E2E setup is working correctly
    const config = getE2EConfig();
    expect(config).toBeDefined();
    expect(config.server).toBeDefined();

    // Check that ports are dynamic (positive numbers, not hardcoded values)
    expect(typeof config.server?.httpPort).toBe('number');
    expect(typeof config.server?.grpcPort).toBe('number');
    expect(config.server?.httpPort).toBeGreaterThan(0);
    expect(config.server?.grpcPort).toBeGreaterThan(0);

    const baseUrl = getBaseUrl();
    expect(baseUrl).toBe(`http://localhost:${config.server?.httpPort}`);
  });
});
