/**
 * ACL Policy Repository - persistence layer for Memorystore ACL policies and revisions
 */

import type { StorageManager } from '@/core/storage/manager.ts';
import type { BaseRecord } from '@/core/storage/types.ts';
import { DEFAULT_LIST_PAGE_SIZE, parseOffsetToken } from '@/shared/utils/pagination.ts';
import type { AclPolicyRecord, AclPolicyRevisionRecord } from './types.ts';
import {
  aclPolicyRevisionTableSchema,
  aclPolicyTableSchema,
  MEMORYSTORE_ACL_POLICIES_TABLE,
  MEMORYSTORE_ACL_POLICY_REVISIONS_TABLE,
} from './types.ts';

export interface ListAclPoliciesResult {
  aclPolicies: AclPolicyRecord[];
  nextPageToken?: string;
}

export interface ListAclPolicyRevisionsResult {
  revisions: AclPolicyRevisionRecord[];
  nextPageToken?: string;
}

export class AclPolicyRepository {
  private storage: StorageManager;

  constructor(storage: StorageManager) {
    this.storage = storage;
  }

  async initialize(): Promise<void> {
    const existingTables = await this.storage.listTables();

    if (!existingTables.includes(MEMORYSTORE_ACL_POLICIES_TABLE)) {
      await this.storage.createTable(MEMORYSTORE_ACL_POLICIES_TABLE, aclPolicyTableSchema);
    }

    if (!existingTables.includes(MEMORYSTORE_ACL_POLICY_REVISIONS_TABLE)) {
      await this.storage.createTable(
        MEMORYSTORE_ACL_POLICY_REVISIONS_TABLE,
        aclPolicyRevisionTableSchema
      );
    }
  }

  async createAclPolicy(data: Omit<AclPolicyRecord, keyof BaseRecord>): Promise<AclPolicyRecord> {
    const existing = await this.getAclPolicyByName(data.name);

    if (existing) {
      throw new Error(`An ACL policy named "${data.name}" already exists`);
    }

    return this.storage.create<AclPolicyRecord>(MEMORYSTORE_ACL_POLICIES_TABLE, data);
  }

  async getAclPolicyByName(name: string): Promise<AclPolicyRecord | null> {
    return this.storage.findFirst<AclPolicyRecord>(MEMORYSTORE_ACL_POLICIES_TABLE, {
      filter: {
        conditions: [{ field: 'name', operator: 'eq', value: name }],
      },
    });
  }

  async listAclPolicies(
    project: string,
    location: string,
    pageSize?: number,
    pageToken?: string
  ): Promise<ListAclPoliciesResult> {
    const offset = parseOffsetToken(pageToken);
    const limit = pageSize ?? DEFAULT_LIST_PAGE_SIZE;
    const prefix = `projects/${project}/locations/${location}/aclPolicies/`;

    const result = await this.storage.find<AclPolicyRecord>(MEMORYSTORE_ACL_POLICIES_TABLE, {
      filter: {
        conditions: [{ field: 'name', operator: 'like', value: `${prefix}%` }],
      },
      pagination: { limit, offset },
      sort: [{ field: 'name', direction: 'asc' }],
    });

    const listResult: ListAclPoliciesResult = { aclPolicies: result.data };

    if (result.hasMore) {
      listResult.nextPageToken = String(offset + limit);
    }

    return listResult;
  }

  async updateAclPolicy(
    name: string,
    data: Partial<Omit<AclPolicyRecord, keyof BaseRecord>>
  ): Promise<AclPolicyRecord | null> {
    const existing = await this.getAclPolicyByName(name);

    if (!existing) return null;

    return this.storage.updateById<AclPolicyRecord>(
      MEMORYSTORE_ACL_POLICIES_TABLE,
      existing.id,
      data
    );
  }

  async deleteAclPolicy(name: string): Promise<boolean> {
    const existing = await this.getAclPolicyByName(name);

    if (!existing) return false;

    // Revisions are owned by the policy. Orphaning them would resurrect a
    // deleted policy's rules under a newly-created policy of the same name.
    await this.deleteRevisionsForPolicy(name);

    return this.storage.deleteById(MEMORYSTORE_ACL_POLICIES_TABLE, existing.id);
  }

  async deleteRevisionsForPolicy(policyName: string): Promise<number> {
    return this.storage.deleteMany(MEMORYSTORE_ACL_POLICY_REVISIONS_TABLE, {
      conditions: [{ field: 'policyName', operator: 'eq', value: policyName }],
    });
  }

  /**
   * Count every revision of a policy, ignoring page limits.
   *
   * <p>Revision numbers are derived from this count, so deriving it from a
   * paged {@link listRevisions} call would saturate at the default page size
   * and start minting duplicate revision numbers once a policy exceeded it.
   */
  async countRevisionsForPolicy(policyName: string): Promise<number> {
    return this.storage.count(MEMORYSTORE_ACL_POLICY_REVISIONS_TABLE, {
      conditions: [{ field: 'policyName', operator: 'eq', value: policyName }],
    });
  }

  async createRevision(
    data: Omit<AclPolicyRevisionRecord, keyof BaseRecord>
  ): Promise<AclPolicyRevisionRecord> {
    return this.storage.create<AclPolicyRevisionRecord>(
      MEMORYSTORE_ACL_POLICY_REVISIONS_TABLE,
      data
    );
  }

  async getRevisionByName(name: string): Promise<AclPolicyRevisionRecord | null> {
    return this.storage.findFirst<AclPolicyRevisionRecord>(MEMORYSTORE_ACL_POLICY_REVISIONS_TABLE, {
      filter: { conditions: [{ field: 'name', operator: 'eq', value: name }] },
    });
  }

  async listRevisions(
    policyName: string,
    pageSize?: number,
    pageToken?: string
  ): Promise<ListAclPolicyRevisionsResult> {
    const offset = parseOffsetToken(pageToken);
    const limit = pageSize ?? DEFAULT_LIST_PAGE_SIZE;

    const result = await this.storage.find<AclPolicyRevisionRecord>(
      MEMORYSTORE_ACL_POLICY_REVISIONS_TABLE,
      {
        filter: {
          conditions: [{ field: 'policyName', operator: 'eq', value: policyName }],
        },
        pagination: { limit, offset },
        // Sorted by creation order rather than revisionNumber: the column is
        // a string, so a lexical sort orders revision 10 before revision 2.
        sort: [{ field: 'createdAt', direction: 'asc' }],
      }
    );

    const listResult: ListAclPolicyRevisionsResult = { revisions: result.data };

    if (result.hasMore) {
      listResult.nextPageToken = String(offset + limit);
    }

    return listResult;
  }
}
