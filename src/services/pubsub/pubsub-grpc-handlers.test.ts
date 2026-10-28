/**
 * Unit tests for Pub/Sub gRPC Handlers
 *
 * Covers the gRPC callback layer: correct delegation to services and
 * correct gRPC status codes on error paths.
 */

import { beforeEach, describe, expect, mock, test } from 'bun:test';
import * as grpc from '@grpc/grpc-js';
import { PubSubGrpcHandlers } from './pubsub-grpc-handlers.ts';
import type { SchemaService } from './schema-service.ts';
import type { SnapshotService } from './snapshot-service.ts';
import type { SubscriptionService } from './subscription-service.ts';
import type { TopicService } from './topic-service.ts';
import { PubSubError } from './types.ts';

// ── Minimal mock factories ──

function makeTopicService(): TopicService {
  return {
    createTopic: mock(),
    getTopic: mock(),
    listTopics: mock(),
    updateTopic: mock(),
    deleteTopic: mock(),
  } as unknown as TopicService;
}

function makeSubscriptionService(): SubscriptionService {
  return {
    createSubscription: mock(),
    getSubscription: mock(),
    listSubscriptions: mock(),
    updateSubscription: mock(),
    deleteSubscription: mock(),
    publish: mock(),
    pull: mock(),
    acknowledge: mock(),
    modifyAckDeadline: mock(),
    modifyPushConfig: mock(),
    detachSubscription: mock(),
    seek: mock(),
    listTopicSubscriptions: mock(),
  } as unknown as SubscriptionService;
}

function makeSnapshotService(): SnapshotService {
  return {
    createSnapshot: mock(),
    getSnapshot: mock(),
    listSnapshots: mock(),
    updateSnapshot: mock(),
    deleteSnapshot: mock(),
    listTopicSnapshots: mock(),
  } as unknown as SnapshotService;
}

function makeSchemaService(): SchemaService {
  return {
    createSchema: mock(),
    getSchema: mock(),
    listSchemas: mock(),
    deleteSchema: mock(),
    commitSchema: mock(),
    rollbackSchema: mock(),
    listRevisions: mock(),
    deleteRevision: mock(),
    validateSchema: mock(),
    validateMessage: mock(),
  } as unknown as SchemaService;
}

function makeCallback<T>(): (err: grpc.ServiceError | null, response?: T) => void {
  return mock();
}

function makeCall<T>(request: T): grpc.ServerUnaryCall<T, unknown> {
  return {
    request,
    metadata: new grpc.Metadata(),
  } as grpc.ServerUnaryCall<T, unknown>;
}

type MockCalls<T extends unknown[]> = { mock: { calls: T[] } };

function firstCallArg0<T>(cb: unknown): T {
  const calls = (cb as MockCalls<[T]>).mock.calls;

  expect(calls.length).toBeGreaterThan(0);

  return (calls[0] as [T])[0];
}

function firstCallArg1<T>(cb: unknown): T {
  const calls = (cb as MockCalls<[unknown, T]>).mock.calls;

  expect(calls.length).toBeGreaterThan(0);

  return (calls[0] as [unknown, T])[1];
}

// ── Fixtures ──

const fakeTopic = {
  name: 'projects/p/topics/t',
  state: 'ACTIVE',
};

const fakeSub = {
  name: 'projects/p/subscriptions/s',
  topic: 'projects/p/topics/t',
  ackDeadlineSeconds: 10,
  messageRetentionDuration: '604800s',
  state: 'ACTIVE',
};

const fakeSnapshot = {
  name: 'projects/p/snapshots/snap',
  topic: 'projects/p/topics/t',
};

const fakeSchema = {
  name: 'projects/p/schemas/sch',
  type: 'AVRO',
  definition: '{}',
  revisionId: 'abc123',
  revisionCreateTime: '2026-01-01T00:00:00.000Z',
};

// ── Tests ──

describe('PubSubGrpcHandlers', () => {
  let topicService: TopicService;
  let subscriptionService: SubscriptionService;
  let snapshotService: SnapshotService;
  let schemaService: SchemaService;
  let handlers: PubSubGrpcHandlers;

  beforeEach(() => {
    topicService = makeTopicService();
    subscriptionService = makeSubscriptionService();
    snapshotService = makeSnapshotService();
    schemaService = makeSchemaService();
    handlers = new PubSubGrpcHandlers(
      topicService,
      subscriptionService,
      snapshotService,
      schemaService
    );
  });

  // ── Publisher: CreateTopic ──

  describe('CreateTopic', () => {
    test('delegates to topicService and returns topic', async () => {
      (topicService.createTopic as ReturnType<typeof mock>).mockResolvedValue(fakeTopic);

      const call = makeCall({ name: 'projects/p/topics/t' });
      const callback = makeCallback();

      await handlers.createTopic(call, callback as Parameters<typeof handlers.createTopic>[1]);

      expect(topicService.createTopic).toHaveBeenCalledWith('p', 't', expect.anything());
      expect(firstCallArg0(callback)).toBeNull();
      expect(firstCallArg1<{ name: string }>(callback).name).toBe(fakeTopic.name);
    });

    test('maps ALREADY_EXISTS to grpc.status.ALREADY_EXISTS', async () => {
      (topicService.createTopic as ReturnType<typeof mock>).mockRejectedValue(
        new PubSubError('ALREADY_EXISTS', 'Topic already exists')
      );

      const call = makeCall({ name: 'projects/p/topics/t' });
      const callback = makeCallback();

      await handlers.createTopic(call, callback as Parameters<typeof handlers.createTopic>[1]);

      const err = firstCallArg0<grpc.ServiceError>(callback);

      expect(err.code).toBe(grpc.status.ALREADY_EXISTS);
    });

    test('maps INVALID_ARGUMENT to grpc.status.INVALID_ARGUMENT', async () => {
      (topicService.createTopic as ReturnType<typeof mock>).mockRejectedValue(
        new PubSubError('INVALID_ARGUMENT', 'Invalid topic')
      );

      const call = makeCall({ name: 'projects/p/topics/t' });
      const callback = makeCallback();

      await handlers.createTopic(call, callback as Parameters<typeof handlers.createTopic>[1]);

      const err = firstCallArg0<grpc.ServiceError>(callback);

      expect(err.code).toBe(grpc.status.INVALID_ARGUMENT);
    });
  });

  // ── Publisher: GetTopic ──

  describe('GetTopic', () => {
    test('delegates to topicService and returns topic', async () => {
      (topicService.getTopic as ReturnType<typeof mock>).mockResolvedValue(fakeTopic);

      const call = makeCall({ topic: 'projects/p/topics/t' });
      const callback = makeCallback();

      await handlers.getTopic(call, callback as Parameters<typeof handlers.getTopic>[1]);

      expect(topicService.getTopic).toHaveBeenCalledWith('projects/p/topics/t');
      expect(firstCallArg0(callback)).toBeNull();
    });

    test('maps NOT_FOUND to grpc.status.NOT_FOUND', async () => {
      (topicService.getTopic as ReturnType<typeof mock>).mockRejectedValue(
        new PubSubError('NOT_FOUND', 'Topic not found')
      );

      const call = makeCall({ topic: 'projects/p/topics/missing' });
      const callback = makeCallback();

      await handlers.getTopic(call, callback as Parameters<typeof handlers.getTopic>[1]);

      const err = firstCallArg0<grpc.ServiceError>(callback);

      expect(err.code).toBe(grpc.status.NOT_FOUND);
    });
  });

  // ── Publisher: UpdateTopic ──

  describe('UpdateTopic', () => {
    test('delegates to topicService with update body', async () => {
      (topicService.updateTopic as ReturnType<typeof mock>).mockResolvedValue(fakeTopic);

      const call = makeCall({
        topic: { name: 'projects/p/topics/t', labels: { env: 'test' } },
        updateMask: { paths: ['labels'] },
      });
      const callback = makeCallback();

      await handlers.updateTopic(call, callback as Parameters<typeof handlers.updateTopic>[1]);

      expect(topicService.updateTopic).toHaveBeenCalled();
      expect(firstCallArg0(callback)).toBeNull();
    });
  });

  // ── Publisher: ListTopics ──

  describe('ListTopics', () => {
    test('delegates to topicService and returns list', async () => {
      (topicService.listTopics as ReturnType<typeof mock>).mockResolvedValue({
        topics: [fakeTopic],
        nextPageToken: undefined,
      });

      const call = makeCall({ project: 'projects/p', pageSize: 10 });
      const callback = makeCallback();

      await handlers.listTopics(call, callback as Parameters<typeof handlers.listTopics>[1]);

      expect(topicService.listTopics).toHaveBeenCalledWith('p', 10, undefined);
      expect(firstCallArg0(callback)).toBeNull();

      const result = firstCallArg1<{ topics: unknown[]; nextPageToken: string }>(callback);

      expect(result.topics).toHaveLength(1);
      expect(result.nextPageToken).toBe('');
    });
  });

  // ── Publisher: DeleteTopic ──

  describe('DeleteTopic', () => {
    test('delegates to topicService and returns empty', async () => {
      (topicService.deleteTopic as ReturnType<typeof mock>).mockResolvedValue(undefined);

      const call = makeCall({ topic: 'projects/p/topics/t' });
      const callback = makeCallback();

      await handlers.deleteTopic(call, callback as Parameters<typeof handlers.deleteTopic>[1]);

      expect(topicService.deleteTopic).toHaveBeenCalledWith('projects/p/topics/t');
      expect(firstCallArg0(callback)).toBeNull();
      expect(firstCallArg1<Record<string, never>>(callback)).toEqual({});
    });
  });

  // ── Publisher: Publish ──

  describe('Publish', () => {
    test('delegates to subscriptionService.publish and returns messageIds', async () => {
      (subscriptionService.publish as ReturnType<typeof mock>).mockResolvedValue({
        messageIds: ['msg1', 'msg2'],
      });

      const msgData = new Uint8Array([104, 101, 108, 108, 111]); // 'hello'
      const call = makeCall({
        topic: 'projects/p/topics/t',
        messages: [{ data: msgData, attributes: { k: 'v' } }],
      });
      const callback = makeCallback();

      await handlers.publish(call, callback as Parameters<typeof handlers.publish>[1]);

      expect(subscriptionService.publish).toHaveBeenCalled();
      expect(firstCallArg0(callback)).toBeNull();

      const result = firstCallArg1<{ messageIds: string[] }>(callback);

      expect(result.messageIds).toHaveLength(2);
    });

    test('converts Uint8Array data to base64 before calling service', async () => {
      (subscriptionService.publish as ReturnType<typeof mock>).mockResolvedValue({
        messageIds: ['id1'],
      });

      const rawBytes = new TextEncoder().encode('test-data');
      const call = makeCall({
        topic: 'projects/p/topics/t',
        messages: [{ data: rawBytes }],
      });
      const callback = makeCallback();

      await handlers.publish(call, callback as Parameters<typeof handlers.publish>[1]);

      const publishCall = (subscriptionService.publish as ReturnType<typeof mock>).mock.calls[0];
      const body = publishCall?.[1] as { messages: Array<{ data?: string }> };

      expect(body?.messages?.[0]?.data).toBeTypeOf('string');
    });
  });

  // ── Publisher: ListTopicSubscriptions ──

  describe('ListTopicSubscriptions', () => {
    test('delegates to subscriptionService and returns subscription names', async () => {
      (subscriptionService.listTopicSubscriptions as ReturnType<typeof mock>).mockResolvedValue({
        subscriptions: ['projects/p/subscriptions/s'],
      });

      const call = makeCall({ topic: 'projects/p/topics/t' });
      const callback = makeCallback();

      await handlers.listTopicSubscriptions(
        call,
        callback as Parameters<typeof handlers.listTopicSubscriptions>[1]
      );

      expect(firstCallArg0(callback)).toBeNull();

      const result = firstCallArg1<{ subscriptions: string[] }>(callback);

      expect(result.subscriptions).toContain('projects/p/subscriptions/s');
    });
  });

  // ── Publisher: ListTopicSnapshots ──

  describe('ListTopicSnapshots', () => {
    test('delegates to snapshotService and returns snapshot names', async () => {
      (snapshotService.listTopicSnapshots as ReturnType<typeof mock>).mockResolvedValue({
        snapshots: ['projects/p/snapshots/snap'],
      });

      const call = makeCall({ topic: 'projects/p/topics/t' });
      const callback = makeCallback();

      await handlers.listTopicSnapshots(
        call,
        callback as Parameters<typeof handlers.listTopicSnapshots>[1]
      );

      expect(firstCallArg0(callback)).toBeNull();

      const result = firstCallArg1<{ snapshots: string[] }>(callback);

      expect(result.snapshots).toContain('projects/p/snapshots/snap');
    });
  });

  // ── Publisher: DetachSubscription ──

  describe('DetachSubscription', () => {
    test('delegates to subscriptionService.detachSubscription and returns empty', async () => {
      (subscriptionService.detachSubscription as ReturnType<typeof mock>).mockResolvedValue(
        undefined
      );

      const call = makeCall({ subscription: 'projects/p/subscriptions/s' });
      const callback = makeCallback();

      await handlers.detachSubscription(
        call,
        callback as Parameters<typeof handlers.detachSubscription>[1]
      );

      expect(subscriptionService.detachSubscription).toHaveBeenCalledWith(
        'projects/p/subscriptions/s'
      );
      expect(firstCallArg0(callback)).toBeNull();
      expect(firstCallArg1<Record<string, never>>(callback)).toEqual({});
    });
  });

  // ── Subscriber: CreateSubscription ──

  describe('CreateSubscription', () => {
    test('delegates to subscriptionService and returns subscription', async () => {
      (subscriptionService.createSubscription as ReturnType<typeof mock>).mockResolvedValue(
        fakeSub
      );

      const call = makeCall({
        name: 'projects/p/subscriptions/s',
        topic: 'projects/p/topics/t',
        ackDeadlineSeconds: 20,
      });
      const callback = makeCallback();

      await handlers.createSubscription(
        call,
        callback as Parameters<typeof handlers.createSubscription>[1]
      );

      expect(subscriptionService.createSubscription).toHaveBeenCalledWith(
        'p',
        's',
        expect.anything()
      );
      expect(firstCallArg0(callback)).toBeNull();
    });
  });

  // ── Subscriber: GetSubscription ──

  describe('GetSubscription', () => {
    test('delegates to subscriptionService and returns subscription', async () => {
      (subscriptionService.getSubscription as ReturnType<typeof mock>).mockResolvedValue(fakeSub);

      const call = makeCall({ subscription: 'projects/p/subscriptions/s' });
      const callback = makeCallback();

      await handlers.getSubscription(
        call,
        callback as Parameters<typeof handlers.getSubscription>[1]
      );

      expect(firstCallArg0(callback)).toBeNull();

      const result = firstCallArg1<{ name: string }>(callback);

      expect(result.name).toBe(fakeSub.name);
    });
  });

  // ── Subscriber: Pull ──

  describe('Pull', () => {
    test('delegates to subscriptionService and returns received messages', async () => {
      const fakeMessage = {
        messageId: 'msg1',
        data: 'aGVsbG8=', // base64 'hello'
        attributes: {},
        publishTime: '2026-01-01T00:00:00.000Z',
      };

      (subscriptionService.pull as ReturnType<typeof mock>).mockResolvedValue({
        receivedMessages: [{ ackId: 'ack-1', message: fakeMessage, deliveryAttempt: 1 }],
      });

      const call = makeCall({
        subscription: 'projects/p/subscriptions/s',
        maxMessages: 5,
      });
      const callback = makeCallback();

      await handlers.pull(call, callback as Parameters<typeof handlers.pull>[1]);

      expect(subscriptionService.pull).toHaveBeenCalled();
      expect(firstCallArg0(callback)).toBeNull();

      const result = firstCallArg1<{ receivedMessages: unknown[] }>(callback);

      expect(result.receivedMessages).toHaveLength(1);
    });

    test('converts base64 data to Uint8Array in message', async () => {
      (subscriptionService.pull as ReturnType<typeof mock>).mockResolvedValue({
        receivedMessages: [
          {
            ackId: 'ack-1',
            message: {
              messageId: 'msg1',
              data: 'aGVsbG8=', // base64 'hello'
              attributes: {},
              publishTime: '2026-01-01T00:00:00.000Z',
            },
          },
        ],
      });

      const call = makeCall({
        subscription: 'projects/p/subscriptions/s',
        maxMessages: 1,
      });
      const callback = makeCallback();

      await handlers.pull(call, callback as Parameters<typeof handlers.pull>[1]);

      const result = firstCallArg1<{
        receivedMessages: Array<{ message: { data: unknown } }>;
      }>(callback);

      expect(result.receivedMessages[0]?.message?.data).toBeInstanceOf(Uint8Array);
    });
  });

  // ── Subscriber: Acknowledge ──

  describe('Acknowledge', () => {
    test('delegates to subscriptionService and returns empty', async () => {
      (subscriptionService.acknowledge as ReturnType<typeof mock>).mockResolvedValue(undefined);

      const call = makeCall({
        subscription: 'projects/p/subscriptions/s',
        ackIds: ['ack-1', 'ack-2'],
      });
      const callback = makeCallback();

      await handlers.acknowledge(call, callback as Parameters<typeof handlers.acknowledge>[1]);

      expect(subscriptionService.acknowledge).toHaveBeenCalled();
      expect(firstCallArg0(callback)).toBeNull();
      expect(firstCallArg1<Record<string, never>>(callback)).toEqual({});
    });
  });

  // ── Subscriber: ModifyAckDeadline ──

  describe('ModifyAckDeadline', () => {
    test('delegates to subscriptionService and returns empty', async () => {
      (subscriptionService.modifyAckDeadline as ReturnType<typeof mock>).mockResolvedValue(
        undefined
      );

      const call = makeCall({
        subscription: 'projects/p/subscriptions/s',
        ackIds: ['ack-1'],
        ackDeadlineSeconds: 30,
      });
      const callback = makeCallback();

      await handlers.modifyAckDeadline(
        call,
        callback as Parameters<typeof handlers.modifyAckDeadline>[1]
      );

      expect(firstCallArg0(callback)).toBeNull();
      expect(firstCallArg1<Record<string, never>>(callback)).toEqual({});
    });
  });

  // ── Subscriber: Seek ──

  describe('Seek', () => {
    test('seek by time delegates to subscriptionService', async () => {
      (subscriptionService.seek as ReturnType<typeof mock>).mockResolvedValue(undefined);

      const call = makeCall({
        subscription: 'projects/p/subscriptions/s',
        seekTo: 'time',
        time: { seconds: '1735689600', nanos: 0 },
      });
      const callback = makeCallback();

      await handlers.seek(call, callback as Parameters<typeof handlers.seek>[1]);

      expect(subscriptionService.seek).toHaveBeenCalled();
      expect(firstCallArg0(callback)).toBeNull();
      expect(firstCallArg1<Record<string, never>>(callback)).toEqual({});
    });

    test('seek by snapshot delegates to subscriptionService', async () => {
      (subscriptionService.seek as ReturnType<typeof mock>).mockResolvedValue(undefined);

      const call = makeCall({
        subscription: 'projects/p/subscriptions/s',
        seekTo: 'snapshot',
        snapshot: 'projects/p/snapshots/snap',
      });
      const callback = makeCallback();

      await handlers.seek(call, callback as Parameters<typeof handlers.seek>[1]);

      expect(subscriptionService.seek).toHaveBeenCalled();
      expect(firstCallArg0(callback)).toBeNull();
    });
  });

  // ── Subscriber: CreateSnapshot ──

  describe('CreateSnapshot', () => {
    test('delegates to snapshotService and returns snapshot', async () => {
      (snapshotService.createSnapshot as ReturnType<typeof mock>).mockResolvedValue(fakeSnapshot);

      const call = makeCall({
        name: 'projects/p/snapshots/snap',
        subscription: 'projects/p/subscriptions/s',
      });
      const callback = makeCallback();

      await handlers.createSnapshot(
        call,
        callback as Parameters<typeof handlers.createSnapshot>[1]
      );

      expect(snapshotService.createSnapshot).toHaveBeenCalledWith('p', 'snap', expect.anything());
      expect(firstCallArg0(callback)).toBeNull();
    });
  });

  // ── Subscriber: GetSnapshot ──

  describe('GetSnapshot', () => {
    test('delegates to snapshotService and returns snapshot', async () => {
      (snapshotService.getSnapshot as ReturnType<typeof mock>).mockResolvedValue(fakeSnapshot);

      const call = makeCall({ snapshot: 'projects/p/snapshots/snap' });
      const callback = makeCallback();

      await handlers.getSnapshot(call, callback as Parameters<typeof handlers.getSnapshot>[1]);

      expect(firstCallArg0(callback)).toBeNull();
    });
  });

  // ── Subscriber: ListSnapshots ──

  describe('ListSnapshots', () => {
    test('delegates to snapshotService and returns list', async () => {
      (snapshotService.listSnapshots as ReturnType<typeof mock>).mockResolvedValue({
        snapshots: [fakeSnapshot],
        nextPageToken: undefined,
      });

      const call = makeCall({ project: 'projects/p', pageSize: 10 });
      const callback = makeCallback();

      await handlers.listSnapshots(call, callback as Parameters<typeof handlers.listSnapshots>[1]);

      expect(snapshotService.listSnapshots).toHaveBeenCalledWith('p', 10, undefined);
      expect(firstCallArg0(callback)).toBeNull();
    });
  });

  // ── Subscriber: DeleteSnapshot ──

  describe('DeleteSnapshot', () => {
    test('delegates to snapshotService and returns empty', async () => {
      (snapshotService.deleteSnapshot as ReturnType<typeof mock>).mockResolvedValue(undefined);

      const call = makeCall({ snapshot: 'projects/p/snapshots/snap' });
      const callback = makeCallback();

      await handlers.deleteSnapshot(
        call,
        callback as Parameters<typeof handlers.deleteSnapshot>[1]
      );

      expect(snapshotService.deleteSnapshot).toHaveBeenCalledWith('projects/p/snapshots/snap');
      expect(firstCallArg0(callback)).toBeNull();
      expect(firstCallArg1<Record<string, never>>(callback)).toEqual({});
    });
  });

  // ── Subscriber: StreamingPull ──

  describe('StreamingPull', () => {
    const fireEvent = (
      listeners: Record<string, ((arg: unknown) => void)[]>,
      event: string,
      arg: unknown = undefined
    ) => {
      for (const handler of listeners[event] ?? []) {
        handler(arg);
      }
    };

    const makeMockCall = (
      eventListeners: Record<string, ((arg: unknown) => void)[]>,
      writeReturnValue = true
    ) =>
      ({
        write: mock(() => writeReturnValue),
        end: mock(),
        emit: mock(),
        on: (event: string, handler: (arg: unknown) => void) => {
          if (!eventListeners[event]) {
            eventListeners[event] = [];
          }

          eventListeners[event].push(handler);
        },
        metadata: new grpc.Metadata(),
      }) as unknown as grpc.ServerDuplexStream<unknown, unknown>;

    test('delivers messages to the client stream', async () => {
      (subscriptionService.pull as ReturnType<typeof mock>).mockResolvedValue({
        receivedMessages: [
          {
            ackId: 'ack-1',
            message: {
              messageId: 'msg-1',
              data: 'aGVsbG8=',
              attributes: {},
              publishTime: '2026-01-01T00:00:00.000Z',
            },
          },
        ],
      });

      const eventListeners: Record<string, ((arg: unknown) => void)[]> = {};
      const mockCall = makeMockCall(eventListeners);

      handlers.streamingPull(mockCall);

      fireEvent(eventListeners, 'data', {
        subscription: 'projects/p/subscriptions/s',
        streamAckDeadlineSeconds: 10,
        ackIds: [],
      });

      await new Promise(resolve => setTimeout(resolve, 200));

      fireEvent(eventListeners, 'cancelled');

      expect(subscriptionService.pull).toHaveBeenCalledWith(
        'projects/p/subscriptions/s',
        { maxMessages: 100 },
        10
      );
      expect((mockCall.write as ReturnType<typeof mock>).mock.calls.length).toBeGreaterThanOrEqual(
        1
      );
    });

    test('processes ack requests from the client', async () => {
      (subscriptionService.pull as ReturnType<typeof mock>).mockResolvedValue({
        receivedMessages: [],
      });
      (subscriptionService.acknowledge as ReturnType<typeof mock>).mockResolvedValue(undefined);

      const eventListeners: Record<string, ((arg: unknown) => void)[]> = {};
      const mockCall = makeMockCall(eventListeners);

      handlers.streamingPull(mockCall);

      fireEvent(eventListeners, 'data', {
        subscription: 'projects/p/subscriptions/s',
        streamAckDeadlineSeconds: 10,
      });

      // Subsequent requests must NOT include the subscription field (real GCP rejects those).
      fireEvent(eventListeners, 'data', {
        ackIds: ['ack-id-1', 'ack-id-2'],
      });

      await new Promise(resolve => setTimeout(resolve, 100));

      fireEvent(eventListeners, 'cancelled');

      expect(subscriptionService.acknowledge).toHaveBeenCalledWith('projects/p/subscriptions/s', {
        ackIds: ['ack-id-1', 'ack-id-2'],
      });
    });

    test('processes modifyDeadlineAckIds pairwise from the client', async () => {
      (subscriptionService.pull as ReturnType<typeof mock>).mockResolvedValue({
        receivedMessages: [],
      });
      (subscriptionService.modifyAckDeadline as ReturnType<typeof mock>).mockResolvedValue(
        undefined
      );

      const eventListeners: Record<string, ((arg: unknown) => void)[]> = {};
      const mockCall = makeMockCall(eventListeners);

      handlers.streamingPull(mockCall);

      fireEvent(eventListeners, 'data', {
        subscription: 'projects/p/subscriptions/s',
        streamAckDeadlineSeconds: 10,
      });

      fireEvent(eventListeners, 'data', {
        modifyDeadlineAckIds: ['ack-1', 'ack-2'],
        modifyDeadlineSeconds: [0, 30],
      });

      await new Promise(resolve => setTimeout(resolve, 100));

      fireEvent(eventListeners, 'cancelled');

      expect(subscriptionService.modifyAckDeadline).toHaveBeenCalledWith(
        'projects/p/subscriptions/s',
        { ackIds: ['ack-1'], ackDeadlineSeconds: 0 }
      );
      expect(subscriptionService.modifyAckDeadline).toHaveBeenCalledWith(
        'projects/p/subscriptions/s',
        { ackIds: ['ack-2'], ackDeadlineSeconds: 30 }
      );
    });

    test('stops polling on cancellation', async () => {
      (subscriptionService.pull as ReturnType<typeof mock>).mockResolvedValue({
        receivedMessages: [],
      });

      const eventListeners: Record<string, ((arg: unknown) => void)[]> = {};
      const mockCall = makeMockCall(eventListeners);

      handlers.streamingPull(mockCall);

      fireEvent(eventListeners, 'data', {
        subscription: 'projects/p/subscriptions/s',
        streamAckDeadlineSeconds: 10,
      });

      fireEvent(eventListeners, 'cancelled');

      const callsBefore = (subscriptionService.pull as ReturnType<typeof mock>).mock.calls.length;

      await new Promise(resolve => setTimeout(resolve, 300));

      const callsAfter = (subscriptionService.pull as ReturnType<typeof mock>).mock.calls.length;

      expect(callsAfter).toBe(callsBefore);
    });

    test('releases leases via modifyAckDeadline(0) when stream is cancelled mid-pull', async () => {
      let resolvePull!: (value: { receivedMessages: { ackId: string }[] }) => void;

      const pullPromise = new Promise<{ receivedMessages: { ackId: string }[] }>(resolve => {
        resolvePull = resolve;
      });

      (subscriptionService.pull as ReturnType<typeof mock>).mockReturnValue(pullPromise);
      (subscriptionService.modifyAckDeadline as ReturnType<typeof mock>).mockResolvedValue(
        undefined
      );

      const eventListeners: Record<string, ((arg: unknown) => void)[]> = {};
      const mockCall = makeMockCall(eventListeners);

      handlers.streamingPull(mockCall);

      fireEvent(eventListeners, 'data', {
        subscription: 'projects/p/subscriptions/s',
        streamAckDeadlineSeconds: 10,
      });

      // scheduleNextPoll() delays 100 ms before the first call to pollMessages.
      // Wait 150 ms so the poll is definitely in-flight (pull() awaiting).
      await new Promise(resolve => setTimeout(resolve, 150));

      // Cancel the stream while pull() is still awaiting.
      fireEvent(eventListeners, 'cancelled');

      // Now resolve pull() with messages — the stream is already cancelled.
      resolvePull({ receivedMessages: [{ ackId: 'ack-leaked' }] });

      await new Promise(resolve => setTimeout(resolve, 50));

      expect(subscriptionService.modifyAckDeadline).toHaveBeenCalledWith(
        'projects/p/subscriptions/s',
        { ackIds: ['ack-leaked'], ackDeadlineSeconds: 0 }
      );
      expect(mockCall.write).not.toHaveBeenCalled();
    });

    test('emits INVALID_ARGUMENT when first request has no subscription', async () => {
      const eventListeners: Record<string, ((arg: unknown) => void)[]> = {};
      const mockCall = makeMockCall(eventListeners);

      handlers.streamingPull(mockCall);

      fireEvent(eventListeners, 'data', { streamAckDeadlineSeconds: 10 });

      await new Promise(resolve => setTimeout(resolve, 50));

      expect(mockCall.emit).toHaveBeenCalledWith(
        'error',
        expect.objectContaining({ code: grpc.status.INVALID_ARGUMENT })
      );
      expect(subscriptionService.pull).not.toHaveBeenCalled();
    });

    test.each([
      ['omitted (proto3 default 0)', 0],
      ['below minimum (5)', 5],
      ['above maximum (601)', 601],
    ])('emits INVALID_ARGUMENT when streamAckDeadlineSeconds is %s', async (_label, deadline) => {
      const eventListeners: Record<string, ((arg: unknown) => void)[]> = {};
      const mockCall = makeMockCall(eventListeners);

      handlers.streamingPull(mockCall);

      fireEvent(eventListeners, 'data', {
        subscription: 'projects/p/subscriptions/s',
        streamAckDeadlineSeconds: deadline,
      });

      await new Promise(resolve => setTimeout(resolve, 50));

      expect(mockCall.emit).toHaveBeenCalledWith(
        'error',
        expect.objectContaining({ code: grpc.status.INVALID_ARGUMENT })
      );
      expect(subscriptionService.pull).not.toHaveBeenCalled();
    });

    test('emits NOT_FOUND when subscription does not exist', async () => {
      (subscriptionService.pull as ReturnType<typeof mock>).mockRejectedValue(
        new PubSubError('NOT_FOUND', 'Subscription projects/p/subscriptions/missing not found')
      );

      const eventListeners: Record<string, ((arg: unknown) => void)[]> = {};
      const mockCall = makeMockCall(eventListeners);

      handlers.streamingPull(mockCall);

      fireEvent(eventListeners, 'data', {
        subscription: 'projects/p/subscriptions/missing',
        streamAckDeadlineSeconds: 10,
      });

      await new Promise(resolve => setTimeout(resolve, 200));

      expect(mockCall.emit).toHaveBeenCalledWith(
        'error',
        expect.objectContaining({ code: grpc.status.NOT_FOUND })
      );
    });

    test('emits INVALID_ARGUMENT when subscription is set on a subsequent request', async () => {
      (subscriptionService.pull as ReturnType<typeof mock>).mockResolvedValue({
        receivedMessages: [],
      });

      const eventListeners: Record<string, ((arg: unknown) => void)[]> = {};
      const mockCall = makeMockCall(eventListeners);

      handlers.streamingPull(mockCall);

      fireEvent(eventListeners, 'data', {
        subscription: 'projects/p/subscriptions/s',
        streamAckDeadlineSeconds: 10,
      });

      fireEvent(eventListeners, 'data', {
        subscription: 'projects/p/subscriptions/s',
        ackIds: [],
      });

      await new Promise(resolve => setTimeout(resolve, 50));

      expect(mockCall.emit).toHaveBeenCalledWith(
        'error',
        expect.objectContaining({ code: grpc.status.INVALID_ARGUMENT })
      );
    });

    test('stopActiveStreams ends all active streaming calls and stops the poll loop', async () => {
      (subscriptionService.pull as ReturnType<typeof mock>).mockResolvedValue({
        receivedMessages: [],
      });

      const eventListeners1: Record<string, ((arg: unknown) => void)[]> = {};
      const mockCall1 = makeMockCall(eventListeners1);
      const eventListeners2: Record<string, ((arg: unknown) => void)[]> = {};
      const mockCall2 = makeMockCall(eventListeners2);

      handlers.streamingPull(mockCall1);
      handlers.streamingPull(mockCall2);

      fireEvent(eventListeners1, 'data', {
        subscription: 'projects/p/subscriptions/s1',
        streamAckDeadlineSeconds: 10,
      });
      fireEvent(eventListeners2, 'data', {
        subscription: 'projects/p/subscriptions/s2',
        streamAckDeadlineSeconds: 10,
      });

      await new Promise(resolve => setTimeout(resolve, 150));

      handlers.stopActiveStreams();

      expect((mockCall1.end as ReturnType<typeof mock>).mock.calls.length).toBeGreaterThanOrEqual(
        1
      );
      expect((mockCall2.end as ReturnType<typeof mock>).mock.calls.length).toBeGreaterThanOrEqual(
        1
      );

      const pullCountAtStop = (subscriptionService.pull as ReturnType<typeof mock>).mock.calls
        .length;

      await new Promise(resolve => setTimeout(resolve, 300));

      const pullCountAfterWait = (subscriptionService.pull as ReturnType<typeof mock>).mock.calls
        .length;

      expect(pullCountAfterWait).toBe(pullCountAtStop);
    });
  });

  // ── SchemaService: CreateSchema ──

  describe('CreateSchema', () => {
    test('delegates to schemaService and returns schema', async () => {
      (schemaService.createSchema as ReturnType<typeof mock>).mockResolvedValue(fakeSchema);

      const call = makeCall({
        parent: 'projects/p',
        schemaId: 'sch',
        schema: { type: 'AVRO', definition: '{}' },
      });
      const callback = makeCallback();

      await handlers.createSchema(call, callback as Parameters<typeof handlers.createSchema>[1]);

      expect(schemaService.createSchema).toHaveBeenCalledWith('p', 'sch', expect.anything());
      expect(firstCallArg0(callback)).toBeNull();
    });
  });

  // ── SchemaService: GetSchema ──

  describe('GetSchema', () => {
    test('delegates to schemaService and returns schema', async () => {
      (schemaService.getSchema as ReturnType<typeof mock>).mockResolvedValue(fakeSchema);

      const call = makeCall({ name: 'projects/p/schemas/sch', view: 'FULL' });
      const callback = makeCallback();

      await handlers.getSchema(call, callback as Parameters<typeof handlers.getSchema>[1]);

      expect(firstCallArg0(callback)).toBeNull();

      const result = firstCallArg1<{ name: string }>(callback);

      expect(result.name).toBe(fakeSchema.name);
    });
  });

  // ── SchemaService: ListSchemas ──

  describe('ListSchemas', () => {
    test('delegates to schemaService and returns list', async () => {
      (schemaService.listSchemas as ReturnType<typeof mock>).mockResolvedValue({
        schemas: [fakeSchema],
        nextPageToken: undefined,
      });

      const call = makeCall({ parent: 'projects/p', pageSize: 10 });
      const callback = makeCallback();

      await handlers.listSchemas(call, callback as Parameters<typeof handlers.listSchemas>[1]);

      expect(schemaService.listSchemas).toHaveBeenCalledWith('p', 10, undefined, undefined);
      expect(firstCallArg0(callback)).toBeNull();
    });
  });

  // ── SchemaService: DeleteSchema ──

  describe('DeleteSchema', () => {
    test('delegates to schemaService and returns empty', async () => {
      (schemaService.deleteSchema as ReturnType<typeof mock>).mockResolvedValue(undefined);

      const call = makeCall({ name: 'projects/p/schemas/sch' });
      const callback = makeCallback();

      await handlers.deleteSchema(call, callback as Parameters<typeof handlers.deleteSchema>[1]);

      expect(schemaService.deleteSchema).toHaveBeenCalledWith('projects/p/schemas/sch');
      expect(firstCallArg0(callback)).toBeNull();
      expect(firstCallArg1<Record<string, never>>(callback)).toEqual({});
    });
  });

  // ── SchemaService: CommitSchema ──

  describe('CommitSchema', () => {
    test('delegates to schemaService and returns schema', async () => {
      (schemaService.commitSchema as ReturnType<typeof mock>).mockResolvedValue(fakeSchema);

      const call = makeCall({
        name: 'projects/p/schemas/sch',
        schema: { type: 'AVRO', definition: '{"v":2}' },
      });
      const callback = makeCallback();

      await handlers.commitSchema(call, callback as Parameters<typeof handlers.commitSchema>[1]);

      expect(schemaService.commitSchema).toHaveBeenCalled();
      expect(firstCallArg0(callback)).toBeNull();
    });
  });

  // ── SchemaService: ValidateSchema ──

  describe('ValidateSchema', () => {
    test('delegates to schemaService and returns empty', async () => {
      (schemaService.validateSchema as ReturnType<typeof mock>).mockResolvedValue({});

      const call = makeCall({
        parent: 'projects/p',
        schema: { type: 'AVRO', definition: '{}' },
      });
      const callback = makeCallback();

      await handlers.validateSchema(
        call,
        callback as Parameters<typeof handlers.validateSchema>[1]
      );

      expect(firstCallArg0(callback)).toBeNull();
    });
  });

  // ── SchemaService: ValidateMessage ──

  describe('ValidateMessage', () => {
    test('delegates to schemaService and returns empty', async () => {
      (schemaService.validateMessage as ReturnType<typeof mock>).mockResolvedValue({});

      const call = makeCall({
        parent: 'projects/p',
        name: 'projects/p/schemas/sch',
        encoding: 'JSON',
        message: new Uint8Array([123, 125]),
      });
      const callback = makeCallback();

      await handlers.validateMessage(
        call,
        callback as Parameters<typeof handlers.validateMessage>[1]
      );

      expect(firstCallArg0(callback)).toBeNull();
    });
  });

  // ── Error mapping ──

  describe('Error mapping', () => {
    test('maps FAILED_PRECONDITION to grpc.status.FAILED_PRECONDITION', async () => {
      (subscriptionService.pull as ReturnType<typeof mock>).mockRejectedValue(
        new PubSubError('FAILED_PRECONDITION', 'Subscription is detached')
      );

      const call = makeCall({
        subscription: 'projects/p/subscriptions/s',
        maxMessages: 1,
      });
      const callback = makeCallback();

      await handlers.pull(call, callback as Parameters<typeof handlers.pull>[1]);

      const err = firstCallArg0<grpc.ServiceError>(callback);

      expect(err.code).toBe(grpc.status.FAILED_PRECONDITION);
    });

    test('maps unknown errors to grpc.status.INTERNAL', async () => {
      (topicService.getTopic as ReturnType<typeof mock>).mockRejectedValue(
        new Error('unexpected internal failure')
      );

      const call = makeCall({ topic: 'projects/p/topics/t' });
      const callback = makeCallback();

      await handlers.getTopic(call, callback as Parameters<typeof handlers.getTopic>[1]);

      const err = firstCallArg0<grpc.ServiceError>(callback);

      expect(err.code).toBe(grpc.status.INTERNAL);
    });
  });

  // ── UpdateSubscription: nested mask paths ──

  describe('UpdateSubscription nested mask path', () => {
    test('nested push_config.push_endpoint path passes dotted camelCase mask to service', async () => {
      (subscriptionService.updateSubscription as ReturnType<typeof mock>).mockResolvedValue(
        fakeSub
      );

      const call = makeCall({
        subscription: {
          name: 'projects/p/subscriptions/s',
          pushConfig: { pushEndpoint: 'https://new.example.com/push' },
        },
        updateMask: { paths: ['push_config.push_endpoint'] },
      });
      const callback = makeCallback();

      await handlers.updateSubscription(
        call,
        callback as Parameters<typeof handlers.updateSubscription>[1]
      );

      expect(firstCallArg0(callback)).toBeNull();

      const [, body] = (subscriptionService.updateSubscription as ReturnType<typeof mock>).mock
        .calls[0] as [string, { subscription: unknown; updateMask: string }];

      expect(body.updateMask).toBe('pushConfig.pushEndpoint');
    });
  });

  // ── Conversion helpers ──

  describe('Conversion helpers', () => {
    test('createSubscription converts cloudStorageConfig.maxDuration from proto Duration to string', async () => {
      const fakeSubWithCloud = {
        ...fakeSub,
        cloudStorageConfig: { bucket: 'my-bucket', maxDuration: '300s' },
      };

      (subscriptionService.createSubscription as ReturnType<typeof mock>).mockResolvedValue(
        fakeSubWithCloud
      );

      const call = makeCall({
        name: 'projects/p/subscriptions/s',
        topic: 'projects/p/topics/t',
        cloudStorageConfig: {
          bucket: 'my-bucket',
          maxDuration: { seconds: '300', nanos: 0 },
        },
      });
      const callback = makeCallback();

      await handlers.createSubscription(
        call,
        callback as Parameters<typeof handlers.createSubscription>[1]
      );

      expect(firstCallArg0(callback)).toBeNull();

      // Assert the service received the string form (inbound proto → service conversion)
      expect(subscriptionService.createSubscription).toHaveBeenCalledWith(
        'p',
        's',
        expect.objectContaining({
          cloudStorageConfig: expect.objectContaining({ maxDuration: '300s' }),
        })
      );

      // Assert the response carries the proto Duration form (outbound service → proto conversion)
      const result = firstCallArg1<{
        cloudStorageConfig?: { maxDuration?: { seconds: string; nanos: number } };
      }>(callback);

      expect(result.cloudStorageConfig?.maxDuration).toEqual({ seconds: '300', nanos: 0 });
    });

    test('getSubscription converts cloudStorageConfig.maxDuration from string to proto Duration in response', async () => {
      (subscriptionService.getSubscription as ReturnType<typeof mock>).mockResolvedValue({
        ...fakeSub,
        cloudStorageConfig: { bucket: 'my-bucket', maxDuration: '300s' },
      });

      const call = makeCall({ subscription: 'projects/p/subscriptions/s' });
      const callback = makeCallback();

      await handlers.getSubscription(
        call,
        callback as Parameters<typeof handlers.getSubscription>[1]
      );

      expect(firstCallArg0(callback)).toBeNull();

      const result = firstCallArg1<{
        cloudStorageConfig?: { maxDuration?: { seconds: string; nanos: number } };
      }>(callback);

      expect(result.cloudStorageConfig?.maxDuration).toEqual({ seconds: '300', nanos: 0 });
    });

    test('createTopic converts ingestionDataSourceSettings.cloudStorage.minimumObjectCreateTime from proto Timestamp to ISO in inbound', async () => {
      (topicService.createTopic as ReturnType<typeof mock>).mockResolvedValue(fakeTopic);

      const call = makeCall({
        name: 'projects/p/topics/t',
        ingestionDataSourceSettings: {
          cloudStorage: {
            bucket: 'my-bucket',
            minimumObjectCreateTime: { seconds: '1704067200', nanos: 0 },
          },
        },
      });
      const callback = makeCallback();

      await handlers.createTopic(call, callback as Parameters<typeof handlers.createTopic>[1]);

      expect(firstCallArg0(callback)).toBeNull();

      // Assert the service received the ISO string (inbound proto Timestamp → ISO conversion)
      expect(topicService.createTopic).toHaveBeenCalledWith(
        'p',
        't',
        expect.objectContaining({
          ingestionDataSourceSettings: {
            cloudStorage: expect.objectContaining({
              minimumObjectCreateTime: '2024-01-01T00:00:00.000Z',
            }),
          },
        })
      );
    });

    test('createTopic drops zero-value minimumObjectCreateTime (proto-loader default)', async () => {
      (topicService.createTopic as ReturnType<typeof mock>).mockResolvedValue(fakeTopic);

      const call = makeCall({
        name: 'projects/p/topics/t',
        ingestionDataSourceSettings: {
          cloudStorage: {
            bucket: 'my-bucket',
            // proto-loader fills unset Timestamp with { seconds: '0', nanos: 0 }
            minimumObjectCreateTime: { seconds: '0', nanos: 0 },
          },
        },
      });
      const callback = makeCallback();

      await handlers.createTopic(call, callback as Parameters<typeof handlers.createTopic>[1]);

      expect(firstCallArg0(callback)).toBeNull();

      expect(topicService.createTopic).toHaveBeenCalledWith(
        'p',
        't',
        expect.objectContaining({
          ingestionDataSourceSettings: {
            cloudStorage: expect.not.objectContaining({
              minimumObjectCreateTime: expect.anything(),
            }),
          },
        })
      );
    });

    test('getTopic converts ingestionDataSourceSettings.cloudStorage.minimumObjectCreateTime from ISO to proto Timestamp in response', async () => {
      (topicService.getTopic as ReturnType<typeof mock>).mockResolvedValue({
        ...fakeTopic,
        ingestionDataSourceSettings: {
          cloudStorage: {
            bucket: 'my-bucket',
            minimumObjectCreateTime: '2024-01-01T00:00:00.000Z',
          },
        },
      });

      const call = makeCall({ topic: 'projects/p/topics/t' });
      const callback = makeCallback();

      await handlers.getTopic(call, callback as Parameters<typeof handlers.getTopic>[1]);

      expect(firstCallArg0(callback)).toBeNull();

      const result = firstCallArg1<{
        ingestionDataSourceSettings?: {
          cloudStorage?: { minimumObjectCreateTime?: { seconds: string; nanos: number } };
        };
      }>(callback);

      expect(result.ingestionDataSourceSettings?.cloudStorage?.minimumObjectCreateTime).toEqual({
        seconds: '1704067200',
        nanos: 0,
      });
    });

    test('toServiceImplementation returns object with all 35 method keys', () => {
      const impl = handlers.toServiceImplementation();
      const expectedPublisher = [
        'CreateTopic',
        'UpdateTopic',
        'Publish',
        'GetTopic',
        'ListTopics',
        'ListTopicSubscriptions',
        'ListTopicSnapshots',
        'DeleteTopic',
        'DetachSubscription',
      ];
      const expectedSubscriber = [
        'CreateSubscription',
        'GetSubscription',
        'UpdateSubscription',
        'ListSubscriptions',
        'DeleteSubscription',
        'ModifyAckDeadline',
        'Acknowledge',
        'Pull',
        'StreamingPull',
        'ModifyPushConfig',
        'GetSnapshot',
        'ListSnapshots',
        'CreateSnapshot',
        'UpdateSnapshot',
        'DeleteSnapshot',
        'Seek',
      ];
      const expectedSchema = [
        'CreateSchema',
        'GetSchema',
        'ListSchemas',
        'ListSchemaRevisions',
        'CommitSchema',
        'RollbackSchema',
        'DeleteSchemaRevision',
        'DeleteSchema',
        'ValidateSchema',
        'ValidateMessage',
      ];

      for (const key of [...expectedPublisher, ...expectedSubscriber, ...expectedSchema]) {
        expect(impl).toHaveProperty(key);
      }
    });
  });
});
