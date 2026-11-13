/**
 * Domain types for Secret Manager. No HTTP and no protobuf types.
 */

import { crc32cString } from '@/shared/utils/crc32c.ts';

export const SECRETS_TABLE = 'secretmanager_secrets';

export const VERSIONS_TABLE = 'secretmanager_versions';

const SECRET_ID_PATTERN = /^[A-Za-z0-9_-]{1,255}$/;

const ALIAS_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,62}$/;

const MAX_TOPICS = 10;

const MAX_ALIASES = 50;

const RESERVED_ALIASES = new Set(['latest', 'NEW']);

export type SecretManagerErrorCode =
  | 'NOT_FOUND'
  | 'ALREADY_EXISTS'
  | 'INVALID_ARGUMENT'
  | 'FAILED_PRECONDITION'
  | 'ABORTED'
  | 'UNIMPLEMENTED'
  | 'INTERNAL';

export class SecretManagerError extends Error {
  readonly code: SecretManagerErrorCode;

  readonly resourceName: string | undefined;

  readonly resourceType: string | undefined;

  constructor(
    code: SecretManagerErrorCode,
    message: string,
    resourceName?: string,
    resourceType?: string
  ) {
    super(message);
    this.name = 'SecretManagerError';
    this.code = code;
    this.resourceName = resourceName;
    this.resourceType = resourceType;
  }
}

export interface Duration {
  readonly seconds: number;
  readonly nanos: number;
}

export interface SecretParent {
  readonly project: string;
  readonly location: string | null;
}

export interface SecretName {
  readonly parent: SecretParent;
  readonly secretId: string;
}

export interface Cmek {
  readonly kmsKeyName: string;
}

export interface Replica {
  readonly location: string;
  readonly cmek: Cmek | null;
}

export type Replication =
  | { readonly kind: 'automatic'; readonly cmek: Cmek | null }
  | { readonly kind: 'userManaged'; readonly replicas: readonly Replica[] };

export interface Rotation {
  readonly nextRotationTime: string | null;
  readonly rotationPeriod: Duration | null;
}

export type SecretType =
  | 'SECRET_TYPE_UNSPECIFIED'
  | 'CLOUD_SQL_DB_CREDENTIALS'
  | 'ACCESS_KEY'
  | 'CERTIFICATE'
  | 'OTHER_DB_CREDENTIALS'
  | 'OTHER';

export const SECRET_TYPE_BY_NUMBER: Readonly<Record<number, SecretType>> = {
  0: 'SECRET_TYPE_UNSPECIFIED',
  1: 'CLOUD_SQL_DB_CREDENTIALS',
  2: 'ACCESS_KEY',
  3: 'CERTIFICATE',
  4: 'OTHER_DB_CREDENTIALS',
  50: 'OTHER',
};

export interface SecretSpec {
  readonly replication: Replication | null;
  readonly labels: Readonly<Record<string, string>>;
  readonly topics: readonly string[];
  readonly expireTime: string | null;
  readonly rotation: Rotation | null;
  readonly versionAliases: Readonly<Record<string, number>>;
  readonly annotations: Readonly<Record<string, string>>;
  readonly versionDestroyTtl: Duration | null;
  readonly customerManagedEncryption: Cmek | null;
  readonly secretType: SecretType;
}

export type Expiration =
  | { readonly kind: 'none' }
  | { readonly kind: 'expireTime'; readonly at: string }
  | { readonly kind: 'ttl'; readonly ttl: Duration };

export interface SecretSpecInput {
  readonly replication: Replication | null;
  readonly labels: Readonly<Record<string, string>>;
  readonly topics: readonly string[];
  readonly expiration: Expiration;
  readonly rotation: Rotation | null;
  readonly versionAliases: Readonly<Record<string, number>>;
  readonly annotations: Readonly<Record<string, string>>;
  readonly versionDestroyTtl: Duration | null;
  readonly customerManagedEncryption: Cmek | null;
  readonly secretType: SecretType;
}

export interface SecretView {
  readonly name: string;
  readonly createTime: string;
  readonly etag: string;
  readonly spec: SecretSpec;
}

export type MutableSecretField =
  | 'labels'
  | 'topics'
  | 'ttl'
  | 'expireTime'
  | 'rotation'
  | 'versionAliases'
  | 'annotations'
  | 'versionDestroyTtl'
  | 'customerManagedEncryption';

export interface SecretUpdate {
  readonly spec: SecretSpecInput;
  readonly fields: ReadonlySet<MutableSecretField>;
  readonly etag: string | null;
}

const MUTABLE_MASK_PATHS: Readonly<Record<string, MutableSecretField>> = {
  labels: 'labels',
  topics: 'topics',
  expire_time: 'expireTime',
  ttl: 'ttl',
  rotation: 'rotation',
  version_aliases: 'versionAliases',
  annotations: 'annotations',
  version_destroy_ttl: 'versionDestroyTtl',
  customer_managed_encryption: 'customerManagedEncryption',
};

const IMMUTABLE_MASK_PATHS = new Set([
  'name',
  'replication',
  'create_time',
  'etag',
  'tags',
  'secret_type',
  'policy_member',
]);

export function formatSecretParent(parent: SecretParent): string {
  if (parent.location == null) {
    return `projects/${parent.project}`;
  }

  return `projects/${parent.project}/locations/${parent.location}`;
}

export function formatSecretName(name: SecretName): string {
  return `${formatSecretParent(name.parent)}/secrets/${name.secretId}`;
}

export function parseSecretParent(raw: string): SecretParent {
  const regional = /^projects\/([^/]+)\/locations\/([^/]+)$/.exec(raw);

  if (regional) {
    return {
      project: requiredSegment(regional[1], 'project'),
      location: requiredSegment(regional[2], 'location'),
    };
  }

  const global = /^projects\/([^/]+)$/.exec(raw);

  if (global) {
    return { project: requiredSegment(global[1], 'project'), location: null };
  }

  throw new SecretManagerError('INVALID_ARGUMENT', `Invalid parent '${raw}'`);
}

export function parseSecretName(raw: string): SecretName {
  const regional = /^projects\/([^/]+)\/locations\/([^/]+)\/secrets\/([^/]+)$/.exec(raw);
  const global = /^projects\/([^/]+)\/secrets\/([^/]+)$/.exec(raw);
  const match = regional ?? global;

  if (!match) {
    throw new SecretManagerError('INVALID_ARGUMENT', `Invalid secret name '${raw}'`);
  }

  const secretId = match[match.length - 1] ?? '';

  assertSecretId(secretId);

  if (regional) {
    return {
      parent: {
        project: requiredSegment(regional[1], 'project'),
        location: requiredSegment(regional[2], 'location'),
      },
      secretId,
    };
  }

  return {
    parent: { project: requiredSegment(match[1], 'project'), location: null },
    secretId,
  };
}

export function secretNameIn(parent: SecretParent, secretId: string): SecretName {
  assertSecretId(secretId);

  return { parent, secretId };
}

function assertSecretId(secretId: string): void {
  if (!SECRET_ID_PATTERN.test(secretId)) {
    throw new SecretManagerError(
      'INVALID_ARGUMENT',
      'secret_id must be 1-255 characters and contain only letters, numbers, hyphens, and underscores'
    );
  }
}

export function resolveSpec(name: SecretName, input: SecretSpecInput, now: Date): SecretSpec {
  if (name.parent.location == null && input.replication == null) {
    throw new SecretManagerError('INVALID_ARGUMENT', 'replication is required for a global secret');
  }

  if (name.parent.location != null && input.replication != null) {
    throw new SecretManagerError(
      'INVALID_ARGUMENT',
      'replication must not be set on a regional secret'
    );
  }

  if (input.replication?.kind === 'userManaged' && input.replication.replicas.length === 0) {
    throw new SecretManagerError('INVALID_ARGUMENT', 'userManaged.replicas must not be empty');
  }

  assertTopicsAndAliases(input.topics, input.versionAliases);

  return {
    replication: input.replication,
    labels: input.labels,
    topics: input.topics,
    expireTime: expireTimeFrom(input.expiration, now),
    rotation: input.rotation,
    versionAliases: input.versionAliases,
    annotations: input.annotations,
    versionDestroyTtl: input.versionDestroyTtl,
    customerManagedEncryption: input.customerManagedEncryption,
    secretType: input.secretType,
  };
}

/**
 * Mask paths may be snake_case (what the official clients send) or camelCase.
 * Nested paths and `*` are rejected: replacing a whole map for `labels.env`
 * would wipe every other key.
 */
export function parseUpdateMask(paths: readonly string[]): ReadonlySet<MutableSecretField> {
  if (paths.length === 0) {
    throw new SecretManagerError('INVALID_ARGUMENT', 'update_mask is required');
  }

  const fields = new Set<MutableSecretField>();

  for (const raw of paths) {
    const path = raw.trim().replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`);

    if (path === '' || path === '*' || path.includes('.')) {
      throw new SecretManagerError(
        'INVALID_ARGUMENT',
        `update_mask path '${raw}' is not supported; name top-level Secret fields`
      );
    }

    if (IMMUTABLE_MASK_PATHS.has(path)) {
      throw new SecretManagerError('INVALID_ARGUMENT', `Field '${raw}' cannot be updated`);
    }

    const field = MUTABLE_MASK_PATHS[path];

    if (field == null) {
      throw new SecretManagerError('INVALID_ARGUMENT', `Unknown field '${raw}' in update_mask`);
    }

    fields.add(field);
  }

  if (fields.has('ttl') && fields.has('expireTime')) {
    throw new SecretManagerError(
      'INVALID_ARGUMENT',
      'ttl and expire_time cannot both be in update_mask'
    );
  }

  return fields;
}

export function applySecretUpdate(
  current: SecretSpec,
  input: SecretSpecInput,
  fields: ReadonlySet<MutableSecretField>,
  now: Date
): SecretSpec {
  const next: SecretSpec = {
    ...current,
    labels: fields.has('labels') ? input.labels : current.labels,
    topics: fields.has('topics') ? input.topics : current.topics,
    expireTime:
      fields.has('ttl') || fields.has('expireTime')
        ? expireTimeFrom(input.expiration, now)
        : current.expireTime,
    rotation: fields.has('rotation') ? input.rotation : current.rotation,
    versionAliases: fields.has('versionAliases') ? input.versionAliases : current.versionAliases,
    annotations: fields.has('annotations') ? input.annotations : current.annotations,
    versionDestroyTtl: fields.has('versionDestroyTtl')
      ? input.versionDestroyTtl
      : current.versionDestroyTtl,
    customerManagedEncryption: fields.has('customerManagedEncryption')
      ? input.customerManagedEncryption
      : current.customerManagedEncryption,
  };

  assertTopicsAndAliases(next.topics, next.versionAliases);

  return next;
}

function assertTopicsAndAliases(
  topics: readonly string[],
  versionAliases: Readonly<Record<string, number>>
): void {
  if (topics.length > MAX_TOPICS) {
    throw new SecretManagerError(
      'INVALID_ARGUMENT',
      `A secret can have at most ${MAX_TOPICS} topics`
    );
  }

  const aliasEntries = Object.entries(versionAliases);

  if (aliasEntries.length > MAX_ALIASES) {
    throw new SecretManagerError(
      'INVALID_ARGUMENT',
      `A secret can have at most ${MAX_ALIASES} aliases`
    );
  }

  for (const [alias, version] of aliasEntries) {
    if (RESERVED_ALIASES.has(alias) || !ALIAS_PATTERN.test(alias)) {
      throw new SecretManagerError('INVALID_ARGUMENT', `Invalid version alias '${alias}'`);
    }

    if (!Number.isInteger(version) || version < 1) {
      throw new SecretManagerError(
        'INVALID_ARGUMENT',
        `Alias '${alias}' must point at a version >= 1`
      );
    }
  }
}

export function etagFromGeneration(generation: number): string {
  return String(generation);
}

const MAX_PAYLOAD_BYTES = 64 * 1024;

export interface PayloadInput {
  readonly data: Uint8Array;
  readonly crc32c: string | null;
}

export interface CheckedPayload {
  readonly dataBase64: string;
  readonly crc32c: string;
  readonly clientSpecified: boolean;
}

export type VersionSelector =
  | { readonly kind: 'number'; readonly number: number }
  | { readonly kind: 'latest' }
  | { readonly kind: 'alias'; readonly alias: string };

export interface SecretVersionLocator {
  readonly secret: SecretName;
  readonly selector: VersionSelector;
}

export interface SecretVersionView {
  readonly name: string;
  readonly state: 'ENABLED' | 'DISABLED' | 'DESTROYED';
  readonly createTime: string;
  readonly etag: string;
  readonly clientSpecifiedPayloadChecksum: boolean;
}

export interface AccessedSecret {
  readonly name: string;
  readonly data: Uint8Array;
  readonly crc32c: string;
}

export function parseSecretVersionLocator(raw: string): SecretVersionLocator {
  const marker = '/versions/';
  const index = raw.lastIndexOf(marker);

  if (index <= 0) {
    throw new SecretManagerError('INVALID_ARGUMENT', `Invalid version name '${raw}'`);
  }

  const secret = parseSecretName(raw.slice(0, index));
  const segment = raw.slice(index + marker.length);

  if (segment === 'latest') {
    return { secret, selector: { kind: 'latest' } };
  }

  if (/^[1-9][0-9]*$/.test(segment)) {
    return { secret, selector: { kind: 'number', number: Number(segment) } };
  }

  if (ALIAS_PATTERN.test(segment) && !RESERVED_ALIASES.has(segment)) {
    return { secret, selector: { kind: 'alias', alias: segment } };
  }

  throw new SecretManagerError('INVALID_ARGUMENT', `Invalid version '${segment}'`);
}

export function formatSecretVersionName(secret: string, number: number): string {
  return `${secret}/versions/${number}`;
}

export function admitPayload(input: PayloadInput): CheckedPayload {
  if (input.data.byteLength > MAX_PAYLOAD_BYTES) {
    throw new SecretManagerError('INVALID_ARGUMENT', 'Secret payload must be at most 64KiB');
  }

  const checksum = crc32cString(input.data);

  if (input.crc32c != null && parseCrc32c(input.crc32c) !== Number(checksum)) {
    throw new SecretManagerError('INVALID_ARGUMENT', 'dataCrc32c does not match the payload');
  }

  return {
    dataBase64: Buffer.from(input.data).toString('base64'),
    crc32c: checksum,
    clientSpecified: input.crc32c != null,
  };
}

export function resolveVersionNumber(
  selector: VersionSelector,
  newest: number | null,
  aliases: Readonly<Record<string, number>>,
  requestedName: string
): number {
  if (selector.kind === 'latest') {
    if (newest == null) {
      throw new SecretManagerError(
        'NOT_FOUND',
        `SecretVersion ${requestedName} not found`,
        requestedName,
        'SecretVersion'
      );
    }

    return newest;
  }

  if (selector.kind === 'alias') {
    const number = aliases[selector.alias];

    if (number == null) {
      throw new SecretManagerError(
        'NOT_FOUND',
        `SecretVersion ${requestedName} not found`,
        requestedName,
        'SecretVersion'
      );
    }

    return number;
  }

  return selector.number;
}

function expireTimeFrom(expiration: Expiration, now: Date): string | null {
  if (expiration.kind === 'none') {
    return null;
  }

  if (expiration.kind === 'expireTime') {
    return expiration.at;
  }

  const millis = expiration.ttl.seconds * 1000 + Math.floor(expiration.ttl.nanos / 1_000_000);
  const at = now.getTime() + millis;

  if (!Number.isFinite(at) || Math.abs(at) > 8_640_000_000_000_000) {
    throw new SecretManagerError('INVALID_ARGUMENT', 'ttl is out of range');
  }

  return new Date(at).toISOString();
}

function requiredSegment(value: string | undefined, field: string): string {
  if (value == null || value.length === 0) {
    throw new SecretManagerError('INVALID_ARGUMENT', `Missing ${field}`);
  }

  return value;
}

function parseCrc32c(raw: string): number {
  if (!/^-?\d+$/.test(raw)) {
    throw new SecretManagerError('INVALID_ARGUMENT', 'dataCrc32c must be a base-10 integer');
  }

  const value = Number(raw);

  if (!Number.isSafeInteger(value)) {
    throw new SecretManagerError('INVALID_ARGUMENT', 'dataCrc32c is out of range');
  }

  if (value >= 0 && value <= 0xffffffff) {
    return value;
  }

  if (value >= -2147483648 && value <= -1) {
    return value >>> 0;
  }

  throw new SecretManagerError('INVALID_ARGUMENT', 'dataCrc32c is out of range');
}
