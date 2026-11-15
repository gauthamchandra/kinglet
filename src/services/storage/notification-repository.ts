/**
 * Notification Repository - persistence for bucket notification configs
 */

import type { StorageManager } from '@/core/storage/manager.ts';
import type { BaseRecord } from '@/core/storage/types.ts';
import type { NotificationRecord } from './types.ts';
import { NOTIFICATIONS_TABLE, notificationsTableSchema } from './types.ts';

export class NotificationRepository {
  private storage: StorageManager;

  constructor(storage: StorageManager) {
    this.storage = storage;
  }

  async initialize(): Promise<void> {
    await this.storage.createTable(NOTIFICATIONS_TABLE, notificationsTableSchema);
  }

  async create(
    data: Omit<NotificationRecord, keyof BaseRecord | 'ordinal'>
  ): Promise<NotificationRecord> {
    const ordinal = await this.nextOrdinal();

    return this.storage.create<NotificationRecord>(NOTIFICATIONS_TABLE, { ...data, ordinal });
  }

  async get(bucket: string, id: string): Promise<NotificationRecord | null> {
    return this.storage.findFirst<NotificationRecord>(NOTIFICATIONS_TABLE, {
      filter: {
        conditions: [
          { field: 'bucket', operator: 'eq', value: bucket },
          { field: 'id', operator: 'eq', value: id },
        ],
      },
    });
  }

  async listByBucket(bucket: string): Promise<NotificationRecord[]> {
    const result = await this.storage.find<NotificationRecord>(NOTIFICATIONS_TABLE, {
      filter: {
        conditions: [{ field: 'bucket', operator: 'eq', value: bucket }],
      },
      sort: [{ field: 'ordinal', direction: 'asc' }],
    });

    return result.data;
  }

  async delete(bucket: string, id: string): Promise<boolean> {
    const existing = await this.get(bucket, id);

    if (!existing) {
      return false;
    }

    return this.storage.deleteById(NOTIFICATIONS_TABLE, existing.id);
  }

  private async nextOrdinal(): Promise<number> {
    const result = await this.storage.find<NotificationRecord>(NOTIFICATIONS_TABLE, {
      sort: [{ field: 'ordinal', direction: 'desc' }],
      pagination: { limit: 1 },
    });

    const latest = result.data[0];

    if (!latest) {
      return 1;
    }

    return latest.ordinal + 1;
  }
}
