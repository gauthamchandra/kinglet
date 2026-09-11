/**
 * Persistence for project-scoped Network Security address groups.
 */

import type { StorageManager } from '@/core/storage/manager.ts';
import { ResourceRepository } from '@/core/storage/resource-repository.ts';
import type { AddressGroupRecord } from './types.ts';
import { addressGroupsTableSchema, NETWORKSECURITY_ADDRESS_GROUPS_TABLE } from './types.ts';

export interface ListAddressGroupsResult {
  addressGroups: AddressGroupRecord[];
  nextPageToken?: string | undefined;
}

function buildAddressGroupListPrefix(project: string, location: string): string {
  return `projects/${project}/locations/${location}/addressGroups/`;
}

export class AddressGroupRepository extends ResourceRepository<AddressGroupRecord> {
  constructor(storage: StorageManager) {
    super(storage, NETWORKSECURITY_ADDRESS_GROUPS_TABLE, addressGroupsTableSchema, 'address group');
  }

  async listAddressGroups(
    project: string,
    location: string,
    pageSize?: number,
    pageToken?: string
  ): Promise<ListAddressGroupsResult> {
    const { records, nextPageToken } = await this.listByPrefix(
      buildAddressGroupListPrefix(project, location),
      pageSize,
      pageToken
    );

    return { addressGroups: records, nextPageToken };
  }
}
