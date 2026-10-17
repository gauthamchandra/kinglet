/**
 * End-to-End Test: Cloud Pub/Sub gRPC Workflow
 *
 * Validates the native gRPC surface of the Cloud Pub/Sub emulator using the
 * official @google-cloud/pubsub client library (v1 sub-clients) without
 * fallback: 'rest'. This exercises the real gRPC code path through google-gax.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import * as pubsubV1 from '@google-cloud/pubsub/build/src/v1/index.js';
import * as grpc from '@grpc/grpc-js';
import type { Server } from 'bun';
import { GrpcServer } from '@/core/gateway/grpc-server.ts';
import { StorageManager } from '@/core/storage/manager.ts';
import { PubSubService } from '@/services/pubsub/index.ts';
import { Logger } from '@/shared/utils/logger.ts';
import { getAvailablePort } from '../test-utils/helpers.ts';
import { createFakeAuth } from './e2e-helpers.ts';

// ── Test Infrastructure ──

let emulatorServer: Server;
let grpcServer: GrpcServer;
let pubsubService: PubSubService;
let publisherClient: InstanceType<typeof pubsubV1.PublisherClient>;
let subscriberClient: InstanceType<typeof pubsubV1.SubscriberClient>;
let schemaClient: InstanceType<typeof pubsubV1.SchemaServiceClient>;

let emulatorPort: number;
let grpcPort: number;

// ── Setup / Teardown ──

beforeAll(async () => {
  emulatorPort = await getAvailablePort();
  grpcPort = await getAvailablePort();

  const storage = new StorageManager();

  await storage.initialize({ type: 'memory' });

  const logger = new Logger('e2e-pubsub-grpc', 'error');

  pubsubService = new PubSubService(storage, logger);
  await pubsubService.initialize();
  pubsubService.start();

  // Start a minimal HTTP server (needed for infrastructure, gRPC goes elsewhere)
  emulatorServer = Bun.serve({
    port: emulatorPort,
    fetch: () => new Response('not used in this suite', { status: 404 }),
  });

  // Start gRPC server
  const serverConfig = { httpPort: emulatorPort, grpcPort, maxConnections: 100 };

  grpcServer = new GrpcServer(serverConfig, logger);

  for (const def of pubsubService.getGrpcServices()) {
    grpcServer.registerService(def);
  }

  await grpcServer.start();

  // Build gRPC clients with insecure credentials (no fallback: 'rest')
  const fakeAuth = createFakeAuth('grpc-pubsub-test');
  const clientOpts = {
    apiEndpoint: 'localhost',
    port: grpcPort,
    sslCreds: grpc.credentials.createInsecure(),
    auth: fakeAuth as never,
  };

  publisherClient = new pubsubV1.PublisherClient(clientOpts);
  subscriberClient = new pubsubV1.SubscriberClient(clientOpts);
  schemaClient = new pubsubV1.SchemaServiceClient(clientOpts);
});

afterAll(async () => {
  publisherClient.close();
  subscriberClient.close();
  schemaClient.close();
  await grpcServer.stop();
  await pubsubService.stop();
  emulatorServer.stop();
});

// ── Tests ──

const project = 'grpc-pubsub-test';
const topicId = 'grpc-e2e-topic';
const topicName = `projects/${project}/topics/${topicId}`;
const subscriptionId = 'grpc-e2e-sub';
const subscriptionName = `projects/${project}/subscriptions/${subscriptionId}`;
const snapshotId = 'grpc-e2e-snap';
const snapshotName = `projects/${project}/snapshots/${snapshotId}`;
const schemaId = 'grpc-e2e-schema';
const schemaName = `projects/${project}/schemas/${schemaId}`;

describe('Cloud Pub/Sub E2E: gRPC — Publisher', () => {
  test('createTopic creates a topic via gRPC', async () => {
    const [topic] = await publisherClient.createTopic({ name: topicName });

    expect(topic.name).toBe(topicName);
  });

  test('getTopic returns the topic via gRPC', async () => {
    const [topic] = await publisherClient.getTopic({ topic: topicName });

    expect(topic.name).toBe(topicName);
  });

  test('updateTopic updates labels via gRPC', async () => {
    const [topic] = await publisherClient.updateTopic({
      topic: { name: topicName, labels: { env: 'test' } },
      updateMask: { paths: ['labels'] },
    });

    expect(topic.name).toBe(topicName);
    expect(topic.labels?.['env']).toBe('test');
  });

  test('listTopics returns at least one topic via gRPC', async () => {
    const [topics] = await publisherClient.listTopics({ project: `projects/${project}` });

    expect(topics.length).toBeGreaterThanOrEqual(1);

    const found = topics.find(t => t.name === topicName);

    expect(found).toBeDefined();
  });

  test('publish sends messages via gRPC', async () => {
    const data = Buffer.from('hello grpc');

    const [result] = await publisherClient.publish({
      topic: topicName,
      messages: [{ data, attributes: { source: 'grpc-test' } }],
    });

    expect(result.messageIds).toHaveLength(1);
    expect(result.messageIds[0]).toBeTypeOf('string');
  });

  test('listTopicSubscriptions returns subscription names via gRPC', async () => {
    // Create a subscription first so we have at least one
    await subscriberClient.createSubscription({
      name: subscriptionName,
      topic: topicName,
    });

    const [subs] = await publisherClient.listTopicSubscriptions({ topic: topicName });

    expect(subs.length).toBeGreaterThanOrEqual(1);
    expect(subs).toContain(subscriptionName);
  });

  test('listTopicSnapshots returns snapshot names via gRPC', async () => {
    // Create snapshot first
    await subscriberClient.createSnapshot({
      name: snapshotName,
      subscription: subscriptionName,
    });

    const [snaps] = await publisherClient.listTopicSnapshots({ topic: topicName });

    expect(snaps.length).toBeGreaterThanOrEqual(1);
    expect(snaps).toContain(snapshotName);
  });
});

describe('Cloud Pub/Sub E2E: gRPC — Subscriber', () => {
  test('getSubscription returns the subscription via gRPC', async () => {
    const [sub] = await subscriberClient.getSubscription({ subscription: subscriptionName });

    expect(sub.name).toBe(subscriptionName);
    expect(sub.topic).toBe(topicName);
  });

  test('updateSubscription updates ackDeadlineSeconds via gRPC', async () => {
    const [sub] = await subscriberClient.updateSubscription({
      subscription: { name: subscriptionName, ackDeadlineSeconds: 30 },
      updateMask: { paths: ['ack_deadline_seconds'] },
    });

    expect(sub.ackDeadlineSeconds).toBe(30);
  });

  test('listSubscriptions returns subscriptions via gRPC', async () => {
    const [subs] = await subscriberClient.listSubscriptions({ project: `projects/${project}` });

    expect(subs.length).toBeGreaterThanOrEqual(1);

    const found = subs.find(s => s.name === subscriptionName);

    expect(found).toBeDefined();
  });

  test('pull returns messages via gRPC', async () => {
    // Publish a message first
    await publisherClient.publish({
      topic: topicName,
      messages: [{ data: Buffer.from('pull-me') }],
    });

    const [response] = await subscriberClient.pull({
      subscription: subscriptionName,
      maxMessages: 10,
    });

    expect(response.receivedMessages).toBeDefined();
    expect(response.receivedMessages.length).toBeGreaterThanOrEqual(1);
  });

  test('acknowledge acks messages via gRPC', async () => {
    // Pull to get ack IDs
    const [pullResp] = await subscriberClient.pull({
      subscription: subscriptionName,
      maxMessages: 10,
    });

    const ackIds = pullResp.receivedMessages
      .map(m => m.ackId)
      .filter((id): id is string => id != null);

    if (ackIds.length > 0) {
      await subscriberClient.acknowledge({ subscription: subscriptionName, ackIds });
    }
  });

  test('modifyAckDeadline adjusts deadline via gRPC', async () => {
    // Publish and pull to get an ack ID
    await publisherClient.publish({
      topic: topicName,
      messages: [{ data: Buffer.from('modify-ack') }],
    });

    const [pullResp] = await subscriberClient.pull({
      subscription: subscriptionName,
      maxMessages: 1,
    });

    const ackIds = pullResp.receivedMessages
      .map(m => m.ackId)
      .filter((id): id is string => id != null);

    if (ackIds.length > 0) {
      await subscriberClient.modifyAckDeadline({
        subscription: subscriptionName,
        ackIds,
        ackDeadlineSeconds: 60,
      });
    }
  });

  test('modifyPushConfig updates push config via gRPC', async () => {
    await subscriberClient.modifyPushConfig({
      subscription: subscriptionName,
      pushConfig: { pushEndpoint: 'https://example.com/push' },
    });
  });

  test('detachSubscription detaches a subscription via gRPC', async () => {
    // Create a temporary subscription to detach
    const tempSubName = `projects/${project}/subscriptions/grpc-temp-detach`;

    await subscriberClient.createSubscription({
      name: tempSubName,
      topic: topicName,
    });

    await publisherClient.detachSubscription({ subscription: tempSubName });
  });

  test('getSnapshot returns the snapshot via gRPC', async () => {
    const [snap] = await subscriberClient.getSnapshot({ snapshot: snapshotName });

    expect(snap.name).toBe(snapshotName);
    expect(snap.topic).toBe(topicName);
  });

  test('updateSnapshot updates labels via gRPC', async () => {
    const [snap] = await subscriberClient.updateSnapshot({
      snapshot: { name: snapshotName, labels: { env: 'snap-test' } },
      updateMask: { paths: ['labels'] },
    });

    expect(snap.name).toBe(snapshotName);
    expect(snap.labels?.['env']).toBe('snap-test');
  });

  test('listSnapshots returns snapshots via gRPC', async () => {
    const [snaps] = await subscriberClient.listSnapshots({ project: `projects/${project}` });

    expect(snaps.length).toBeGreaterThanOrEqual(1);

    const found = snaps.find(s => s.name === snapshotName);

    expect(found).toBeDefined();
  });

  test('seek by time via gRPC', async () => {
    const seekTime = new Date();

    await subscriberClient.seek({
      subscription: subscriptionName,
      time: {
        seconds: Math.floor(seekTime.getTime() / 1000).toString(),
        nanos: 0,
      },
    });
  });

  test('seek by snapshot via gRPC', async () => {
    await subscriberClient.seek({
      subscription: subscriptionName,
      snapshot: snapshotName,
    });
  });
});

describe('Cloud Pub/Sub E2E: gRPC — SchemaService', () => {
  test('createSchema creates a schema via gRPC', async () => {
    const [schema] = await schemaClient.createSchema({
      parent: `projects/${project}`,
      schemaId,
      schema: {
        type: 'AVRO',
        definition: '{"type":"record","name":"Test","fields":[{"name":"id","type":"string"}]}',
      },
    });

    expect(schema.name).toBe(schemaName);
    expect(schema.type).toBe('AVRO');
  });

  test('getSchema returns schema via gRPC', async () => {
    const [schema] = await schemaClient.getSchema({ name: schemaName });

    expect(schema.name).toBe(schemaName);
    expect(schema.type).toBe('AVRO');
  });

  test('listSchemas returns schemas via gRPC', async () => {
    const [schemas] = await schemaClient.listSchemas({ parent: `projects/${project}` });

    expect(schemas.length).toBeGreaterThanOrEqual(1);

    const found = schemas.find(s => s.name === schemaName);

    expect(found).toBeDefined();
  });

  test('commitSchema updates schema via gRPC', async () => {
    const [schema] = await schemaClient.commitSchema({
      name: schemaName,
      schema: {
        type: 'AVRO',
        definition:
          '{"type":"record","name":"TestV2","fields":[{"name":"id","type":"string"},{"name":"val","type":"int"}]}',
      },
    });

    expect(schema.name).toBe(schemaName);
  });

  test('listSchemaRevisions returns revisions via gRPC', async () => {
    const [revisions] = await schemaClient.listSchemaRevisions({ name: schemaName });

    expect(revisions.length).toBeGreaterThanOrEqual(1);
  });

  test('rollbackSchema returns schema via gRPC', async () => {
    const [schema] = await schemaClient.rollbackSchema({
      name: schemaName,
      revisionId: 'any',
    });

    expect(schema.name).toBe(schemaName);
  });

  test('deleteSchemaRevision returns schema via gRPC', async () => {
    const [schema] = await schemaClient.deleteSchemaRevision({
      name: schemaName,
    });

    expect(schema.name).toBe(schemaName);
  });

  test('validateSchema returns empty response via gRPC', async () => {
    const [response] = await schemaClient.validateSchema({
      parent: `projects/${project}`,
      schema: { type: 'AVRO', definition: '{}' },
    });

    expect(response).toBeDefined();
  });

  test('validateMessage returns empty response via gRPC', async () => {
    const [response] = await schemaClient.validateMessage({
      parent: `projects/${project}`,
      name: schemaName,
      encoding: 'JSON',
      message: Buffer.from('{}'),
    });

    expect(response).toBeDefined();
  });
});

describe('Cloud Pub/Sub E2E: gRPC — Error Paths', () => {
  test('getTopic returns NOT_FOUND for missing topic via gRPC', async () => {
    const promise = publisherClient.getTopic({
      topic: `projects/${project}/topics/does-not-exist`,
    });

    await expect(promise).rejects.toThrow();
  });

  test('createTopic returns ALREADY_EXISTS for duplicate topic via gRPC', async () => {
    const promise = publisherClient.createTopic({ name: topicName });

    await expect(promise).rejects.toThrow();
  });

  test('getSubscription returns NOT_FOUND for missing subscription via gRPC', async () => {
    const promise = subscriberClient.getSubscription({
      subscription: `projects/${project}/subscriptions/does-not-exist`,
    });

    await expect(promise).rejects.toThrow();
  });

  test('getSchema returns NOT_FOUND for missing schema via gRPC', async () => {
    const promise = schemaClient.getSchema({
      name: `projects/${project}/schemas/does-not-exist`,
    });

    await expect(promise).rejects.toThrow();
  });
});

describe('Cloud Pub/Sub E2E: gRPC — Cleanup', () => {
  test('deleteSnapshot deletes the snapshot via gRPC', async () => {
    await subscriberClient.deleteSnapshot({ snapshot: snapshotName });

    const promise = subscriberClient.getSnapshot({ snapshot: snapshotName });

    await expect(promise).rejects.toThrow();
  });

  test('deleteSchema deletes the schema via gRPC', async () => {
    await schemaClient.deleteSchema({ name: schemaName });

    const promise = schemaClient.getSchema({ name: schemaName });

    await expect(promise).rejects.toThrow();
  });

  test('deleteSubscription deletes the subscription via gRPC', async () => {
    await subscriberClient.deleteSubscription({ subscription: subscriptionName });

    const promise = subscriberClient.getSubscription({ subscription: subscriptionName });

    await expect(promise).rejects.toThrow();
  });

  test('deleteTopic deletes the topic via gRPC', async () => {
    await publisherClient.deleteTopic({ topic: topicName });

    const promise = publisherClient.getTopic({ topic: topicName });

    await expect(promise).rejects.toThrow();
  });
});
