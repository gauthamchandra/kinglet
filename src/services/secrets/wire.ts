/**
 * REST JSON and proto-loader objects, decoded into domain values.
 * The two dialects differ in timestamps, durations, bytes, enums, and how
 * "unset" is spelled.
 */

import type {
  AccessedSecret,
  Cmek,
  Duration,
  Expiration,
  PayloadInput,
  Replica,
  Replication,
  Rotation,
  SecretSpecInput,
  SecretType,
  SecretVersionView,
  SecretView,
} from './types.ts';
import { SECRET_TYPE_BY_NUMBER, SecretManagerError } from './types.ts';

export type WireMessage = Readonly<Record<string, unknown>>;

export interface WireDialect {
  readonly kind: 'rest' | 'grpc';
  readTimestamp(value: unknown): string | null;
  writeTimestamp(iso: string): unknown;
  readDuration(value: unknown): Duration | null;
  writeDuration(duration: Duration): unknown;
  readBytes(value: unknown): Uint8Array | null;
  writeBytes(data: Uint8Array): unknown;
}

export const REST_DIALECT: WireDialect = {
  kind: 'rest',
  readTimestamp: readRestTimestamp,
  writeTimestamp: iso => iso,
  readDuration: readRestDuration,
  writeDuration: formatDuration,
  readBytes: readRestBytes,
  writeBytes: data => Buffer.from(data).toString('base64'),
};

export const GRPC_DIALECT: WireDialect = {
  kind: 'grpc',
  readTimestamp: readProtoTimestamp,
  writeTimestamp: writeProtoTimestamp,
  readDuration: readProtoDuration,
  writeDuration: writeProtoDuration,
  readBytes: readProtoBytes,
  writeBytes: data => Buffer.from(data),
};

export function decodeCreate(
  message: WireMessage,
  dialect: WireDialect
): { parentRaw: string; secretId: string; spec: SecretSpecInput } {
  const parentRaw = readRequiredString(message.parent, 'parent');
  const secretId = readRequiredString(message.secretId, 'secret_id');
  const secret = asRecord(message.secret, 'secret');

  return { parentRaw, secretId, spec: decodeSecretSpecInput(secret, dialect) };
}

export function decodeGet(message: WireMessage): string {
  return readRequiredString(message.name, 'name');
}

export function decodeSecretSpecInput(secret: WireMessage, dialect: WireDialect): SecretSpecInput {
  return {
    replication: readReplication(secret.replication),
    labels: readStringMap(secret.labels, 'labels'),
    topics: readTopics(secret.topics),
    expiration: readExpiration(secret, dialect),
    rotation: readRotation(secret.rotation, dialect),
    versionAliases: readAliasMap(secret.versionAliases),
    annotations: readStringMap(secret.annotations, 'annotations'),
    versionDestroyTtl: readOptionalDuration(secret.versionDestroyTtl, dialect, 'versionDestroyTtl'),
    customerManagedEncryption: readCmek(secret.customerManagedEncryption),
    secretType: readSecretType(secret.secretType),
  };
}

export function encodeSecret(secret: SecretView, dialect: WireDialect): WireMessage {
  const body: Record<string, unknown> = {
    name: secret.name,
    createTime: dialect.writeTimestamp(secret.createTime),
    etag: secret.etag,
  };

  const spec = secret.spec;

  if (spec.replication != null) {
    body.replication = writeReplication(spec.replication);
  }

  if (Object.keys(spec.labels).length > 0) {
    body.labels = spec.labels;
  }

  if (spec.topics.length > 0) {
    body.topics = spec.topics.map(name => ({ name }));
  }

  if (spec.expireTime != null) {
    body.expireTime = dialect.writeTimestamp(spec.expireTime);
  }

  if (spec.rotation != null) {
    body.rotation = writeRotation(spec.rotation, dialect);
  }

  if (Object.keys(spec.versionAliases).length > 0) {
    body.versionAliases = Object.fromEntries(
      Object.entries(spec.versionAliases).map(([alias, version]) => [alias, String(version)])
    );
  }

  if (Object.keys(spec.annotations).length > 0) {
    body.annotations = spec.annotations;
  }

  if (spec.versionDestroyTtl != null) {
    body.versionDestroyTtl = dialect.writeDuration(spec.versionDestroyTtl);
  }

  if (spec.customerManagedEncryption != null) {
    body.customerManagedEncryption = { kmsKeyName: spec.customerManagedEncryption.kmsKeyName };
  }

  if (spec.secretType !== 'SECRET_TYPE_UNSPECIFIED') {
    body.secretType = spec.secretType;
  }

  return body;
}

export function decodeAdd(
  message: WireMessage,
  dialect: WireDialect
): { parentRaw: string; payload: PayloadInput } {
  const parentRaw = readRequiredString(message.parent, 'parent');
  const payload = asRecord(message.payload, 'payload');
  const data = dialect.readBytes(payload.data);

  if (data == null) {
    throw new SecretManagerError('INVALID_ARGUMENT', 'payload.data is required');
  }

  return { parentRaw, payload: { data, crc32c: readChecksum(payload, dialect) } };
}

export function decodeVersion(message: WireMessage): string {
  return readRequiredString(message.name, 'name');
}

export function encodeVersion(version: SecretVersionView, _dialect: WireDialect): WireMessage {
  return {
    name: version.name,
    state: version.state,
    createTime: _dialect.writeTimestamp(version.createTime),
    etag: version.etag,
    clientSpecifiedPayloadChecksum: version.clientSpecifiedPayloadChecksum,
  };
}

export function encodeAccessed(accessed: AccessedSecret, dialect: WireDialect): WireMessage {
  return {
    name: accessed.name,
    payload: {
      data: dialect.writeBytes(accessed.data),
      dataCrc32c: accessed.crc32c,
    },
  };
}

function readReplication(value: unknown): Replication | null {
  if (isUnset(value)) {
    return null;
  }

  const record = asRecord(value, 'replication');
  const automatic = record.automatic;
  const userManaged = record.userManaged;

  if (!isUnset(automatic) && !isUnset(userManaged)) {
    throw new SecretManagerError(
      'INVALID_ARGUMENT',
      'replication has both automatic and userManaged set'
    );
  }

  if (!isUnset(automatic)) {
    const body = asRecord(automatic, 'replication.automatic');

    return { kind: 'automatic', cmek: readCmek(body.customerManagedEncryption) };
  }

  if (!isUnset(userManaged)) {
    const body = asRecord(userManaged, 'replication.userManaged');
    const replicas = readReplicas(body.replicas);

    return { kind: 'userManaged', replicas };
  }

  return null;
}

function writeReplication(replication: Replication): WireMessage {
  if (replication.kind === 'automatic') {
    return {
      automatic:
        replication.cmek == null ? {} : { customerManagedEncryption: writeCmek(replication.cmek) },
    };
  }

  return {
    userManaged: {
      replicas: replication.replicas.map(replica => {
        const encoded: Record<string, unknown> = { location: replica.location };

        if (replica.cmek != null) {
          encoded.customerManagedEncryption = writeCmek(replica.cmek);
        }

        return encoded;
      }),
    },
  };
}

function readReplicas(value: unknown): Replica[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new SecretManagerError('INVALID_ARGUMENT', 'userManaged.replicas must not be empty');
  }

  return value.map(item => {
    const replica = asRecord(item, 'replica');
    const location = readRequiredString(replica.location, 'replica.location');

    return { location, cmek: readCmek(replica.customerManagedEncryption) };
  });
}

function readCmek(value: unknown): Cmek | null {
  if (isUnset(value)) {
    return null;
  }

  const record = asRecord(value, 'customerManagedEncryption');

  return { kmsKeyName: readRequiredString(record.kmsKeyName, 'kmsKeyName') };
}

function writeCmek(cmek: Cmek): WireMessage {
  return { kmsKeyName: cmek.kmsKeyName };
}

function readExpiration(secret: WireMessage, dialect: WireDialect): Expiration {
  if (dialect.kind === 'grpc') {
    if (secret.expiration === 'ttl') {
      return { kind: 'ttl', ttl: requireDuration(secret.ttl, dialect, 'ttl') };
    }

    if (secret.expiration === 'expireTime') {
      const at = dialect.readTimestamp(secret.expireTime);

      if (at == null) {
        throw new SecretManagerError('INVALID_ARGUMENT', 'expireTime is required');
      }

      return { kind: 'expireTime', at };
    }

    return { kind: 'none' };
  }

  const hasTtl = !isUnset(secret.ttl);
  const hasExpire = !isUnset(secret.expireTime);

  if (hasTtl && hasExpire) {
    throw new SecretManagerError('INVALID_ARGUMENT', 'ttl and expireTime cannot both be set');
  }

  if (hasTtl) {
    return { kind: 'ttl', ttl: requireDuration(secret.ttl, dialect, 'ttl') };
  }

  if (hasExpire) {
    const at = dialect.readTimestamp(secret.expireTime);

    if (at == null) {
      throw new SecretManagerError('INVALID_ARGUMENT', 'expireTime is invalid');
    }

    return { kind: 'expireTime', at };
  }

  return { kind: 'none' };
}

function readRotation(value: unknown, dialect: WireDialect): Rotation | null {
  if (isUnset(value)) {
    return null;
  }

  const record = asRecord(value, 'rotation');

  return {
    nextRotationTime: dialect.readTimestamp(record.nextRotationTime),
    rotationPeriod: readOptionalDuration(record.rotationPeriod, dialect, 'rotation.rotationPeriod'),
  };
}

function writeRotation(rotation: Rotation, dialect: WireDialect): WireMessage {
  const body: Record<string, unknown> = {};

  if (rotation.nextRotationTime != null) {
    body.nextRotationTime = dialect.writeTimestamp(rotation.nextRotationTime);
  }

  if (rotation.rotationPeriod != null) {
    body.rotationPeriod = dialect.writeDuration(rotation.rotationPeriod);
  }

  return body;
}

function readTopics(value: unknown): string[] {
  if (isUnset(value)) {
    return [];
  }

  if (!Array.isArray(value)) {
    throw new SecretManagerError('INVALID_ARGUMENT', 'topics must be a list');
  }

  return value.map(item => {
    if (typeof item === 'string') {
      return item;
    }

    const topic = asRecord(item, 'topic');

    return readRequiredString(topic.name, 'topic.name');
  });
}

function readStringMap(value: unknown, field: string): Record<string, string> {
  if (isUnset(value)) {
    return {};
  }

  const record = asRecord(value, field);
  const result: Record<string, string> = {};

  for (const [key, entry] of Object.entries(record)) {
    if (typeof entry !== 'string') {
      throw new SecretManagerError('INVALID_ARGUMENT', `${field}.${key} must be a string`);
    }

    result[key] = entry;
  }

  return result;
}

function readAliasMap(value: unknown): Record<string, number> {
  if (isUnset(value)) {
    return {};
  }

  const record = asRecord(value, 'versionAliases');
  const result: Record<string, number> = {};

  for (const [alias, entry] of Object.entries(record)) {
    const parsed =
      typeof entry === 'number' ? entry : typeof entry === 'string' ? Number(entry) : Number.NaN;

    if (!Number.isInteger(parsed)) {
      throw new SecretManagerError(
        'INVALID_ARGUMENT',
        `versionAliases.${alias} must be an integer`
      );
    }

    result[alias] = parsed;
  }

  return result;
}

function readSecretType(value: unknown): SecretType {
  if (isUnset(value) || value === 0 || value === '0' || value === 'SECRET_TYPE_UNSPECIFIED') {
    return 'SECRET_TYPE_UNSPECIFIED';
  }

  if (typeof value === 'string' && isSecretTypeName(value)) {
    return value;
  }

  if (typeof value === 'number' || (typeof value === 'string' && /^-?\d+$/.test(value))) {
    const mapped = SECRET_TYPE_BY_NUMBER[Number(value)];

    if (mapped != null && mapped !== 'SECRET_TYPE_UNSPECIFIED') {
      return mapped;
    }
  }

  throw new SecretManagerError('INVALID_ARGUMENT', `Unknown secretType '${String(value)}'`);
}

function isSecretTypeName(value: string): value is SecretType {
  return (
    value === 'CLOUD_SQL_DB_CREDENTIALS' ||
    value === 'ACCESS_KEY' ||
    value === 'CERTIFICATE' ||
    value === 'OTHER_DB_CREDENTIALS' ||
    value === 'OTHER' ||
    value === 'SECRET_TYPE_UNSPECIFIED'
  );
}

function readOptionalDuration(
  value: unknown,
  dialect: WireDialect,
  field: string
): Duration | null {
  if (isUnset(value)) {
    return null;
  }

  return requireDuration(value, dialect, field);
}

function requireDuration(value: unknown, dialect: WireDialect, field: string): Duration {
  const duration = dialect.readDuration(value);

  if (duration == null) {
    throw new SecretManagerError('INVALID_ARGUMENT', `${field} is invalid`);
  }

  return duration;
}

function readRestTimestamp(value: unknown): string | null {
  if (isUnset(value)) {
    return null;
  }

  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw new SecretManagerError('INVALID_ARGUMENT', 'Expected an RFC3339 timestamp');
  }

  return new Date(value).toISOString();
}

function readProtoTimestamp(value: unknown): string | null {
  if (isUnset(value)) {
    return null;
  }

  const record = asRecord(value, 'timestamp');
  const seconds = Number(record.seconds ?? 0);
  const nanos = Number(record.nanos ?? 0);

  if (seconds === 0 && nanos === 0) {
    return null;
  }

  return new Date(seconds * 1000 + Math.floor(nanos / 1_000_000)).toISOString();
}

function writeProtoTimestamp(iso: string): WireMessage {
  const millis = Date.parse(iso);
  const seconds = Math.floor(millis / 1000);
  const nanos = (millis % 1000) * 1_000_000;

  return { seconds: String(seconds), nanos };
}

function readRestDuration(value: unknown): Duration | null {
  if (isUnset(value)) {
    return null;
  }

  if (typeof value !== 'string') {
    throw new SecretManagerError('INVALID_ARGUMENT', 'Expected a duration string');
  }

  const match = /^(\d+)(?:\.(\d+))?s$/.exec(value);

  if (match == null || (match[2] != null && match[2].length > 9)) {
    throw new SecretManagerError('INVALID_ARGUMENT', `Invalid duration '${value}'`);
  }

  const fraction = match[2] ?? '';

  return checkedDuration(
    Number(match[1]),
    fraction.length === 0 ? 0 : Number(fraction.padEnd(9, '0'))
  );
}

function readProtoDuration(value: unknown): Duration | null {
  if (isUnset(value)) {
    return null;
  }

  const record = asRecord(value, 'duration');
  const seconds = Number(record.seconds ?? 0);
  const nanos = Number(record.nanos ?? 0);

  if (seconds === 0 && nanos === 0) {
    return null;
  }

  return checkedDuration(seconds, nanos);
}

function checkedDuration(seconds: number, nanos: number): Duration {
  if (
    !Number.isSafeInteger(seconds) ||
    seconds < 0 ||
    !Number.isInteger(nanos) ||
    nanos < 0 ||
    nanos > 999_999_999
  ) {
    throw new SecretManagerError('INVALID_ARGUMENT', 'duration is out of range');
  }

  return { seconds, nanos };
}

function writeProtoDuration(duration: Duration): WireMessage {
  return { seconds: String(duration.seconds), nanos: duration.nanos };
}

function formatDuration(duration: Duration): string {
  if (duration.nanos === 0) {
    return `${duration.seconds}s`;
  }

  const fraction = String(duration.nanos).padStart(9, '0').replace(/0+$/, '');

  return `${duration.seconds}.${fraction}s`;
}

function readRestBytes(value: unknown): Uint8Array | null {
  if (isUnset(value)) {
    return null;
  }

  if (typeof value !== 'string') {
    throw new SecretManagerError('INVALID_ARGUMENT', 'Expected base64 data');
  }

  return new Uint8Array(Buffer.from(value, 'base64'));
}

function readProtoBytes(value: unknown): Uint8Array | null {
  if (isUnset(value)) {
    return null;
  }

  if (value instanceof Uint8Array) {
    return new Uint8Array(value);
  }

  throw new SecretManagerError('INVALID_ARGUMENT', 'Expected bytes');
}

function readChecksum(payload: WireMessage, dialect: WireDialect): string | null {
  if (dialect.kind === 'grpc' && payload._dataCrc32c !== 'dataCrc32c') {
    return null;
  }

  if (payload.dataCrc32c == null || payload.dataCrc32c === '') {
    return null;
  }

  return String(payload.dataCrc32c);
}

function readRequiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new SecretManagerError('INVALID_ARGUMENT', `${field} is required`);
  }

  return value;
}

function asRecord(value: unknown, field: string): WireMessage {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    throw new SecretManagerError('INVALID_ARGUMENT', `${field} must be an object`);
  }

  return value as WireMessage;
}

function isUnset(value: unknown): boolean {
  return value == null || value === '';
}
