/**
 * Persistence for AlloyDB users. CRUD lives in {@link ResourceRepository}.
 */

import type { StorageManager } from '@/core/storage/manager.ts';
import { ResourceRepository } from './resource-repository.ts';
import type { UserRecord } from './types.ts';
import { ALLOYDB_USERS_TABLE, buildClusterName, userTableSchema } from './types.ts';

export interface ListUsersResult {
  users: UserRecord[];
  nextPageToken?: string | undefined;
}

export function buildUserListPrefix(project: string, location: string, clusterId: string): string {
  return `${buildClusterName(project, location, clusterId)}/users/`;
}

export class UserRepository extends ResourceRepository<UserRecord> {
  constructor(storage: StorageManager) {
    super(storage, ALLOYDB_USERS_TABLE, userTableSchema, 'user');
  }

  async listUsers(
    project: string,
    location: string,
    clusterId: string,
    pageSize?: number,
    pageToken?: string
  ): Promise<ListUsersResult> {
    const { records, nextPageToken } = await this.listByPrefix(
      buildUserListPrefix(project, location, clusterId),
      pageSize,
      pageToken
    );

    return { users: records, nextPageToken };
  }
}
