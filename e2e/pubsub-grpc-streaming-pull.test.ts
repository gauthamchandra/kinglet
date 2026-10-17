/**
 * End-to-End Test: Cloud Pub/Sub StreamingPull
 *
 * Validates StreamingPull using the official @google-cloud/pubsub client library.
 * The high-level PubSub client uses StreamingPull internally when subscribing to
 * messages via `subscription.on('message', ...)`.
 *
 * This test uses the v1 low-level SubscriberClient.streamingPull() directly so that
 * it doesn't depend on the high-level client's internal polling behaviour.
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

let emulatorPort: number;
let grpcPort: number;

const project = 'grpc-streaming-test';
const topicId = 'streaming-e2e-topic';
const topicName = `projects/${project}/topics/${topicId}`;
const subscriptionId = 'streaming-e2e-sub';
const subscriptionName = `projects/${project}/subscriptions/${subscriptionId}`;

// ── Setup / Teardown ──

beforeAll(async () => {
  emulatorPort = await getAvailablePort();
  grpcPort = await getAvailablePort();

  const storage = new StorageManager();

  await storage.initialize({ type: 'memory' });

  const logger = new Logger('e2e-streaming-pull', 'error');

  pubsubService = new PubSubService(storage, logger);
  await pubsubService.initialize();
  pubsubService.start();

  emulatorServer = Bun.serve({
    port: emulatorPort,
    fetch: () => new Response('not used', { status: 404 }),
  });

  const serverConfig = { httpPort: emulatorPort, grpcPort, maxConnections: 100 };

  grpcServer = new GrpcServer(serverConfig, logger);

  for (const def of pubsubService.getGrpcServices()) {
    grpcServer.registerService(def);
  }

  await grpcServer.start();

  const fakeAuth = createFakeAuth(project);
  const clientOpts = {
    apiEndpoint: 'localhost',
    port: grpcPort,
    sslCreds: grpc.credentials.createInsecure(),
    auth: fakeAuth as never,
  };

  publisherClient = new pubsubV1.PublisherClient(clientOpts);
  subscriberClient = new pubsubV1.SubscriberClient(clientOpts);

  // Create the topic and subscription for all tests
  await publisherClient.createTopic({ name: topicName });
  await subscriberClient.createSubscription({ name: subscriptionName, topic: topicName });
});

afterAll(async () => {
  publisherClient.close();
  subscriberClient.close();
  await grpcServer.stop();
  await pubsubService.stop();
  emulatorServer.stop();
});

// ── Tests ──

describe('Cloud Pub/Sub E2E: StreamingPull', () => {
  test('delivers published messages over StreamingPull', async () => {
    const received: string[] = await new Promise<string[]>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        reject(new Error('Timeout: StreamingPull did not deliver messages within 5s'));
      }, 5000);

      const call = subscriberClient.streamingPull();
      const msgs: string[] = [];

      call.on('error', (err: Error & { code?: number }) => {
        clearTimeout(timeoutId);
        reject(err);
      });

      call.on(
        'data',
        (response: {
          receivedMessages?: Array<{ ackId?: string; message?: { data?: Uint8Array } }>;
        }) => {
          for (const rm of response.receivedMessages ?? []) {
            if (rm.message?.data) {
              msgs.push(Buffer.from(rm.message.data).toString('utf-8'));
            }

            if (rm.ackId) {
              // Subsequent frames must NOT include the subscription field — real GCP
              // (and this emulator) rejects follow-up frames that set subscription again.
              call.write({ ackIds: [rm.ackId] });
            }
          }

          if (msgs.length >= 2) {
            clearTimeout(timeoutId);
            call.cancel();
            resolve(msgs);
          }
        }
      );

      call.write({ subscription: subscriptionName, streamAckDeadlineSeconds: 10 });

      setTimeout(async () => {
        try {
          await publisherClient.publish({
            topic: topicName,
            messages: [
              { data: Buffer.from('streaming-msg-1') },
              { data: Buffer.from('streaming-msg-2') },
            ],
          });
        } catch (err) {
          clearTimeout(timeoutId);
          reject(err);
        }
      }, 100);
    });

    expect(received).toHaveLength(2);
    expect(received).toContain('streaming-msg-1');
    expect(received).toContain('streaming-msg-2');
  });

  test('processes ack IDs sent during StreamingPull', async () => {
    await publisherClient.publish({
      topic: topicName,
      messages: [{ data: Buffer.from('ack-test-msg') }],
    });

    const [pullResp] = await subscriberClient.pull({
      subscription: subscriptionName,
      maxMessages: 1,
    });

    const ackId = pullResp.receivedMessages?.[0]?.ackId;

    expect(ackId).toBeTypeOf('string');

    await new Promise<void>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        reject(new Error('Timeout: ack via StreamingPull'));
      }, 3000);

      const call = subscriberClient.streamingPull();

      call.on('error', (err: Error & { code?: number }) => {
        clearTimeout(timeoutId);
        reject(err);
      });

      call.write({
        subscription: subscriptionName,
        streamAckDeadlineSeconds: 10,
        ackIds: [ackId as string],
      });

      setTimeout(() => {
        clearTimeout(timeoutId);
        call.cancel();
        resolve();
      }, 300);
    });

    // Confirm the message was acknowledged and does not re-appear
    const [recheckResp] = await subscriberClient.pull({
      subscription: subscriptionName,
      maxMessages: 1,
    });

    expect(recheckResp.receivedMessages ?? []).toHaveLength(0);
  });

  test('emits INVALID_ARGUMENT when first request has no subscription', async () => {
    const error = await new Promise<Error & { code?: number }>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        reject(new Error('Timeout: expected INVALID_ARGUMENT error within 3s'));
      }, 3000);

      const call = subscriberClient.streamingPull();

      call.on('error', (err: Error & { code?: number }) => {
        clearTimeout(timeoutId);
        resolve(err);
      });

      call.write({ streamAckDeadlineSeconds: 10 } as Parameters<typeof call.write>[0]);
    });

    expect(error.code).toBe(grpc.status.INVALID_ARGUMENT);
  });

  test('emits INVALID_ARGUMENT when subscription is set on a subsequent request frame', async () => {
    const error = await new Promise<Error & { code?: number }>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        reject(new Error('Timeout: expected INVALID_ARGUMENT for duplicate subscription field'));
      }, 3000);

      const call = subscriberClient.streamingPull();

      call.on('error', (err: Error & { code?: number }) => {
        clearTimeout(timeoutId);
        resolve(err);
      });

      call.write({ subscription: subscriptionName, streamAckDeadlineSeconds: 10 });

      // A real client never sends subscription again after the first frame.
      // Verify the emulator rejects it with INVALID_ARGUMENT.
      setTimeout(() => {
        call.write({
          subscription: subscriptionName,
        } as Parameters<typeof call.write>[0]);
      }, 50);
    });

    expect(error.code).toBe(grpc.status.INVALID_ARGUMENT);
  });

  test.each([
    ['0 (proto3 default for omitted field)', 0],
    ['5 (below minimum)', 5],
    ['601 (above maximum)', 601],
  ])('emits INVALID_ARGUMENT when streamAckDeadlineSeconds is %s', async (_label, deadline) => {
    const error = await new Promise<Error & { code?: number }>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        reject(new Error(`Timeout: expected INVALID_ARGUMENT for deadline=${deadline}`));
      }, 3000);

      const call = subscriberClient.streamingPull();

      call.on('error', (err: Error & { code?: number }) => {
        clearTimeout(timeoutId);
        resolve(err);
      });

      call.write({
        subscription: subscriptionName,
        streamAckDeadlineSeconds: deadline,
      } as Parameters<typeof call.write>[0]);
    });

    expect(error.code).toBe(grpc.status.INVALID_ARGUMENT);
  });
});
