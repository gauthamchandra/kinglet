/**
 * Shared persistence for AlloyDB's name-addressed resources.
 *
 * <p>Clusters, instances and users are stored identically — a `name`-unique table
 * queried by exact name or by hierarchical prefix — and differ only in table,
 * schema, and how their parent prefix is built. Subclasses supply those three
 * things and add a typed `list*`; everything else lives here so the duplicate
 * guard and pagination semantics are implemented and tested once.
 *
 * <p>Methods are named generically (`create`, not `createCluster`) because the
 * subclass type already names the resource. No business rules belong in here.
 */

import type { StorageManager } from '@/core/storage/manager.ts';
import type { BaseRecord, TableSchema } from '@/core/storage/types.ts';
import { DEFAULT_LIST_PAGE_SIZE, parseOffsetToken } from '@/shared/utils/pagination.ts';

export interface NamedRecord extends BaseRecord {
  name: string;
}

export interface ListByPrefixResult<T> {
  records: T[];
  nextPageToken?: string | undefined;
}

export abstract class ResourceRepository<T extends NamedRecord> {
  protected readonly storage: StorageManager;
  private readonly tableName: string;
  private readonly tableSchema: TableSchema;
  private readonly resourceLabel: string;

  protected constructor(
    storage: StorageManager,
    tableName: string,
    tableSchema: TableSchema,
    resourceLabel: string
  ) {
    this.storage = storage;
    this.tableName = tableName;
    this.tableSchema = tableSchema;
    this.resourceLabel = resourceLabel;
  }

  async initialize(): Promise<void> {
    const existingTables = await this.storage.listTables();

    if (existingTables.includes(this.tableName)) return;

    await this.storage.createTable(this.tableName, this.tableSchema);
  }

  /**
   * <p><b>NOTE:</b> the uniqueness check is not redundant with the table's unique
   * index. The in-memory storage provider does not enforce unique indexes, so
   * without this a duplicate would insert cleanly in memory mode and only fail
   * under SQLite — the inverse of the bug you want in a dev tool.
   */
  async create(data: Omit<T, keyof BaseRecord>): Promise<T> {
    const existing = await this.getByName(data.name);

    if (existing) {
      throw new Error(`An AlloyDB ${this.resourceLabel} named "${data.name}" already exists`);
    }

    return this.storage.create<T>(this.tableName, data);
  }

  async getByName(name: string): Promise<T | null> {
    return this.storage.findFirst<T>(this.tableName, {
      filter: {
        conditions: [{ field: 'name', operator: 'eq', value: name }],
      },
    });
  }

  async update(name: string, data: Partial<Omit<T, keyof BaseRecord>>): Promise<T | null> {
    const existing = await this.getByName(name);

    if (!existing) return null;

    return this.storage.updateById<T>(this.tableName, existing.id, data);
  }

  async delete(name: string): Promise<boolean> {
    const existing = await this.getByName(name);

    if (!existing) return false;

    return this.storage.deleteById(this.tableName, existing.id);
  }

  /**
   * Page through the resources directly beneath `prefix`, sorted by name.
   *
   * <p>`prefix` must include its trailing separator, or ids where one is a prefix
   * of another (`c1` and `c10`) would bleed into each other's listings.
   */
  protected async listByPrefix(
    prefix: string,
    pageSize?: number,
    pageToken?: string
  ): Promise<ListByPrefixResult<T>> {
    const offset = parseOffsetToken(pageToken);
    const limit = pageSize ?? DEFAULT_LIST_PAGE_SIZE;

    const result = await this.storage.find<T>(this.tableName, {
      filter: {
        conditions: [{ field: 'name', operator: 'like', value: `${prefix}%` }],
      },
      pagination: { limit, offset },
      sort: [{ field: 'name', direction: 'asc' }],
    });

    return {
      records: result.data,
      nextPageToken: result.hasMore ? String(offset + limit) : undefined,
    };
  }

  /** How many resources exist beneath `prefix`. Used to enforce cascade rules. */
  async countByPrefix(prefix: string): Promise<number> {
    return this.storage.count(this.tableName, {
      conditions: [{ field: 'name', operator: 'like', value: `${prefix}%` }],
    });
  }

  /** Remove every resource beneath `prefix`, returning how many were deleted. */
  async deleteByPrefix(prefix: string): Promise<number> {
    return this.storage.deleteMany(this.tableName, {
      conditions: [{ field: 'name', operator: 'like', value: `${prefix}%` }],
    });
  }
}
