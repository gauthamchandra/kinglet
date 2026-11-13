/**
 * One row per SecretManagerService RPC. REST routes and the gRPC
 * implementation are both derived from this table.
 */

import * as grpc from '@grpc/grpc-js';
import type {
  HttpMethod,
  RouteDefinition,
  RouteRequest,
  RouteResponse,
} from '@/core/gateway/request-router.ts';
import type { ResponseFormatter, ResponseUtils } from '@/core/gateway/response-handlers.ts';
import type { SecretManager } from './service.ts';
import type { VersionTransition } from './types.ts';
import {
  parseSecretName,
  parseSecretParent,
  parseSecretVersionLocator,
  SecretManagerError,
  secretNameIn,
} from './types.ts';
import type { WireDialect, WireMessage } from './wire.ts';
import {
  decodeAdd,
  decodeCreate,
  decodeGet,
  decodeListVersions,
  decodeVersion,
  decodeVersionChange,
  encodeAccessed,
  encodeSecret,
  encodeVersion,
  encodeVersionPage,
  GRPC_DIALECT,
  REST_DIALECT,
} from './wire.ts';

export const SECRET_MANAGER_RPCS = [
  'ListSecrets',
  'CreateSecret',
  'AddSecretVersion',
  'GetSecret',
  'UpdateSecret',
  'DeleteSecret',
  'ListSecretVersions',
  'GetSecretVersion',
  'AccessSecretVersion',
  'DisableSecretVersion',
  'EnableSecretVersion',
  'DestroySecretVersion',
  'SetIamPolicy',
  'GetIamPolicy',
  'TestIamPermissions',
  'EnableManagedRotation',
  'RotateSecret',
] as const;

export type SecretManagerRpc = (typeof SECRET_MANAGER_RPCS)[number];

interface RestBinding {
  readonly method: HttpMethod;
  readonly suffix: string;
  readonly id: string;
  readonly toMessage: (parts: RestParts) => WireMessage;
}

interface BoundEntry {
  readonly kind: 'bound';
  readonly http: RestBinding;
  readonly call: (
    manager: SecretManager,
    message: WireMessage,
    dialect: WireDialect
  ) => Promise<WireMessage>;
}

interface DeferredEntry {
  readonly kind: 'deferred';
}

type RpcEntry = BoundEntry | DeferredEntry;

interface RestParts {
  readonly project: string;
  readonly location: string | null;
  readonly secret: string | null;
  readonly version: string | null;
  readonly body: unknown;
  readonly bodyParseError: boolean;
  readonly query: (name: string) => string | undefined;
}

const GLOBAL_PREFIX = '/v1/projects/:project';

const REGIONAL_PREFIX = '/v1/projects/:project/locations/:location';

const RPC_TABLE = {
  ListSecrets: deferred(),
  CreateSecret: bound({
    http: {
      method: 'POST',
      suffix: '/secrets',
      id: 'secrets.create',
      toMessage: parts => ({
        parent: parentResource(parts),
        secretId: parts.query('secretId') ?? '',
        secret: parts.body ?? {},
      }),
    },
    call: async (manager, message, dialect) => {
      const decoded = decodeCreate(message, dialect);
      const name = secretNameIn(parseSecretParent(decoded.parentRaw), decoded.secretId);
      const created = await manager.createSecret(name, decoded.spec);

      return encodeSecret(created, dialect);
    },
  }),
  AddSecretVersion: bound({
    http: {
      method: 'POST',
      suffix: '/secrets/:secret:addVersion',
      id: 'secrets.addVersion',
      toMessage: parts => ({
        ...(isRecord(parts.body) ? parts.body : {}),
        parent: secretResource(parts),
      }),
    },
    call: async (manager, message, dialect) => {
      const decoded = decodeAdd(message, dialect);
      const name = parseSecretName(decoded.parentRaw);
      const added = await manager.addVersion(name, decoded.payload);

      return encodeVersion(added, dialect);
    },
  }),
  GetSecret: bound({
    http: {
      method: 'GET',
      suffix: '/secrets/:secret',
      id: 'secrets.get',
      toMessage: parts => {
        const verb = customVerb(parts.secret);

        if (verb != null) {
          throw new SecretManagerError('UNIMPLEMENTED', `${verb} not implemented`);
        }

        return { name: secretResource(parts) };
      },
    },
    call: async (manager, message, dialect) => {
      const name = parseSecretName(decodeGet(message));
      const secret = await manager.getSecret(name);

      return encodeSecret(secret, dialect);
    },
  }),
  UpdateSecret: deferred(),
  DeleteSecret: deferred(),
  ListSecretVersions: bound({
    http: {
      method: 'GET',
      suffix: '/secrets/:secret/versions',
      id: 'secrets.versions.list',
      toMessage: parts => ({
        parent: secretResource(parts),
        pageSize: parts.query('pageSize'),
        pageToken: parts.query('pageToken'),
        filter: parts.query('filter'),
      }),
    },
    call: async (manager, message, dialect) => {
      const decoded = decodeListVersions(message);
      const page = await manager.listVersions(parseSecretName(decoded.parentRaw), decoded);

      return encodeVersionPage(page, dialect);
    },
  }),
  GetSecretVersion: bound({
    http: {
      method: 'GET',
      suffix: '/secrets/:secret/versions/:version',
      id: 'secrets.versions.get',
      toMessage: parts => ({ name: versionResource(parts) }),
    },
    call: async (manager, message, dialect) => {
      const raw = decodeVersion(message);
      const locator = parseSecretVersionLocator(raw);
      const version = await manager.getVersion(locator, raw);

      return encodeVersion(version, dialect);
    },
  }),
  AccessSecretVersion: bound({
    http: {
      method: 'GET',
      suffix: '/secrets/:secret/versions/:version:access',
      id: 'secrets.versions.access',
      toMessage: parts => ({ name: versionResource(parts) }),
    },
    call: async (manager, message, dialect) => {
      const raw = decodeVersion(message);
      const locator = parseSecretVersionLocator(raw);
      const accessed = await manager.accessVersion(locator, raw);

      return encodeAccessed(accessed, dialect);
    },
  }),
  DisableSecretVersion: versionChange('disable'),
  EnableSecretVersion: versionChange('enable'),
  DestroySecretVersion: versionChange('destroy'),
  SetIamPolicy: deferred(),
  GetIamPolicy: deferred(),
  TestIamPermissions: deferred(),
  EnableManagedRotation: deferred(),
  RotateSecret: deferred(),
} satisfies Record<SecretManagerRpc, RpcEntry>;

export function buildRestRoutes(
  manager: SecretManager,
  responseUtils: ResponseUtils,
  formatter: ResponseFormatter
): RouteDefinition[] {
  const routes: RouteDefinition[] = [];

  for (const rpc of SECRET_MANAGER_RPCS) {
    const entry = RPC_TABLE[rpc];

    if (entry.kind !== 'bound') {
      continue;
    }

    for (const scope of ['global', 'regional'] as const) {
      routes.push({
        id:
          scope === 'global' ? `projects.${entry.http.id}` : `projects.locations.${entry.http.id}`,
        method: entry.http.method,
        path: `${scope === 'global' ? GLOBAL_PREFIX : REGIONAL_PREFIX}${entry.http.suffix}`,
        handler: async request => handleRest(entry, manager, request, responseUtils, formatter),
      });
    }
  }

  return routes;
}

export function buildGrpcImplementation(manager: SecretManager): grpc.UntypedServiceImplementation {
  const implementation: Record<string, grpc.UntypedHandleCall> = {};

  for (const rpc of SECRET_MANAGER_RPCS) {
    const entry = RPC_TABLE[rpc];

    implementation[rpc] = async (
      call: grpc.ServerUnaryCall<unknown, unknown>,
      callback: grpc.sendUnaryData<unknown>
    ) => {
      if (entry.kind === 'deferred') {
        callback(unimplemented(rpc));

        return;
      }

      try {
        const result = await entry.call(manager, asMessage(call.request), GRPC_DIALECT);

        callback(null, result);
      } catch (err) {
        callback(toGrpcError(err));
      }
    };
  }

  return implementation;
}

export function protoRpcNames(protoSource: string): string[] {
  return [...protoSource.matchAll(/^ {2}rpc (\w+)\(/gm)].map(match => match[1] ?? '');
}

async function handleRest(
  entry: BoundEntry,
  manager: SecretManager,
  request: RouteRequest,
  responseUtils: ResponseUtils,
  formatter: ResponseFormatter
): Promise<RouteResponse> {
  try {
    const body = await entry.call(manager, entry.http.toMessage(restParts(request)), REST_DIALECT);

    return responseUtils.success(body);
  } catch (err) {
    return secretRestError(err, responseUtils, formatter);
  }
}

function restParts(request: RouteRequest): RestParts {
  return {
    project: request.params.project ?? '',
    location: request.params.location === undefined ? null : request.params.location,
    secret: request.params.secret === undefined ? null : request.params.secret,
    version: request.params.version === undefined ? null : request.params.version,
    body: request.body,
    bodyParseError: request.bodyParseError === true,
    query: name => readQuery(request.query[name]),
  };
}

function parentResource(parts: RestParts): string {
  if (parts.location == null) {
    return `projects/${parts.project}`;
  }

  return `projects/${parts.project}/locations/${parts.location}`;
}

function secretResource(parts: RestParts): string {
  return `${parentResource(parts)}/secrets/${parts.secret ?? ''}`;
}

function versionResource(parts: RestParts): string {
  return `${secretResource(parts)}/versions/${parts.version ?? ''}`;
}

function customVerb(segment: string | null): string | null {
  if (segment == null || !segment.includes(':')) {
    return null;
  }

  return segment.slice(segment.indexOf(':') + 1);
}

function readQuery(value: string | string[] | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  const picked = Array.isArray(value) ? value[value.length - 1] : value;

  return picked === undefined || picked.length === 0 ? undefined : picked;
}

function secretRestError(
  err: unknown,
  responseUtils: ResponseUtils,
  formatter: ResponseFormatter
): RouteResponse {
  if (err instanceof SecretManagerError) {
    switch (err.code) {
      case 'NOT_FOUND':
        return responseUtils.notFound(err.resourceType ?? 'Secret', err.resourceName ?? 'unknown');
      case 'ALREADY_EXISTS':
        return responseUtils.alreadyExists(
          err.resourceType ?? 'Secret',
          err.resourceName ?? 'unknown'
        );
      case 'INVALID_ARGUMENT':
        return responseUtils.badRequest(err.message);
      case 'FAILED_PRECONDITION':
        return responseUtils.failedPrecondition(err.message);
      case 'ABORTED':
        return responseUtils.aborted(err.message);
      case 'UNIMPLEMENTED':
        return formatter.formatGcpError(501, err.message, 'UNIMPLEMENTED');
      case 'INTERNAL':
        return responseUtils.internalError(err.message);
    }
  }

  return responseUtils.internalError(err instanceof Error ? err.message : 'Internal server error');
}

function toGrpcError(err: unknown): grpc.ServiceError {
  const code = err instanceof SecretManagerError ? GRPC_STATUS[err.code] : grpc.status.INTERNAL;
  const message = err instanceof Error ? err.message : 'Internal server error';

  return Object.assign(new Error(message), { code, name: 'ServiceError' }) as grpc.ServiceError;
}

function unimplemented(rpc: string): grpc.ServiceError {
  return Object.assign(new Error(`${rpc} not implemented`), {
    code: grpc.status.UNIMPLEMENTED,
    name: 'ServiceError',
  }) as grpc.ServiceError;
}

const GRPC_STATUS: Record<SecretManagerError['code'], grpc.status> = {
  NOT_FOUND: grpc.status.NOT_FOUND,
  ALREADY_EXISTS: grpc.status.ALREADY_EXISTS,
  INVALID_ARGUMENT: grpc.status.INVALID_ARGUMENT,
  FAILED_PRECONDITION: grpc.status.FAILED_PRECONDITION,
  ABORTED: grpc.status.ABORTED,
  UNIMPLEMENTED: grpc.status.UNIMPLEMENTED,
  INTERNAL: grpc.status.INTERNAL,
};

function bound(entry: Omit<BoundEntry, 'kind'>): BoundEntry {
  return { kind: 'bound', ...entry };
}

function versionChange(transition: VersionTransition): BoundEntry {
  return bound({
    http: {
      method: 'POST',
      suffix: `/secrets/:secret/versions/:version:${transition}`,
      id: `secrets.versions.${transition}`,
      toMessage: parts => {
        if (parts.bodyParseError) {
          throw new SecretManagerError('INVALID_ARGUMENT', 'Request body is not valid JSON');
        }

        return {
          ...(isRecord(parts.body) ? parts.body : {}),
          name: versionResource(parts),
        };
      },
    },
    call: async (manager, message, dialect) => {
      const { name, etag } = decodeVersionChange(message);
      const locator = parseSecretVersionLocator(name);
      const changed = await manager.changeVersionState(locator, name, etag, transition);

      return encodeVersion(changed, dialect);
    },
  });
}

function deferred(): DeferredEntry {
  return { kind: 'deferred' };
}

function asMessage(value: unknown): WireMessage {
  if (!isRecord(value)) {
    return {};
  }

  return value;
}

function isRecord(value: unknown): value is WireMessage {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}
