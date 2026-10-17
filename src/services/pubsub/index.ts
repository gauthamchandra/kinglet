/**
 * Cloud Pub/Sub service - entry point
 *
 * Wires together repositories, services, handlers, and engines.
 */

import path from 'node:path';
import { getProtoPath } from 'google-proto-files';
import type { GrpcServiceDefinition } from '@/core/gateway/grpc-server.ts';
import type { RouteDefinition } from '@/core/gateway/request-router.ts';
import type { StorageManager } from '@/core/storage/manager.ts';
import type { Logger } from '@/shared/utils/logger.ts';
import { DeliveryEngine } from './delivery-engine.ts';
import { MessageRepository } from './message-repository.ts';
import { PubSubGrpcHandlers } from './pubsub-grpc-handlers.ts';
import { SchemaHandlers } from './schema-handlers.ts';
import { SchemaRepository } from './schema-repository.ts';
import { SchemaService } from './schema-service.ts';
import { SnapshotHandlers } from './snapshot-handlers.ts';
import { SnapshotRepository } from './snapshot-repository.ts';
import { SnapshotService } from './snapshot-service.ts';
import { SubscriptionHandlers } from './subscription-handlers.ts';
import { SubscriptionRepository } from './subscription-repository.ts';
import { SubscriptionService } from './subscription-service.ts';
import { TopicHandlers } from './topic-handlers.ts';
import { TopicRepository } from './topic-repository.ts';
import { TopicService } from './topic-service.ts';

export class PubSubService {
  private storage: StorageManager;
  private logger: Logger;

  private topicRepository!: TopicRepository;
  private subscriptionRepository!: SubscriptionRepository;
  private messageRepository!: MessageRepository;
  private snapshotRepository!: SnapshotRepository;
  private schemaRepository!: SchemaRepository;

  private topicService!: TopicService;
  private subscriptionService!: SubscriptionService;
  private snapshotService!: SnapshotService;
  private schemaService!: SchemaService;

  private topicHandlers!: TopicHandlers;
  private subscriptionHandlers!: SubscriptionHandlers;
  private snapshotHandlers!: SnapshotHandlers;
  private schemaHandlers!: SchemaHandlers;

  private deliveryEngine!: DeliveryEngine;
  private grpcHandlers: PubSubGrpcHandlers | null = null;

  constructor(storage: StorageManager, logger: Logger) {
    this.storage = storage;
    this.logger = logger;
  }

  async initialize(): Promise<void> {
    // Repositories
    this.topicRepository = new TopicRepository(this.storage);
    await this.topicRepository.initialize();

    this.subscriptionRepository = new SubscriptionRepository(this.storage);
    await this.subscriptionRepository.initialize();

    this.messageRepository = new MessageRepository(this.storage);
    await this.messageRepository.initialize();

    this.snapshotRepository = new SnapshotRepository(this.storage);
    await this.snapshotRepository.initialize();

    this.schemaRepository = new SchemaRepository(this.storage);
    await this.schemaRepository.initialize();

    // Services
    this.topicService = new TopicService(this.topicRepository, this.messageRepository);
    this.subscriptionService = new SubscriptionService(
      this.subscriptionRepository,
      this.topicRepository,
      this.messageRepository,
      this.snapshotRepository
    );
    this.snapshotService = new SnapshotService(
      this.snapshotRepository,
      this.subscriptionRepository,
      this.topicRepository
    );
    this.schemaService = new SchemaService(this.schemaRepository);

    // Handlers
    this.topicHandlers = new TopicHandlers(this.topicService, this.logger);
    this.subscriptionHandlers = new SubscriptionHandlers(this.subscriptionService, this.logger);
    this.snapshotHandlers = new SnapshotHandlers(this.snapshotService, this.logger);
    this.schemaHandlers = new SchemaHandlers(this.schemaService, this.logger);

    // Delivery engine for push subscriptions
    this.deliveryEngine = new DeliveryEngine(
      this.subscriptionRepository,
      this.messageRepository,
      this.logger,
      {
        publishFn: async (topicName, messages) => {
          const activeSubs =
            await this.subscriptionRepository.findActiveSubscriptionsForTopic(topicName);

          const subNames = activeSubs.map(s => s.name);

          await this.messageRepository.publishMessages(topicName, messages, subNames);
        },
      }
    );

    this.logger.info('Pub/Sub service initialized');
  }

  getRoutes(): RouteDefinition[] {
    return [
      ...this.topicHandlers.getRoutes(),
      ...this.subscriptionHandlers.getRoutes(),
      ...this.snapshotHandlers.getRoutes(),
      ...this.schemaHandlers.getRoutes(),
    ];
  }

  getGrpcServices(): GrpcServiceDefinition[] {
    if (
      !this.topicService ||
      !this.subscriptionService ||
      !this.snapshotService ||
      !this.schemaService
    ) {
      throw new Error('PubSubService not initialized. Call initialize() first.');
    }

    if (!this.grpcHandlers) {
      this.grpcHandlers = new PubSubGrpcHandlers(
        this.topicService,
        this.subscriptionService,
        this.snapshotService,
        this.schemaService
      );
    }

    const handlers = this.grpcHandlers;
    const pubsubProtoPath = getProtoPath('pubsub/v1/pubsub.proto');
    const schemaProtoPath = getProtoPath('pubsub/v1/schema.proto');

    // google-proto-files stores all Google API protos under its package root.
    // proto-loader needs that root on the include path so relative imports inside
    // pubsub.proto (e.g. "google/api/annotations.proto") resolve correctly.
    // pubsubProtoPath is under .../google-proto-files/google/pubsub/v1/
    // so we go up 3 levels to reach the package root (parent of `google/`).
    const protoRoot = path.resolve(path.dirname(pubsubProtoPath), '../../..');
    const impl = handlers.toServiceImplementation();

    return [
      {
        name: 'Publisher',
        protoPath: pubsubProtoPath,
        packageName: 'google.pubsub.v1',
        serviceName: 'Publisher',
        implementation: impl,
        includeDirs: [protoRoot],
      },
      {
        name: 'Subscriber',
        protoPath: pubsubProtoPath,
        packageName: 'google.pubsub.v1',
        serviceName: 'Subscriber',
        implementation: impl,
        includeDirs: [protoRoot],
      },
      {
        name: 'SchemaService',
        protoPath: schemaProtoPath,
        packageName: 'google.pubsub.v1',
        serviceName: 'SchemaService',
        implementation: impl,
        includeDirs: [protoRoot],
      },
    ];
  }

  start(): void {
    this.deliveryEngine.start();
  }

  async stop(): Promise<void> {
    this.grpcHandlers?.stopActiveStreams();
    await this.deliveryEngine.stop();
  }
}
