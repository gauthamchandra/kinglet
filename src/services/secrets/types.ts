/**
 * Domain types for Secret Manager. No HTTP and no protobuf types.
 */

export const SECRETS_TABLE = 'secretmanager_secrets';

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

  constructor(code: SecretManagerErrorCode, message: string, resourceName?: string) {
    super(message);
    this.name = 'SecretManagerError';
    this.code = code;
    this.resourceName = resourceName;
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

  if (input.topics.length > MAX_TOPICS) {
    throw new SecretManagerError(
      'INVALID_ARGUMENT',
      `A secret can have at most ${MAX_TOPICS} topics`
    );
  }

  const aliasEntries = Object.entries(input.versionAliases);

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

export function etagFromGeneration(generation: number): string {
  return String(generation);
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
