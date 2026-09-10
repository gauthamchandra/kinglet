/**
 * Network Security address groups — data models and helpers.
 *
 * Specification: `https://networksecurity.googleapis.com/$discovery/rest?version=v1`.
 * This module implements project-scoped `addressGroups` only. Organization
 * collections, IAM methods, `addItems` / `removeItems` / `cloneItems` /
 * `listReferences`, and the rest of Network Security are unregistered.
 */

import type { RouteResponse } from '@/core/gateway/request-router.ts';
import type { ResponseUtils } from '@/core/gateway/response-handlers.ts';
import type { BaseRecord, TableSchema } from '@/core/storage/types.ts';
import { isValidCidr } from '@/services/compute/armor/request.ts';

export const NETWORKSECURITY_ADDRESS_GROUPS_TABLE = 'networksecurity_address_groups';
export const NETWORKSECURITY_OPERATIONS_TABLE = 'networksecurity_operations';

export const NETWORKSECURITY_API_TYPE_PREFIX = 'google.cloud.networksecurity.v1';

export const AddressGroupType = {
  IPV4: 'IPV4',
  IPV6: 'IPV6',
} as const;

export type AddressGroupType = (typeof AddressGroupType)[keyof typeof AddressGroupType];

export const AddressGroupPurpose = {
  DEFAULT: 'DEFAULT',
  CLOUD_ARMOR: 'CLOUD_ARMOR',
} as const;

export type AddressGroupPurpose = (typeof AddressGroupPurpose)[keyof typeof AddressGroupPurpose];

const TYPE_ENUM: Readonly<Record<number, AddressGroupType>> = {
  1: AddressGroupType.IPV4,
  2: AddressGroupType.IPV6,
};

const PURPOSE_ENUM: Readonly<Record<number, AddressGroupPurpose>> = {
  1: AddressGroupPurpose.DEFAULT,
  2: AddressGroupPurpose.CLOUD_ARMOR,
};

const ADDRESS_GROUP_ID_RE = /^[A-Za-z][A-Za-z0-9_-]{0,62}$/;

export const MUTABLE_ADDRESS_GROUP_FIELDS = new Set(['description', 'items', 'labels', 'purpose']);

export type NetworkSecurityErrorCode =
  | 'NOT_FOUND'
  | 'ALREADY_EXISTS'
  | 'INVALID_ARGUMENT'
  | 'FAILED_PRECONDITION';

export class NetworkSecurityError extends Error {
  readonly code: NetworkSecurityErrorCode;
  readonly resourceName: string | undefined;
  readonly resourceType: string | undefined;

  constructor(
    code: NetworkSecurityErrorCode,
    message: string,
    resourceName?: string,
    resourceType?: string
  ) {
    super(message);
    this.name = 'NetworkSecurityError';
    this.code = code;
    this.resourceName = resourceName;
    this.resourceType = resourceType;
  }
}

export function handleNetworkSecurityError(
  err: unknown,
  resourceType: string,
  responseUtils: ResponseUtils
): RouteResponse {
  if (err instanceof NetworkSecurityError) {
    const reportedResourceType = err.resourceType ?? resourceType;

    switch (err.code) {
      case 'NOT_FOUND':
        return responseUtils.notFound(reportedResourceType, err.resourceName);
      case 'ALREADY_EXISTS':
        return responseUtils.alreadyExists(
          reportedResourceType,
          err.resourceName ?? reportedResourceType
        );
      case 'INVALID_ARGUMENT':
        return responseUtils.badRequest(err.message);
      case 'FAILED_PRECONDITION':
        return responseUtils.failedPrecondition(err.message);
    }
  }

  return responseUtils.internalError(err instanceof Error ? err.message : 'Internal server error');
}

export type AddressGroupResponse = Record<string, unknown> & {
  name: string;
  type: AddressGroupType;
  capacity: number;
  items: string[];
  createTime: string;
  updateTime: string;
  selfLink: string;
  description?: string;
  labels?: Record<string, string>;
  purpose?: AddressGroupPurpose[];
};

export interface AddressGroupRecord extends BaseRecord {
  name: string;
  type: AddressGroupType;
  capacity: number;
  items: string;
  purpose: string;
  labels: string;
  description: string;
  createTime: string;
  updateTime: string;
}

export const addressGroupsTableSchema: TableSchema = {
  name: NETWORKSECURITY_ADDRESS_GROUPS_TABLE,
  columns: [
    { name: 'name', type: 'string', unique: true },
    { name: 'type', type: 'string' },
    { name: 'capacity', type: 'number' },
    { name: 'items', type: 'json' },
    { name: 'purpose', type: 'json' },
    { name: 'labels', type: 'json' },
    { name: 'description', type: 'string', nullable: true },
    { name: 'createTime', type: 'string' },
    { name: 'updateTime', type: 'string' },
  ],
  indexes: [{ name: 'idx_networksecurity_address_groups_name', columns: ['name'], unique: true }],
  timestamps: true,
};

export function buildAddressGroupName(
  project: string,
  location: string,
  addressGroupId: string
): string {
  return `projects/${project}/locations/${location}/addressGroups/${addressGroupId}`;
}

export function parseAddressGroupName(name: string): {
  project: string;
  location: string;
  addressGroupId: string;
} | null {
  const match = name.match(/^projects\/([^/]+)\/locations\/([^/]+)\/addressGroups\/([^/]+)$/);

  if (!match) {
    return null;
  }

  return {
    project: match[1] as string,
    location: match[2] as string,
    addressGroupId: match[3] as string,
  };
}

export function isValidAddressGroupId(id: string): boolean {
  return ADDRESS_GROUP_ID_RE.test(id);
}

function buildSelfLink(name: string): string {
  return `https://networksecurity.googleapis.com/v1/${name}`;
}

export function addressGroupRecordToResponse(record: AddressGroupRecord): AddressGroupResponse {
  const items = JSON.parse(record.items) as string[];
  const purpose = JSON.parse(record.purpose) as AddressGroupPurpose[];
  const labels = JSON.parse(record.labels) as Record<string, string>;

  const response: AddressGroupResponse = {
    name: record.name,
    type: record.type,
    capacity: record.capacity,
    items,
    createTime: record.createTime,
    updateTime: record.updateTime,
    selfLink: buildSelfLink(record.name),
  };

  if (record.description !== '') {
    response.description = record.description;
  }

  if (Object.keys(labels).length > 0) {
    response.labels = labels;
  }

  if (purpose.length > 0) {
    response.purpose = purpose;
  }

  return response;
}

export function normalizeAddressGroupType(value: unknown): AddressGroupType {
  if (typeof value === 'number') {
    const mapped = TYPE_ENUM[value];

    if (mapped == null) {
      throw new NetworkSecurityError('INVALID_ARGUMENT', `Unknown AddressGroup type: ${value}`);
    }

    return mapped;
  }

  if (value === AddressGroupType.IPV4 || value === AddressGroupType.IPV6) {
    return value;
  }

  throw new NetworkSecurityError('INVALID_ARGUMENT', `Unknown AddressGroup type: ${String(value)}`);
}

export function normalizeCapacity(value: unknown): number {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) {
    return value;
  }

  if (typeof value === 'string' && /^\d+$/.test(value)) {
    const parsed = Number.parseInt(value, 10);

    if (parsed > 0) {
      return parsed;
    }
  }

  throw new NetworkSecurityError(
    'INVALID_ARGUMENT',
    'capacity is required and must be a positive integer'
  );
}

export function normalizeItems(value: unknown): string[] {
  if (value == null) {
    return [];
  }

  if (!Array.isArray(value)) {
    throw new NetworkSecurityError('INVALID_ARGUMENT', 'items must be a list of strings');
  }

  return value.map(item => {
    if (typeof item !== 'string' || item.trim() === '') {
      throw new NetworkSecurityError('INVALID_ARGUMENT', 'items must be a list of strings');
    }

    return item.trim();
  });
}

export function normalizePurpose(value: unknown): AddressGroupPurpose[] {
  if (value == null) {
    return [];
  }

  if (!Array.isArray(value)) {
    throw new NetworkSecurityError('INVALID_ARGUMENT', 'purpose must be a list of strings');
  }

  return value.map(entry => {
    if (typeof entry === 'number') {
      const mapped = PURPOSE_ENUM[entry];

      if (mapped == null) {
        throw new NetworkSecurityError(
          'INVALID_ARGUMENT',
          `Unknown AddressGroup purpose: ${entry}`
        );
      }

      return mapped;
    }

    if (entry === AddressGroupPurpose.DEFAULT || entry === AddressGroupPurpose.CLOUD_ARMOR) {
      return entry;
    }

    throw new NetworkSecurityError(
      'INVALID_ARGUMENT',
      `Unknown AddressGroup purpose: ${String(entry)}`
    );
  });
}

export function normalizeLabels(value: unknown): Record<string, string> {
  if (value == null) {
    return {};
  }

  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new NetworkSecurityError('INVALID_ARGUMENT', 'labels must be a map of strings');
  }

  const out: Record<string, string> = {};

  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry !== 'string') {
      throw new NetworkSecurityError('INVALID_ARGUMENT', 'labels must be a map of strings');
    }

    out[key] = entry;
  }

  return out;
}

export function itemMatchesType(item: string, type: AddressGroupType): boolean {
  const slash = item.lastIndexOf('/');
  const address = slash === -1 ? item : item.substring(0, slash);
  const range = slash === -1 ? `${address}/${type === AddressGroupType.IPV4 ? 32 : 128}` : item;

  if (!isValidCidr(range)) {
    return false;
  }

  const isV6 = address.includes(':');

  return type === AddressGroupType.IPV6 ? isV6 : !isV6;
}

export function assertItemsMatchType(items: readonly string[], type: AddressGroupType): void {
  for (const item of items) {
    if (!itemMatchesType(item, type)) {
      throw new NetworkSecurityError(
        'INVALID_ARGUMENT',
        `Item "${item}" is not a valid ${type} address or CIDR`
      );
    }
  }
}

export function assertItemsWithinCapacity(items: readonly string[], capacity: number): void {
  if (items.length > capacity) {
    throw new NetworkSecurityError(
      'INVALID_ARGUMENT',
      `Address group has ${items.length} items, which exceeds capacity ${capacity}`
    );
  }
}

export function addressGroupRequestToRecord(
  name: string,
  body: Record<string, unknown>,
  now = new Date().toISOString()
): Omit<AddressGroupRecord, keyof BaseRecord> {
  if (body.type == null) {
    throw new NetworkSecurityError('INVALID_ARGUMENT', 'type is required');
  }

  if (body.capacity == null) {
    throw new NetworkSecurityError('INVALID_ARGUMENT', 'capacity is required');
  }

  const type = normalizeAddressGroupType(body.type);
  const capacity = normalizeCapacity(body.capacity);
  const items = normalizeItems(body.items);
  const purpose = normalizePurpose(body.purpose);
  const labels = normalizeLabels(body.labels);
  const description = typeof body.description === 'string' ? body.description : '';

  assertItemsMatchType(items, type);
  assertItemsWithinCapacity(items, capacity);

  return {
    name,
    type,
    capacity,
    items: JSON.stringify(items),
    purpose: JSON.stringify(purpose),
    labels: JSON.stringify(labels),
    description,
    createTime: now,
    updateTime: now,
  };
}
