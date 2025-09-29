/**
 * Topic Manager
 *
 * This module provides business logic for Pub/Sub topic management,
 * including validation, CRUD operations, and label support.
 */

import type { IStorageManager } from '@/core/storage/interfaces.js';
import { ValidationError } from '@/core/storage/types.js';
import type { Logger } from '@/shared/utils/logger.js';
import type { TopicRecord } from './models.js';
import { PubSubResourceNames } from './models.js';
import {
  TopicRepository,
  type CreateTopicData,
  type UpdateTopicData,
  type TopicQueryOptions,
} from './repositories/topic-repository.js';

/**
 * Topic creation request
 */
export interface CreateTopicRequest {
  /** Topic name in the format: projects/{project}/topics/{topic} */
  readonly name: string;
  /** Labels for the topic */
  readonly labels?: Record<string, string> | undefined;
  /** Message storage policy configuration */
  readonly messageStoragePolicy?: TopicRecord['messageStoragePolicy'] | undefined;
  /** KMS key name for encryption */
  readonly kmsKeyName?: string | undefined;
  /** Schema settings for message validation */
  readonly schemaSettings?: TopicRecord['schemaSettings'] | undefined;
  /** Whether the topic satisfies Pub/Sub zone separation */
  readonly satisfiesPzs?: boolean | undefined;
  /** Duration for retaining messages */
  readonly messageRetentionDuration?: string | undefined;
}

/**
 * Topic update request
 */
export interface UpdateTopicRequest {
  /** Labels for the topic */
  readonly labels?: Record<string, string> | undefined;
  /** Message storage policy configuration */
  readonly messageStoragePolicy?: TopicRecord['messageStoragePolicy'] | undefined;
  /** KMS key name for encryption */
  readonly kmsKeyName?: string | undefined;
  /** Schema settings for message validation */
  readonly schemaSettings?: TopicRecord['schemaSettings'] | undefined;
  /** Duration for retaining messages */
  readonly messageRetentionDuration?: string | undefined;
}

/**
 * Topic listing request
 */
export interface ListTopicsRequest {
  /** Project ID to list topics for */
  readonly projectId: string;
  /** Maximum number of topics to return */
  readonly pageSize?: number | undefined;
  /** Page token for pagination */
  readonly pageToken?: string | undefined;
  /** Filter expression */
  readonly filter?: string | undefined;
  /** Order by clause */
  readonly orderBy?: string | undefined;
}

/**
 * Topic listing response
 */
export interface ListTopicsResponse {
  /** List of topics */
  readonly topics: TopicRecord[];
  /** Next page token */
  readonly nextPageToken?: string | undefined;
  /** Total number of topics */
  readonly totalSize?: number | undefined;
}

/**
 * Topic Manager Implementation
 */
export class TopicManager {
  private readonly repository: TopicRepository;

  constructor(
    storage: IStorageManager,
    private readonly logger: Logger
  ) {
    this.repository = new TopicRepository(storage);
  }

  /**
   * Initialize the topic manager
   */
  async initialize(): Promise<void> {
    this.logger.info('Initializing Topic Manager');
    await this.repository.initialize();
    this.logger.info('Topic Manager initialized successfully');
  }

  /**
   * Create a new topic
   */
  async createTopic(request: CreateTopicRequest): Promise<TopicRecord> {
    this.logger.info(`Creating topic: ${request.name}`);

    // Validate request
    this.validateCreateTopicRequest(request);

    try {
      // Create topic data
      const topicData: CreateTopicData = {
        name: request.name,
        labels: this.validateAndCleanLabels(request.labels),
        messageStoragePolicy: request.messageStoragePolicy,
        kmsKeyName: request.kmsKeyName,
        schemaSettings: request.schemaSettings,
        satisfiesPzs: request.satisfiesPzs ?? false,
        messageRetentionDuration: this.validateMessageRetentionDuration(
          request.messageRetentionDuration
        ),
      };

      const topic = await this.repository.create(topicData);

      this.logger.info(`Topic created successfully: ${topic.name} (ID: ${topic.id})`);

      return topic;
    } catch (error) {
      this.logger.error(`Failed to create topic ${request.name}:`, error);
      throw error;
    }
  }

  /**
   * Get a topic by name
   */
  async getTopic(name: string): Promise<TopicRecord | null> {
    this.logger.debug(`Getting topic: ${name}`);

    // Validate topic name format
    this.validateTopicName(name);

    const topic = await this.repository.findByName(name);

    if (topic) {
      this.logger.debug(`Topic found: ${name} (ID: ${topic.id})`);
    } else {
      this.logger.debug(`Topic not found: ${name}`);
    }

    return topic;
  }

  /**
   * Update a topic
   */
  async updateTopic(name: string, request: UpdateTopicRequest): Promise<TopicRecord | null> {
    this.logger.info(`Updating topic: ${name}`);

    // Validate topic name format
    this.validateTopicName(name);

    // Validate update request
    this.validateUpdateTopicRequest(request);

    try {
      // Prepare update data
      const updateData: UpdateTopicData = {
        labels: request.labels ? this.validateAndCleanLabels(request.labels) : undefined,
        messageStoragePolicy: request.messageStoragePolicy,
        kmsKeyName: request.kmsKeyName,
        schemaSettings: request.schemaSettings,
        messageRetentionDuration: request.messageRetentionDuration
          ? this.validateMessageRetentionDuration(request.messageRetentionDuration)
          : undefined,
      };

      const topic = await this.repository.updateByName(name, updateData);

      if (topic) {
        this.logger.info(`Topic updated successfully: ${name} (ID: ${topic.id})`);
      } else {
        this.logger.warn(`Topic not found for update: ${name}`);
      }

      return topic;
    } catch (error) {
      this.logger.error(`Failed to update topic ${name}:`, error);
      throw error;
    }
  }

  /**
   * Delete a topic
   */
  async deleteTopic(name: string): Promise<boolean> {
    this.logger.info(`Deleting topic: ${name}`);

    // Validate topic name format
    this.validateTopicName(name);

    try {
      const deleted = await this.repository.deleteByName(name);

      if (deleted) {
        this.logger.info(`Topic deleted successfully: ${name}`);
      } else {
        this.logger.warn(`Topic not found for deletion: ${name}`);
      }

      return deleted;
    } catch (error) {
      this.logger.error(`Failed to delete topic ${name}:`, error);
      throw error;
    }
  }

  /**
   * List topics in a project
   */
  async listTopics(request: ListTopicsRequest): Promise<ListTopicsResponse> {
    this.logger.debug(`Listing topics for project: ${request.projectId}`);

    // Validate request
    this.validateListTopicsRequest(request);

    try {
      const queryOptions: TopicQueryOptions = {
        projectId: request.projectId,
        limit: request.pageSize ?? 50,
        offset: this.parsePageToken(request.pageToken) ?? 0,
        orderBy: request.orderBy ? [{ field: request.orderBy, direction: 'asc' }] : undefined,
      };

      // Apply filter if provided
      if (request.filter) {
        // Basic filter parsing - in a real implementation, this would be more sophisticated
        this.applyFilter(queryOptions, request.filter);
      }

      const result = await this.repository.find(queryOptions);

      // Generate next page token if there are more results
      let nextPageToken: string | undefined;

      if (result.hasMore) {
        const nextOffset = (queryOptions.offset || 0) + result.data.length;

        nextPageToken = this.generatePageToken(nextOffset);
      }

      const response: ListTopicsResponse = {
        topics: result.data,
        nextPageToken,
        totalSize: result.total,
      };

      this.logger.debug(`Found ${result.data.length} topics for project ${request.projectId}`);

      return response;
    } catch (error) {
      this.logger.error(`Failed to list topics for project ${request.projectId}:`, error);
      throw error;
    }
  }

  /**
   * Check if a topic exists
   */
  async topicExists(name: string): Promise<boolean> {
    this.validateTopicName(name);

    return this.repository.existsByName(name);
  }

  /**
   * Get topic count for a project
   */
  async getTopicCount(projectId: string): Promise<number> {
    return this.repository.countByProject(projectId);
  }

  /**
   * Validate create topic request
   */
  private validateCreateTopicRequest(request: CreateTopicRequest): void {
    if (!request.name) {
      throw new ValidationError('Topic name is required');
    }

    this.validateTopicName(request.name);

    if (request.labels) {
      this.validateLabels(request.labels);
    }

    if (request.messageRetentionDuration !== undefined) {
      this.validateMessageRetentionDuration(request.messageRetentionDuration);
    }
  }

  /**
   * Validate update topic request
   */
  private validateUpdateTopicRequest(request: UpdateTopicRequest): void {
    if (request.labels) {
      this.validateLabels(request.labels);
    }

    if (request.messageRetentionDuration !== undefined) {
      this.validateMessageRetentionDuration(request.messageRetentionDuration);
    }
  }

  /**
   * Validate list topics request
   */
  private validateListTopicsRequest(request: ListTopicsRequest): void {
    if (!request.projectId) {
      throw new ValidationError('Project ID is required');
    }

    if (request.pageSize && (request.pageSize < 1 || request.pageSize > 1000)) {
      throw new ValidationError('Page size must be between 1 and 1000');
    }
  }

  /**
   * Validate topic name format
   */
  private validateTopicName(name: string): void {
    try {
      PubSubResourceNames.parseTopic(name);
    } catch {
      throw new ValidationError(
        `Invalid topic name: ${name}. Expected format: projects/{project}/topics/{topic}`
      );
    }
  }

  /**
   * Validate labels
   */
  private validateLabels(labels: Record<string, string>): void {
    const labelCount = Object.keys(labels).length;

    if (labelCount > 64) {
      throw new ValidationError(`Too many labels: ${labelCount}. Maximum allowed: 64`);
    }

    for (const [key, value] of Object.entries(labels)) {
      if (!key || key.length > 63) {
        throw new ValidationError(`Invalid label key: ${key}. Must be 1-63 characters`);
      }

      if (value.length > 63) {
        throw new ValidationError(
          `Invalid label value for key ${key}: ${value}. Must be 0-63 characters`
        );
      }

      // Basic validation for GCP label format
      if (!/^[a-z0-9_-]+$/i.test(key)) {
        throw new ValidationError(
          `Invalid label key format: ${key}. Must contain only letters, numbers, underscores, and hyphens`
        );
      }
    }
  }

  /**
   * Validate and clean labels
   */
  private validateAndCleanLabels(labels?: Record<string, string>): Record<string, string> {
    if (!labels) {
      return {};
    }

    this.validateLabels(labels);

    return { ...labels }; // Return a clean copy
  }

  /**
   * Validate message retention duration
   */
  private validateMessageRetentionDuration(duration?: string): string | undefined {
    if (duration === undefined || duration === null) {
      return undefined;
    }

    // Empty string should be rejected
    if (duration === '') {
      throw new ValidationError(
        `Invalid message retention duration format: "${duration}". Expected format: {number}{unit} (e.g., "600s", "10m", "1h")`
      );
    }

    // Basic duration format validation (e.g., "600s", "10m", "1h")
    if (!/^\d+[smhd]$/.test(duration)) {
      throw new ValidationError(
        `Invalid message retention duration format: ${duration}. Expected format: {number}{unit} (e.g., "600s", "10m", "1h")`
      );
    }

    return duration;
  }

  /**
   * Apply filter to query options
   */
  private applyFilter(options: TopicQueryOptions, filter: string): void {
    // Basic filter parsing - in a real implementation, this would parse
    // complex filter expressions according to GCP filtering syntax
    // For now, we'll just handle simple cases

    if (filter.includes('labels.')) {
      // Handle label filtering
      this.logger.debug(`Filter by labels not fully implemented: ${filter}`);
    }
  }

  /**
   * Parse page token to get offset
   */
  private parsePageToken(token?: string): number | undefined {
    if (!token) {
      return undefined;
    }

    try {
      // Simple base64 encoding of offset
      const decoded = Buffer.from(token, 'base64').toString();
      const offset = parseInt(decoded, 10);

      return isNaN(offset) ? 0 : offset;
    } catch {
      return 0;
    }
  }

  /**
   * Generate page token from offset
   */
  private generatePageToken(offset: number): string {
    return Buffer.from(offset.toString()).toString('base64');
  }
}
