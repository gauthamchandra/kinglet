/**
 * Business rules for project-scoped Network Security address groups. No HTTP.
 */

import type { OperationResponse, OperationsStore } from '@/core/operations/operations-store.ts';
import { ResourceMutex } from '@/shared/utils/resource-mutex.ts';
import type { AddressGroupRepository } from './repository.ts';
import type { AddressGroupRecord, AddressGroupResponse } from './types.ts';
import {
  addressGroupRecordToResponse,
  addressGroupRequestToRecord,
  assertItemsMatchType,
  assertItemsWithinCapacity,
  buildAddressGroupName,
  isValidAddressGroupId,
  NetworkSecurityError,
  normalizeItems,
  normalizeLabels,
  normalizePurpose,
} from './types.ts';
import { resolveMaskedFields } from './update-mask.ts';

const RESOURCE_TYPE = 'AddressGroup';

export interface ListAddressGroupsResponse {
  addressGroups: AddressGroupResponse[];
  nextPageToken?: string | undefined;
}

export class AddressGroupService {
  private readonly groups: AddressGroupRepository;
  private readonly operations: OperationsStore;
  private readonly mutex = new ResourceMutex();

  constructor(groups: AddressGroupRepository, operations: OperationsStore) {
    this.groups = groups;
    this.operations = operations;
  }

  async createAddressGroup(
    project: string,
    location: string,
    addressGroupId: string,
    body: Record<string, unknown>
  ): Promise<OperationResponse> {
    if (!isValidAddressGroupId(addressGroupId)) {
      throw new NetworkSecurityError(
        'INVALID_ARGUMENT',
        'addressGroupId must be 1-63 characters, start with a letter, and contain only letters, numbers, hyphens, and underscores'
      );
    }

    const name = buildAddressGroupName(project, location, addressGroupId);

    return this.mutex.runExclusively(name, async () => {
      if (await this.groups.getByName(name)) {
        throw new NetworkSecurityError(
          'ALREADY_EXISTS',
          `AddressGroup ${name} already exists`,
          name
        );
      }

      const record = addressGroupRequestToRecord(name, body);
      const created = await this.groups.create(record);

      return this.operations.createOperation(
        project,
        location,
        name,
        'create',
        RESOURCE_TYPE,
        addressGroupRecordToResponse(created)
      );
    });
  }

  async getAddressGroup(
    project: string,
    location: string,
    addressGroupId: string
  ): Promise<AddressGroupResponse> {
    return addressGroupRecordToResponse(await this.getOrThrow(project, location, addressGroupId));
  }

  async listAddressGroups(
    project: string,
    location: string,
    pageSize?: number,
    pageToken?: string
  ): Promise<ListAddressGroupsResponse> {
    const result = await this.groups.listAddressGroups(project, location, pageSize, pageToken);

    return {
      addressGroups: result.addressGroups.map(addressGroupRecordToResponse),
      nextPageToken: result.nextPageToken,
    };
  }

  async updateAddressGroup(
    project: string,
    location: string,
    addressGroupId: string,
    body: Record<string, unknown>,
    updateMask?: string
  ): Promise<OperationResponse> {
    const name = buildAddressGroupName(project, location, addressGroupId);

    return this.mutex.runExclusively(name, async () => {
      const existing = await this.getOrThrow(project, location, addressGroupId);
      const fields = resolveMaskedFields(body, updateMask);
      const now = new Date().toISOString();
      const updates: Partial<Omit<AddressGroupRecord, 'id' | 'createdAt' | 'updatedAt'>> = {
        updateTime: now,
      };

      let items = JSON.parse(existing.items) as string[];

      for (const field of fields) {
        if (field === 'description') {
          updates.description = typeof body.description === 'string' ? body.description : '';
        }

        if (field === 'items') {
          items = normalizeItems(body.items);
          updates.items = JSON.stringify(items);
        }

        if (field === 'purpose') {
          updates.purpose = JSON.stringify(normalizePurpose(body.purpose));
        }

        if (field === 'labels') {
          updates.labels = JSON.stringify(normalizeLabels(body.labels));
        }
      }

      assertItemsMatchType(items, existing.type);
      assertItemsWithinCapacity(items, existing.capacity);

      const updated = await this.groups.update(name, updates);

      if (updated == null) {
        throw new NetworkSecurityError('NOT_FOUND', `AddressGroup ${name} not found`, name);
      }

      return this.operations.createOperation(
        project,
        location,
        name,
        'update',
        RESOURCE_TYPE,
        addressGroupRecordToResponse(updated)
      );
    });
  }

  async deleteAddressGroup(
    project: string,
    location: string,
    addressGroupId: string
  ): Promise<OperationResponse> {
    const name = buildAddressGroupName(project, location, addressGroupId);

    return this.mutex.runExclusively(name, async () => {
      await this.getOrThrow(project, location, addressGroupId);

      await this.groups.delete(name);

      return this.operations.createOperation(project, location, name, 'delete', RESOURCE_TYPE);
    });
  }

  private async getOrThrow(
    project: string,
    location: string,
    addressGroupId: string
  ): Promise<AddressGroupRecord> {
    const name = buildAddressGroupName(project, location, addressGroupId);
    const record = await this.groups.getByName(name);

    if (record == null) {
      throw new NetworkSecurityError('NOT_FOUND', `AddressGroup ${name} not found`, name);
    }

    return record;
  }
}
