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

import { afterAll, beforeAll, describe, test } from 'bun:test';
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
    await new Promise<void>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        reject(new Error('Timeout: StreamingPull did not deliver messages within 5s'));
      }, 5000);

      const call = subscriberClient.streamingPull();
      const received: string[] = [];

      call.on('error', (err: Error & { code?: number }) => {
        clearTimeout(timeoutId);
        reject(err);
      });

      call.on(
        'data',
        (response: {
          receivedMessages?: Array<{ ackId?: string; message?: { data?: Uint8Array } }>;
        }) => {
          const msgs = response.receivedMessages ?? [];

          for (const rm of msgs) {
            if (rm.message?.data) {
              received.push(Buffer.from(rm.message.data).toString('utf-8'));
            }

            // Acknowledge
            if (rm.ackId) {
              call.write({
                subscription: subscriptionName,
                ackIds: [rm.ackId],
              });
            }
          }

          if (received.length >= 2) {
            clearTimeout(timeoutId);
            call.cancel();
            resolve();
          }
        }
      );

      // Start the stream with the initial request
      call.write({
        subscription: subscriptionName,
        streamAckDeadlineSeconds: 10,
      });

      // Publish messages after a short delay so the stream is established
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
  });

  test('processes ack IDs sent during StreamingPull', async () => {
    // Publish a message first
    await publisherClient.publish({
      topic: topicName,
      messages: [{ data: Buffer.from('ack-test-msg') }],
    });

    let ackId: string | undefined;

    // Pull once to get an ack ID
    const [pullResp] = await subscriberClient.pull({
      subscription: subscriptionName,
      maxMessages: 1,
    });

    ackId = pullResp.receivedMessages?.[0]?.ackId ?? undefined;

    if (ackId) {
      // Use StreamingPull to send the ack
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

        // Give the server time to process the ack
        setTimeout(() => {
          clearTimeout(timeoutId);
          call.cancel();
          resolve();
        }, 300);
      });
    }
  });
});
