/**
 * End-to-End Test: Cloud Pub/Sub gRPC Workflow
 *
 * Validates the native gRPC surface of the Cloud Pub/Sub emulator using the
 * official @google-cloud/pubsub client library (v1 sub-clients) without
 * fallback: 'rest'. This exercises the real gRPC code path through google-gax.
 *
 * Known gaps (expected to return UNIMPLEMENTED in this phase):
 *   - StreamingPull is UNIMPLEMENTED (fast-follow PR will add it).
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
    // Publish a dedicated message so pull is guaranteed to return one.
    await publisherClient.publish({
      topic: topicName,
      messages: [{ data: Buffer.from('ack-dedicated') }],
    });

    const [pullResp] = await subscriberClient.pull({
      subscription: subscriptionName,
      maxMessages: 10,
    });

    const ackIds = pullResp.receivedMessages
      .map(m => m.ackId)
      .filter((id): id is string => id != null);

    expect(ackIds.length).toBeGreaterThan(0);

    // Acknowledge the messages.
    await subscriberClient.acknowledge({ subscription: subscriptionName, ackIds });

    // Expire any remaining lease so the message would be re-delivered if acknowledge
    // had no effect.  A successfully acknowledged message must not reappear even
    // when the ack deadline is forced to 0.
    await subscriberClient.modifyAckDeadline({
      subscription: subscriptionName,
      ackIds,
      ackDeadlineSeconds: 0,
    });

    const [recheckResp] = await subscriberClient.pull({
      subscription: subscriptionName,
      maxMessages: 10,
    });

    const recheckAckIds = recheckResp.receivedMessages.map(m => m.ackId);

    for (const id of ackIds) {
      expect(recheckAckIds).not.toContain(id);
    }
  });

  test('modifyAckDeadline adjusts deadline via gRPC', async () => {
    await publisherClient.publish({
      topic: topicName,
      messages: [{ data: Buffer.from('modify-ack-dedicated') }],
    });

    const [pullResp] = await subscriberClient.pull({
      subscription: subscriptionName,
      maxMessages: 1,
    });

    const ackIds = pullResp.receivedMessages
      .map(m => m.ackId)
      .filter((id): id is string => id != null);

    expect(ackIds.length).toBeGreaterThan(0);

    // Setting ackDeadlineSeconds to 0 immediately expires the lease.  The message
    // must be re-delivered on the very next pull, proving the RPC took effect.
    await subscriberClient.modifyAckDeadline({
      subscription: subscriptionName,
      ackIds,
      ackDeadlineSeconds: 0,
    });

    const [recheckResp] = await subscriberClient.pull({
      subscription: subscriptionName,
      maxMessages: 1,
    });

    const recheckAckIds = recheckResp.receivedMessages
      .map(m => m.ackId)
      .filter((id): id is string => id != null);

    expect(recheckAckIds.length).toBeGreaterThan(0);

    // Clean up: acknowledge the re-delivered message.
    await subscriberClient.acknowledge({
      subscription: subscriptionName,
      ackIds: recheckAckIds,
    });
  });

  test('modifyPushConfig updates push config via gRPC', async () => {
    await subscriberClient.modifyPushConfig({
      subscription: subscriptionName,
      pushConfig: { pushEndpoint: 'https://example.com/push' },
    });

    const [sub] = await subscriberClient.getSubscription({ subscription: subscriptionName });

    expect((sub.pushConfig as { pushEndpoint?: string } | undefined)?.pushEndpoint).toBe(
      'https://example.com/push'
    );
  });

  test('detachSubscription detaches a subscription via gRPC', async () => {
    const tempSubName = `projects/${project}/subscriptions/grpc-temp-detach`;

    await subscriberClient.createSubscription({
      name: tempSubName,
      topic: topicName,
    });

    await publisherClient.detachSubscription({ subscription: tempSubName });

    const [sub] = await subscriberClient.getSubscription({ subscription: tempSubName });

    expect(sub.detached).toBe(true);
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
    // Use a fresh subscription so no prior test state interferes.
    const seekSubName = `projects/${project}/subscriptions/grpc-seek-time-sub`;

    await subscriberClient.createSubscription({
      name: seekSubName,
      topic: topicName,
    });

    try {
      // Publish a dedicated message.
      await publisherClient.publish({
        topic: topicName,
        messages: [{ data: Buffer.from('seek-time-test') }],
      });

      // Pull it — now it is PENDING with a future ack deadline.
      const [beforeSeekPull] = await subscriberClient.pull({
        subscription: seekSubName,
        maxMessages: 1,
      });

      const pendingAckIds = beforeSeekPull.receivedMessages
        .map(m => m.ackId)
        .filter((id): id is string => id != null);

      expect(pendingAckIds.length).toBeGreaterThan(0);

      // Seek to slightly in the future so publishTime <= seekTime even when both
      // fall within the same second (the gRPC Timestamp carries nanos, so
      // millisecond precision is preserved).
      const seekTime = new Date(Date.now() + 1000);

      await subscriberClient.seek({
        subscription: seekSubName,
        time: {
          seconds: Math.floor(seekTime.getTime() / 1000).toString(),
          nanos: (seekTime.getTime() % 1000) * 1_000_000,
        },
      });

      // The reset messages must reappear on the very next pull.
      const [afterSeekPull] = await subscriberClient.pull({
        subscription: seekSubName,
        maxMessages: 1,
      });

      expect(afterSeekPull.receivedMessages.length).toBeGreaterThan(0);

      // Clean up: acknowledge all re-delivered messages.
      const cleanAckIds = afterSeekPull.receivedMessages
        .map(m => m.ackId)
        .filter((id): id is string => id != null);

      if (cleanAckIds.length > 0) {
        await subscriberClient.acknowledge({ subscription: seekSubName, ackIds: cleanAckIds });
      }
    } finally {
      await subscriberClient.deleteSubscription({ subscription: seekSubName });
    }
  });

  test('seek by snapshot via gRPC', async () => {
    // Use a fresh subscription so no prior test state interferes.
    const seekSnapSubName = `projects/${project}/subscriptions/grpc-seek-snap-sub`;

    await subscriberClient.createSubscription({
      name: seekSnapSubName,
      topic: topicName,
    });

    try {
      // Publish a fresh message after the snapshot was created (so its publishTime
      // is after the snapshot's creation time).
      await publisherClient.publish({
        topic: topicName,
        messages: [{ data: Buffer.from('seek-snapshot-test') }],
      });

      const [beforePull] = await subscriberClient.pull({
        subscription: seekSnapSubName,
        maxMessages: 1,
      });

      const pendingAckIds = beforePull.receivedMessages
        .map(m => m.ackId)
        .filter((id): id is string => id != null);

      expect(pendingAckIds.length).toBeGreaterThan(0);

      // Seek to the snapshot (creationTime < message publishTime) — messages
      // published after the snapshot are outside the seek range so the ackDeadline
      // of the pending message is NOT reset; it remains leased.
      await subscriberClient.seek({
        subscription: seekSnapSubName,
        snapshot: snapshotName,
      });

      // The pending message must not be immediately re-delivered because the seek
      // did not reset its ackDeadline (it was published after the snapshot).
      const [afterSeekPull] = await subscriberClient.pull({
        subscription: seekSnapSubName,
        maxMessages: 1,
      });

      const afterAckIds = afterSeekPull.receivedMessages
        .map(m => m.ackId)
        .filter((id): id is string => id != null);

      for (const id of pendingAckIds) {
        expect(afterAckIds).not.toContain(id);
      }

      // Clean up: expire the leased message and acknowledge it.
      await subscriberClient.modifyAckDeadline({
        subscription: seekSnapSubName,
        ackIds: pendingAckIds,
        ackDeadlineSeconds: 0,
      });

      const [cleanPull] = await subscriberClient.pull({
        subscription: seekSnapSubName,
        maxMessages: 1,
      });

      const cleanAckIds = cleanPull.receivedMessages
        .map(m => m.ackId)
        .filter((id): id is string => id != null);

      if (cleanAckIds.length > 0) {
        await subscriberClient.acknowledge({ subscription: seekSnapSubName, ackIds: cleanAckIds });
      }
    } finally {
      await subscriberClient.deleteSubscription({ subscription: seekSnapSubName });
    }
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

describe('Cloud Pub/Sub E2E: gRPC — StreamingPull UNIMPLEMENTED', () => {
  test('StreamingPull returns UNIMPLEMENTED', async () => {
    // StreamingPull is a bidi-streaming RPC; the low-level client exposes it.
    // We call it directly via the gRPC channel to verify UNIMPLEMENTED is returned.
    await new Promise<void>((resolve, reject) => {
      const call = subscriberClient.streamingPull();

      call.on('error', (err: Error & { code?: number }) => {
        if (err.code === grpc.status.UNIMPLEMENTED) {
          resolve();
        } else {
          reject(
            new Error(
              `Expected UNIMPLEMENTED (${grpc.status.UNIMPLEMENTED}) but got code=${err.code}: ${err.message}`
            )
          );
        }
      });

      // Send initial request to trigger the handler
      call.write({
        subscription: subscriptionName,
        streamAckDeadlineSeconds: 10,
      });
    });
  });
});
