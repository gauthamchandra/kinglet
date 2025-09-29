/**
 * Topic Repository
 *
 * This module provides data access operations for Pub/Sub topics,
 * implementing the repository pattern for topic management.
 */

import { randomUUID } from 'node:crypto';
import type { IRepository, IStorageManager } from '@/core/storage/interfaces.js';
import type {
  QueryCondition,
  QueryOptions,
  QueryResult,
  QueryFilter,
} from '@/core/storage/types.js';
import { ValidationError } from '@/core/storage/types.js';
import type { TopicRecord } from '../models.js';
import { PubSubResourceNames, TOPICS_SCHEMA } from '../models.js';

/**
 * Topic creation data (without BaseRecord fields)
 */
export interface CreateTopicData {
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
 * Topic update data (partial fields for updates)
 */
export interface UpdateTopicData {
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
 * Topic query filters
 */
export interface TopicQueryOptions extends QueryOptions {
  /** Filter by project ID */
  readonly projectId?: string | undefined;
  /** Filter by topic ID */
  readonly topicId?: string | undefined;
  /** Filter by labels */
  readonly labels?: Record<string, string> | undefined;
  /** Limit the number of results (convenience property) */
  readonly limit?: number | undefined;
  /** Offset for pagination (convenience property) */
  readonly offset?: number | undefined;
  /** Where conditions (convenience property for filter) */
  readonly where?: QueryCondition[] | undefined;
  /** Order by field and direction */
  readonly orderBy?: Array<{ field: string; direction: 'asc' | 'desc' }> | undefined;
}

/**
 * Topic Repository Implementation
 */
export class TopicRepository implements IRepository<TopicRecord> {
  private readonly tableName = TOPICS_SCHEMA.name;

  constructor(private readonly storage: IStorageManager) {}

  /**
   * Initialize the repository by creating tables if needed
   */
  async initialize(): Promise<void> {
    await this.storage.createTable(this.tableName, TOPICS_SCHEMA);
  }

  /**
   * Create a new topic
   */
  async create(data: CreateTopicData): Promise<TopicRecord> {
    // Validate topic name format
    this.validateTopicName(data.name);

    // Parse topic name to extract project and topic IDs
    const { projectId, topicId } = PubSubResourceNames.parseTopic(data.name);

    // Check if topic already exists
    const existingTopic = await this.findByName(data.name);

    if (existingTopic) {
      throw new ValidationError(`Topic already exists: ${data.name}`);
    }

    const now = new Date();
    const topic: TopicRecord = {
      id: randomUUID(),
      createdAt: now,
      updatedAt: now,
      name: data.name,
      labels: data.labels ?? {},
      messageStoragePolicy: data.messageStoragePolicy,
      kmsKeyName: data.kmsKeyName,
      schemaSettings: data.schemaSettings,
      satisfiesPzs: data.satisfiesPzs ?? false,
      messageRetentionDuration: data.messageRetentionDuration,
      projectId,
      topicId,
    };

    // Prepare data for storage (convert complex objects to JSON strings)
    const storageData = this.prepareForStorage(topic);

    await this.storage.create(this.tableName, storageData);

    return topic;
  }

  /**
   * Find a topic by ID
   */
  async findById(id: string): Promise<TopicRecord | null> {
    const result = await this.storage.findById(this.tableName, id);

    return result ? this.convertFromStorage(result) : null;
  }

  /**
   * Find a topic by name
   */
  async findByName(name: string): Promise<TopicRecord | null> {
    const result = await this.storage.findFirst(this.tableName, {
      filter: {
        conditions: [{ field: 'name', operator: 'eq', value: name }],
        operator: 'and',
      },
    });

    return result ? this.convertFromStorage(result) : null;
  }

  /**
   * Find topics matching criteria
   */
  async find(options: TopicQueryOptions = {}): Promise<QueryResult<TopicRecord>> {
    const conditions = this.buildWhereClause(options);
    const queryOptions: QueryOptions = {
      ...options,
      filter:
        conditions.length > 0
          ? {
              conditions,
              operator: 'and',
            }
          : undefined,
    };

    const result = await this.storage.find(this.tableName, queryOptions);

    return {
      data: result.data.map(item => this.convertFromStorage(item)),
      total: result.total,
      hasMore: result.hasMore,
    };
  }

  /**
   * Find topics in a specific project
   */
  async findByProject(
    projectId: string,
    options: QueryOptions = {}
  ): Promise<QueryResult<TopicRecord>> {
    return this.find({ ...options, projectId });
  }

  /**
   * Find first topic matching criteria
   */
  async findFirst(options: TopicQueryOptions = {}): Promise<TopicRecord | null> {
    const result = await this.find({ ...options, limit: 1 });

    return result.data[0] || null;
  }

  /**
   * Update a topic by ID
   */
  async updateById(id: string, data: UpdateTopicData): Promise<TopicRecord | null> {
    const existingTopic = await this.findById(id);

    if (!existingTopic) {
      return null;
    }

    const updatedTopic: TopicRecord = {
      ...existingTopic,
      ...(data.labels !== undefined && { labels: data.labels }),
      ...(data.messageStoragePolicy !== undefined && {
        messageStoragePolicy: data.messageStoragePolicy,
      }),
      ...(data.kmsKeyName !== undefined && { kmsKeyName: data.kmsKeyName }),
      ...(data.schemaSettings !== undefined && { schemaSettings: data.schemaSettings }),
      ...(data.messageRetentionDuration !== undefined && {
        messageRetentionDuration: data.messageRetentionDuration,
      }),
      updatedAt: new Date(),
    };

    // Prepare data for storage
    const storageData = this.prepareForStorage(updatedTopic);

    await this.storage.updateById(this.tableName, id, storageData);

    return updatedTopic;
  }

  /**
   * Update a topic by name
   */
  async updateByName(name: string, data: UpdateTopicData): Promise<TopicRecord | null> {
    const topic = await this.findByName(name);

    if (!topic) {
      return null;
    }

    return this.updateById(topic.id, data);
  }

  /**
   * Delete a topic by ID
   */
  async deleteById(id: string): Promise<boolean> {
    return this.storage.deleteById(this.tableName, id);
  }

  /**
   * Delete a topic by name
   */
  async deleteByName(name: string): Promise<boolean> {
    const topic = await this.findByName(name);

    if (!topic) {
      return false;
    }

    return this.deleteById(topic.id);
  }

  /**
   * Check if a topic exists by ID
   */
  async exists(id: string): Promise<boolean> {
    return this.storage.exists(this.tableName, id);
  }

  /**
   * Check if a topic exists by name
   */
  async existsByName(name: string): Promise<boolean> {
    const topic = await this.findByName(name);

    return topic !== null;
  }

  /**
   * Count topics matching criteria
   */
  async count(options: TopicQueryOptions = {}): Promise<number> {
    const conditions = this.buildWhereClause(options);
    const queryFilter: QueryFilter | undefined =
      conditions.length > 0
        ? {
            conditions,
            operator: 'and',
          }
        : undefined;

    return this.storage.count(this.tableName, queryFilter);
  }

  /**
   * Count topics in a specific project
   */
  async countByProject(projectId: string): Promise<number> {
    return this.count({ projectId });
  }

  /**
   * List all topic names in a project
   */
  async listTopicNames(projectId: string, options: QueryOptions = {}): Promise<string[]> {
    const result = await this.find({ ...options, projectId });

    return result.data.map(topic => topic.name);
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
   * Build WHERE clause from query options
   */
  private buildWhereClause(options: TopicQueryOptions): QueryCondition[] {
    const conditions = (options.where as QueryCondition[]) || [];

    if (options.projectId) {
      conditions.push({ field: 'projectId', operator: 'eq', value: options.projectId });
    }

    if (options.topicId) {
      conditions.push({ field: 'topicId', operator: 'eq', value: options.topicId });
    }

    // Label filtering is complex and would require JSON queries
    // For now, we'll handle it in the application layer if needed
    if (options.labels) {
      // This would require more sophisticated JSON querying
      // For SQLite, we might need to implement custom filtering
    }

    return conditions;
  }

  /**
   * Prepare topic record for storage (convert objects to JSON strings)
   */
  private prepareForStorage(topic: TopicRecord): Record<string, unknown> {
    return {
      ...topic,
      labels: JSON.stringify(topic.labels),
      messageStoragePolicy: topic.messageStoragePolicy
        ? JSON.stringify(topic.messageStoragePolicy)
        : null,
      schemaSettings: topic.schemaSettings ? JSON.stringify(topic.schemaSettings) : null,
      satisfiesPzs: topic.satisfiesPzs ? 1 : 0,
      createdAt: topic.createdAt.toISOString(),
      updatedAt: topic.updatedAt.toISOString(),
    };
  }

  /**
   * Convert storage record back to TopicRecord (parse JSON strings)
   */
  private convertFromStorage(record: Record<string, unknown>): TopicRecord {
    return {
      id: record.id as string,
      createdAt: new Date(record.createdAt as string),
      updatedAt: new Date(record.updatedAt as string),
      name: record.name as string,
      labels: JSON.parse((record.labels as string) || '{}'),
      messageStoragePolicy: record.messageStoragePolicy
        ? JSON.parse(record.messageStoragePolicy as string)
        : undefined,
      kmsKeyName: record.kmsKeyName as string | undefined,
      schemaSettings: record.schemaSettings
        ? JSON.parse(record.schemaSettings as string)
        : undefined,
      satisfiesPzs: Boolean(record.satisfiesPzs),
      messageRetentionDuration: record.messageRetentionDuration as string | undefined,
      projectId: record.projectId as string,
      topicId: record.topicId as string,
    };
  }
}
