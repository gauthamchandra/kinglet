/**
 * Job Repository - persistence layer wrapping StorageManager
 */

import type { StorageManager } from '@/core/storage/manager.ts';
import type { BaseRecord } from '@/core/storage/types.ts';
import { schedulerJobsTableSchema, SCHEDULER_JOBS_TABLE } from './types.ts';
import type { JobRecord } from './types.ts';

export interface ListJobsResult {
  jobs: JobRecord[];
  nextPageToken?: string | undefined;
}

export class JobRepository {
  private storage: StorageManager;

  constructor(storage: StorageManager) {
    this.storage = storage;
  }

  async initialize(): Promise<void> {
    await this.storage.createTable(SCHEDULER_JOBS_TABLE, schedulerJobsTableSchema);
  }

  // Note: unique index on 'name' column provides database-level protection against races
  async createJob(data: Omit<JobRecord, keyof BaseRecord>): Promise<JobRecord> {
    const existing = await this.getJobByName(data.name);

    if (existing) {
      throw new Error(`Job ${data.name} already exists`);
    }

    return this.storage.create<JobRecord>(SCHEDULER_JOBS_TABLE, data);
  }

  async getJobByName(name: string): Promise<JobRecord | null> {
    return this.storage.findFirst<JobRecord>(SCHEDULER_JOBS_TABLE, {
      filter: {
        conditions: [{ field: 'name', operator: 'eq', value: name }],
      },
    });
  }

  async listJobs(
    project: string,
    location: string,
    pageSize?: number,
    pageToken?: string
  ): Promise<ListJobsResult> {
    const prefix = `projects/${project}/locations/${location}/jobs/`;

    const offset = pageToken ? parseInt(pageToken, 10) : 0;
    const limit = pageSize ?? 100;

    const result = await this.storage.find<JobRecord>(SCHEDULER_JOBS_TABLE, {
      filter: {
        conditions: [{ field: 'name', operator: 'like', value: `${prefix}%` }],
      },
      pagination: { limit, offset },
      sort: [{ field: 'name', direction: 'asc' }],
    });

    const hasMore = result.hasMore;
    const nextPageToken = hasMore ? String(offset + limit) : undefined;

    return {
      jobs: result.data,
      nextPageToken,
    };
  }

  async updateJob(
    name: string,
    data: Partial<Omit<JobRecord, keyof BaseRecord>>
  ): Promise<JobRecord | null> {
    const existing = await this.getJobByName(name);

    if (!existing) {
      return null;
    }

    return this.storage.updateById<JobRecord>(SCHEDULER_JOBS_TABLE, existing.id, data);
  }

  async deleteJob(name: string): Promise<boolean> {
    const existing = await this.getJobByName(name);

    if (!existing) {
      return false;
    }

    return this.storage.deleteById(SCHEDULER_JOBS_TABLE, existing.id);
  }

  async findDueJobs(date: Date): Promise<JobRecord[]> {
    const dateIso = date.toISOString();

    const result = await this.storage.find<JobRecord>(SCHEDULER_JOBS_TABLE, {
      filter: {
        conditions: [
          { field: 'state', operator: 'eq', value: 'ENABLED' },
          { field: 'scheduleTime', operator: 'lte', value: dateIso },
          { field: 'scheduleTime', operator: 'ne', value: null },
        ],
        operator: 'and',
      },
    });

    return result.data;
  }
}
