/**
 * End-to-End Test: Cloud Pub/Sub Workflow
 *
 * True black-box tests — validates the full lifecycle through HTTP only.
 * Two test paths:
 *   1. Raw HTTP fetch against the emulator
 *   2. Official @google-cloud/pubsub client library
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import type { Server } from 'bun';
import { v1 } from '@google-cloud/pubsub';
import { StorageManager } from '@/core/storage/manager.ts';
import { Logger } from '@/shared/utils/logger.ts';
import { PubSubService } from '@/services/pubsub/index.ts';
import { getAvailablePort } from '../test-utils/helpers.ts';
import { buildRouter, createFakeAuth } from './e2e-helpers.ts';

// ── Test Infrastructure ──

let emulatorServer: Server;
let emulatorPort: number;
let pubsubService: PubSubService;

function emulatorUrl(path: string): string {
  return `http://localhost:${emulatorPort}${path}`;
}

// ── Setup / Teardown ──

beforeAll(async () => {
  emulatorPort = await getAvailablePort();

  const storage = new StorageManager();
  await storage.initialize({ type: 'memory' });

  const logger = new Logger('e2e-pubsub', 'error');
  pubsubService = new PubSubService(storage, logger);
  await pubsubService.initialize();
  pubsubService.start();

  const routes = pubsubService.getRoutes();
  const router = buildRouter(routes);

  emulatorServer = Bun.serve({
    port: emulatorPort,
    fetch: router,
  });
});

afterAll(async () => {
  await pubsubService.stop();
  emulatorServer.stop();
});

// ── Test Path 1: Raw HTTP Fetch ──

describe('Pub/Sub E2E: Raw HTTP API', () => {
  const project = 'test-project';
  const topicId = 'e2e-test-topic';
  const topicName = `projects/${project}/topics/${topicId}`;
  const subscriptionId = 'e2e-test-sub';
  const subscriptionName = `projects/${project}/subscriptions/${subscriptionId}`;

  // ── Topic CRUD ──

  test('1. Create a topic', async () => {
    const response = await fetch(emulatorUrl(`/v1/projects/${project}/topics/${topicId}`), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        labels: { env: 'test' },
      }),
    });

    expect(response.status).toBe(200);

    const topic = await response.json();

    expect(topic.name).toBe(topicName);
    expect(topic.labels).toEqual({ env: 'test' });
  });

  test('2. Get a topic', async () => {
    const response = await fetch(emulatorUrl(`/v1/projects/${project}/topics/${topicId}`));

    expect(response.status).toBe(200);

    const topic = await response.json();

    expect(topic.name).toBe(topicName);
    expect(topic.labels).toEqual({ env: 'test' });
  });

  test('3. List topics', async () => {
    const response = await fetch(emulatorUrl(`/v1/projects/${project}/topics`));

    expect(response.status).toBe(200);

    const body = await response.json();

    expect(body.topics).toBeInstanceOf(Array);
    expect(body.topics.length).toBeGreaterThanOrEqual(1);

    const found = body.topics.find((t: Record<string, unknown>) => t.name === topicName);

    expect(found).toBeDefined();
  });

  test('4. Update a topic', async () => {
    const response = await fetch(emulatorUrl(`/v1/projects/${project}/topics/${topicId}`), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        topic: {
          labels: { env: 'staging' },
        },
        updateMask: 'labels',
      }),
    });

    expect(response.status).toBe(200);

    const topic = await response.json();

    expect(topic.name).toBe(topicName);
    expect(topic.labels).toEqual({ env: 'staging' });
  });

  test('5. List topics with pagination', async () => {
    // Create a second topic for pagination
    await fetch(emulatorUrl(`/v1/projects/${project}/topics/page-topic-2`), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    const response = await fetch(emulatorUrl(`/v1/projects/${project}/topics?pageSize=1`));

    expect(response.status).toBe(200);

    const body = await response.json();

    expect(body.topics.length).toBe(1);
    expect(body.nextPageToken).toBeDefined();

    // Fetch next page
    const response2 = await fetch(
      emulatorUrl(`/v1/projects/${project}/topics?pageSize=1&pageToken=${body.nextPageToken}`)
    );

    expect(response2.status).toBe(200);

    const body2 = await response2.json();

    expect(body2.topics.length).toBeGreaterThanOrEqual(1);

    // Cleanup
    await fetch(emulatorUrl(`/v1/projects/${project}/topics/page-topic-2`), { method: 'DELETE' });
  });

  // ── Publish ──

  test('6. Publish messages to a topic', async () => {
    const response = await fetch(emulatorUrl(`/v1/projects/${project}/topics/${topicId}:publish`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [
          {
            data: btoa('hello world'),
            attributes: { key: 'value' },
          },
          {
            data: btoa('second message'),
          },
        ],
      }),
    });

    expect(response.status).toBe(200);

    const body = await response.json();

    expect(body.messageIds).toBeInstanceOf(Array);
    expect(body.messageIds.length).toBe(2);
    expect(body.messageIds[0]).toBeTypeOf('string');
    expect(body.messageIds[1]).toBeTypeOf('string');
  });

  test('7. Publish to a non-existent topic returns 404', async () => {
    const response = await fetch(
      emulatorUrl(`/v1/projects/${project}/topics/nonexistent:publish`),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [{ data: btoa('test') }],
        }),
      }
    );

    expect(response.status).toBe(404);
  });

  // ── Subscription CRUD ──

  test('8. Create a subscription', async () => {
    const response = await fetch(
      emulatorUrl(`/v1/projects/${project}/subscriptions/${subscriptionId}`),
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          topic: topicName,
          ackDeadlineSeconds: 30,
        }),
      }
    );

    expect(response.status).toBe(200);

    const sub = await response.json();

    expect(sub.name).toBe(subscriptionName);
    expect(sub.topic).toBe(topicName);
    expect(sub.ackDeadlineSeconds).toBe(30);
  });

  test('9. Get a subscription', async () => {
    const response = await fetch(
      emulatorUrl(`/v1/projects/${project}/subscriptions/${subscriptionId}`)
    );

    expect(response.status).toBe(200);

    const sub = await response.json();

    expect(sub.name).toBe(subscriptionName);
    expect(sub.topic).toBe(topicName);
  });

  test('10. List subscriptions', async () => {
    const response = await fetch(emulatorUrl(`/v1/projects/${project}/subscriptions`));

    expect(response.status).toBe(200);

    const body = await response.json();

    expect(body.subscriptions).toBeInstanceOf(Array);

    const found = body.subscriptions.find(
      (s: Record<string, unknown>) => s.name === subscriptionName
    );

    expect(found).toBeDefined();
  });

  test('11. Update a subscription', async () => {
    const response = await fetch(
      emulatorUrl(`/v1/projects/${project}/subscriptions/${subscriptionId}`),
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          subscription: {
            ackDeadlineSeconds: 60,
          },
          updateMask: 'ackDeadlineSeconds',
        }),
      }
    );

    expect(response.status).toBe(200);

    const sub = await response.json();

    expect(sub.ackDeadlineSeconds).toBe(60);
  });

  test('12. List subscriptions for a topic', async () => {
    const response = await fetch(
      emulatorUrl(`/v1/projects/${project}/topics/${topicId}/subscriptions`)
    );

    expect(response.status).toBe(200);

    const body = await response.json();

    expect(body.subscriptions).toBeInstanceOf(Array);
    expect(body.subscriptions).toContain(subscriptionName);
  });

  // ── Publish then Pull/Ack ──

  test('13. Publish, pull, and acknowledge messages', async () => {
    // Publish fresh messages (after subscription was created)
    const publishResp = await fetch(
      emulatorUrl(`/v1/projects/${project}/topics/${topicId}:publish`),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [{ data: btoa('pull-test-1') }, { data: btoa('pull-test-2') }],
        }),
      }
    );

    expect(publishResp.status).toBe(200);

    // Pull messages
    const pullResp = await fetch(
      emulatorUrl(`/v1/projects/${project}/subscriptions/${subscriptionId}:pull`),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ maxMessages: 10 }),
      }
    );

    expect(pullResp.status).toBe(200);

    const pullBody = await pullResp.json();

    expect(pullBody.receivedMessages).toBeInstanceOf(Array);
    expect(pullBody.receivedMessages.length).toBe(2);

    const msg1 = pullBody.receivedMessages[0];

    expect(msg1.ackId).toBeTypeOf('string');
    expect(msg1.message).toBeDefined();
    expect(msg1.message.data).toBeTypeOf('string');
    expect(msg1.message.messageId).toBeTypeOf('string');
    expect(msg1.message.publishTime).toBeTypeOf('string');

    // Acknowledge messages
    const ackIds = pullBody.receivedMessages.map((m: { ackId: string }) => m.ackId);

    const ackResp = await fetch(
      emulatorUrl(`/v1/projects/${project}/subscriptions/${subscriptionId}:acknowledge`),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ackIds }),
      }
    );

    expect(ackResp.status).toBe(200);

    // Pull again — should get no messages (all acked)
    const pullAgainResp = await fetch(
      emulatorUrl(`/v1/projects/${project}/subscriptions/${subscriptionId}:pull`),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ maxMessages: 10 }),
      }
    );

    expect(pullAgainResp.status).toBe(200);

    const pullAgainBody = await pullAgainResp.json();

    expect(pullAgainBody.receivedMessages ?? []).toEqual([]);
  });

  // ── ModifyAckDeadline ──

  test('14. ModifyAckDeadline extends the deadline', async () => {
    // Publish a message
    await fetch(emulatorUrl(`/v1/projects/${project}/topics/${topicId}:publish`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [{ data: btoa('deadline-test') }],
      }),
    });

    // Pull to get ackId
    const pullResp = await fetch(
      emulatorUrl(`/v1/projects/${project}/subscriptions/${subscriptionId}:pull`),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ maxMessages: 1 }),
      }
    );

    const pullBody = await pullResp.json();
    const ackId = pullBody.receivedMessages[0].ackId;

    // Modify ack deadline
    const modifyResp = await fetch(
      emulatorUrl(`/v1/projects/${project}/subscriptions/${subscriptionId}:modifyAckDeadline`),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ackIds: [ackId],
          ackDeadlineSeconds: 120,
        }),
      }
    );

    expect(modifyResp.status).toBe(200);

    // Cleanup: ack the message
    await fetch(
      emulatorUrl(`/v1/projects/${project}/subscriptions/${subscriptionId}:acknowledge`),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ackIds: [ackId] }),
      }
    );
  });

  // ── Detach ──

  test('15. Detach subscription', async () => {
    const detachSubId = 'detach-test-sub';

    // Create a subscription to detach
    await fetch(emulatorUrl(`/v1/projects/${project}/subscriptions/${detachSubId}`), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic: topicName }),
    });

    // Detach it
    const detachResp = await fetch(
      emulatorUrl(`/v1/projects/${project}/subscriptions/${detachSubId}:detach`),
      { method: 'POST' }
    );

    expect(detachResp.status).toBe(200);

    // Verify the subscription is detached
    const getResp = await fetch(
      emulatorUrl(`/v1/projects/${project}/subscriptions/${detachSubId}`)
    );

    const sub = await getResp.json();

    expect(sub.detached).toBe(true);

    // Pull on detached subscription should fail
    const pullResp = await fetch(
      emulatorUrl(`/v1/projects/${project}/subscriptions/${detachSubId}:pull`),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ maxMessages: 1 }),
      }
    );

    expect(pullResp.status).toBe(400);

    // Cleanup
    await fetch(emulatorUrl(`/v1/projects/${project}/subscriptions/${detachSubId}`), {
      method: 'DELETE',
    });
  });

  // ── Error Cases ──

  test('16. Get non-existent topic returns 404', async () => {
    const response = await fetch(emulatorUrl(`/v1/projects/${project}/topics/does-not-exist`));

    expect(response.status).toBe(404);

    const body = await response.json();

    expect(body.error).toBeDefined();
    expect(body.error.status).toBe('NOT_FOUND');
  });

  test('17. Get non-existent subscription returns 404', async () => {
    const response = await fetch(
      emulatorUrl(`/v1/projects/${project}/subscriptions/does-not-exist`)
    );

    expect(response.status).toBe(404);
  });

  test('18. Create subscription with non-existent topic returns 404', async () => {
    const response = await fetch(emulatorUrl(`/v1/projects/${project}/subscriptions/orphan-sub`), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        topic: `projects/${project}/topics/no-such-topic`,
      }),
    });

    expect(response.status).toBe(404);
  });

  test('19. Pull from non-existent subscription returns 404', async () => {
    const response = await fetch(
      emulatorUrl(`/v1/projects/${project}/subscriptions/does-not-exist:pull`),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ maxMessages: 1 }),
      }
    );

    expect(response.status).toBe(404);
  });

  // ── Cleanup ──

  test('20. Delete subscription', async () => {
    const response = await fetch(
      emulatorUrl(`/v1/projects/${project}/subscriptions/${subscriptionId}`),
      { method: 'DELETE' }
    );

    expect(response.status).toBe(200);

    // Verify it's gone
    const getResp = await fetch(
      emulatorUrl(`/v1/projects/${project}/subscriptions/${subscriptionId}`)
    );

    expect(getResp.status).toBe(404);
  });

  test('21. Delete topic', async () => {
    const response = await fetch(emulatorUrl(`/v1/projects/${project}/topics/${topicId}`), {
      method: 'DELETE',
    });

    expect(response.status).toBe(200);

    // Verify it's gone
    const getResp = await fetch(emulatorUrl(`/v1/projects/${project}/topics/${topicId}`));

    expect(getResp.status).toBe(404);
  });

  test('22. Delete non-existent topic returns 404', async () => {
    const response = await fetch(emulatorUrl(`/v1/projects/${project}/topics/already-deleted`), {
      method: 'DELETE',
    });

    expect(response.status).toBe(404);
  });
});

// ── Test Path 2: Official @google-cloud/pubsub Client Library ──

describe('Pub/Sub E2E: Client Library', () => {
  const project = 'client-lib-project';
  const topicId = 'client-lib-topic';
  const topicName = `projects/${project}/topics/${topicId}`;
  const subscriptionId = 'client-lib-sub';
  const subscriptionName = `projects/${project}/subscriptions/${subscriptionId}`;

  let publisher: InstanceType<typeof v1.PublisherClient>;
  let subscriber: InstanceType<typeof v1.SubscriberClient>;

  beforeAll(() => {
    const fakeAuth = {
      ...createFakeAuth(project),
      getUniverseDomain: () => Promise.resolve('googleapis.com'),
    };

    const clientOpts = {
      fallback: 'rest' as const,
      apiEndpoint: 'localhost',
      port: emulatorPort,
      protocol: 'http',
      auth: fakeAuth as never,
    };

    publisher = new v1.PublisherClient(clientOpts);
    subscriber = new v1.SubscriberClient(clientOpts);
  });

  test('1. Create topic via client library', async () => {
    const [topic] = await publisher.createTopic({ name: topicName });

    expect(topic.name).toBe(topicName);
  });

  test('2. Get topic via client library', async () => {
    const [topic] = await publisher.getTopic({ topic: topicName });

    expect(topic.name).toBe(topicName);
  });

  test('3. List topics via client library', async () => {
    const [topics] = await publisher.listTopics({
      project: `projects/${project}`,
    });

    expect(topics.length).toBeGreaterThanOrEqual(1);

    const found = topics.find((t: Record<string, unknown>) => t.name === topicName);

    expect(found).toBeDefined();
  });

  test('4. Publish message via client library', async () => {
    const [response] = await publisher.publish({
      topic: topicName,
      messages: [
        {
          data: Buffer.from('hello from client lib'),
          attributes: { source: 'e2e-test' },
        },
      ],
    });

    expect(response.messageIds).toBeInstanceOf(Array);
    expect(response.messageIds.length).toBe(1);
    expect(response.messageIds[0]).toBeTypeOf('string');
  });

  test('5. Create subscription via client library', async () => {
    const [subscription] = await subscriber.createSubscription({
      name: subscriptionName,
      topic: topicName,
    });

    expect(subscription.name).toBe(subscriptionName);
    expect(subscription.topic).toBe(topicName);
  });

  test('6. Get subscription via client library', async () => {
    const [subscription] = await subscriber.getSubscription({
      subscription: subscriptionName,
    });

    expect(subscription.name).toBe(subscriptionName);
    expect(subscription.topic).toBe(topicName);
  });

  test('7. Publish, pull, and ack via client library', async () => {
    // Publish messages after subscription exists
    await publisher.publish({
      topic: topicName,
      messages: [{ data: Buffer.from('client-pull-1') }, { data: Buffer.from('client-pull-2') }],
    });

    // Pull
    const [pullResponse] = await subscriber.pull({
      subscription: subscriptionName,
      maxMessages: 10,
    });

    expect(pullResponse.receivedMessages).toBeInstanceOf(Array);
    expect(pullResponse.receivedMessages!.length).toBe(2);

    // Acknowledge
    const ackIds = pullResponse.receivedMessages!.map(
      (m: { ackId?: string | null }) => m.ackId as string
    );

    await subscriber.acknowledge({
      subscription: subscriptionName,
      ackIds,
    });

    // Pull again — should be empty
    const [pullResponse2] = await subscriber.pull({
      subscription: subscriptionName,
      maxMessages: 10,
    });

    expect(pullResponse2.receivedMessages ?? []).toEqual([]);
  });

  test('8. List subscriptions via client library', async () => {
    const [subscriptions] = await subscriber.listSubscriptions({
      project: `projects/${project}`,
    });

    expect(subscriptions.length).toBeGreaterThanOrEqual(1);

    const found = subscriptions.find((s: Record<string, unknown>) => s.name === subscriptionName);

    expect(found).toBeDefined();
  });

  test('9. Delete subscription via client library', async () => {
    await subscriber.deleteSubscription({
      subscription: subscriptionName,
    });

    const getDeleted = subscriber.getSubscription({
      subscription: subscriptionName,
    });

    await expect(getDeleted).rejects.toThrow(/not found/i);
  });

  test('10. Delete topic via client library', async () => {
    await publisher.deleteTopic({ topic: topicName });

    const getDeleted = publisher.getTopic({ topic: topicName });

    await expect(getDeleted).rejects.toThrow(/not found/i);
  });
});

// ── Test Path 3: Push Delivery ──

describe('Pub/Sub E2E: Push Delivery', () => {
  const project = 'push-project';
  const topicId = 'push-topic';
  const subscriptionId = 'push-sub';

  let pushServer: import('bun').Server;
  let pushPort: number;
  let receivedMessages: Array<Record<string, unknown>>;

  beforeAll(async () => {
    pushPort = await getAvailablePort();
    receivedMessages = [];

    pushServer = Bun.serve({
      port: pushPort,
      fetch(req) {
        return req.json().then((body: unknown) => {
          receivedMessages.push(body as Record<string, unknown>);

          return new Response('OK', { status: 200 });
        });
      },
    });
  });

  afterAll(() => {
    pushServer.stop();
  });

  test('1. Push delivery: message is delivered to push endpoint', async () => {
    // Create topic
    const createTopic = await fetch(emulatorUrl(`/v1/projects/${project}/topics/${topicId}`), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });

    expect(createTopic.status).toBe(200);

    // Create push subscription
    const createSub = await fetch(
      emulatorUrl(`/v1/projects/${project}/subscriptions/${subscriptionId}`),
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          topic: `projects/${project}/topics/${topicId}`,
          pushConfig: {
            pushEndpoint: `http://localhost:${pushPort}/push`,
          },
        }),
      }
    );

    expect(createSub.status).toBe(200);

    // Publish a message
    const publish = await fetch(emulatorUrl(`/v1/projects/${project}/topics/${topicId}:publish`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [{ data: btoa('push-delivery-test'), attributes: { env: 'e2e' } }],
      }),
    });

    expect(publish.status).toBe(200);

    // Wait for push delivery (engine polls every 1s)
    await new Promise(resolve => setTimeout(resolve, 3000));

    expect(receivedMessages.length).toBeGreaterThanOrEqual(1);

    const pushed = receivedMessages[0] as {
      message: { data: string; messageId: string; attributes: Record<string, string> };
      subscription: string;
    };

    expect(pushed.message.data).toBe(btoa('push-delivery-test'));
    expect(pushed.message.messageId).toBeTypeOf('string');
    expect(pushed.message.attributes).toEqual({ env: 'e2e' });
    expect(pushed.subscription).toBe(`projects/${project}/subscriptions/${subscriptionId}`);

    // Pull should return empty since push auto-acked
    const pull = await fetch(
      emulatorUrl(`/v1/projects/${project}/subscriptions/${subscriptionId}:pull`),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ maxMessages: 10 }),
      }
    );

    expect(pull.status).toBe(200);

    const pullBody = (await pull.json()) as { receivedMessages: unknown[] };

    expect(pullBody.receivedMessages).toHaveLength(0);
  });
});
