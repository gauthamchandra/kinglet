/**
 * Cloud Tasks gRPC Handlers
 *
 * Translates incoming gRPC calls into QueueService / TaskService calls and
 * converts between the string-duration/ISO-timestamp format used by the service
 * layer and the protobuf Duration/Timestamp objects that proto-loader serialises.
 *
 * IAM methods (GetIamPolicy, SetIamPolicy, TestIamPermissions) are registered
 * as UNIMPLEMENTED stubs; they are part of the CloudTasks proto service but
 * are not required for the CRUD e2e path.
 *
 * Known gaps:
 *   - GetLocation / ListLocations gRPC not implemented (REST routes stay).
 *   - grpc-status-details-bin trailing metadata not sent.
 *   - IAM methods always return UNIMPLEMENTED.
 */

import * as grpc from '@grpc/grpc-js';
import type { QueueService } from './queue-service.ts';
import { TasksError } from './queue-service.ts';
import type { TaskService } from './task-service.ts';
import type { QueueResponse, RateLimits, TaskResponse, TaskRetryConfig } from './types.ts';
import { parseQueueName } from './types.ts';

function parseQueueNameSafe(name: string): ReturnType<typeof parseQueueName> {
  try {
    return parseQueueName(name);
  } catch (err) {
    throw new TasksError(
      'INVALID_ARGUMENT',
      err instanceof Error ? err.message : 'Invalid resource name'
    );
  }
}

// ── Proto message shapes (what proto-loader deserialises into JS) ──

interface ProtoDuration {
  seconds: string;
  nanos: number;
}

interface ProtoTimestamp {
  seconds: string;
  nanos: number;
}

interface ProtoRateLimits {
  maxDispatchesPerSecond?: number;
  maxBurstSize?: number;
  maxConcurrentDispatches?: number;
}

interface ProtoRetryConfig {
  maxAttempts?: number;
  maxRetryDuration?: ProtoDuration | null;
  minBackoff?: ProtoDuration | null;
  maxBackoff?: ProtoDuration | null;
  maxDoublings?: number;
}

interface ProtoHttpRequest {
  url?: string;
  httpMethod?: string | number;
  headers?: Record<string, string>;
  body?: string;
  oauthToken?: { serviceAccountEmail?: string; scope?: string } | null;
  oidcToken?: { serviceAccountEmail?: string; audience?: string } | null;
}

interface ProtoAppEngineHttpRequest {
  httpMethod?: string | number;
  relativeUri?: string;
  headers?: Record<string, string>;
  body?: string;
  appEngineRouting?: {
    service?: string;
    version?: string;
    instance?: string;
  } | null;
}

interface ProtoTask {
  name?: string;
  payloadType?: string;
  httpRequest?: ProtoHttpRequest | null;
  appEngineHttpRequest?: ProtoAppEngineHttpRequest | null;
  scheduleTime?: ProtoTimestamp | null;
  dispatchDeadline?: ProtoDuration | null;
}

interface ListQueuesRequest {
  parent: string;
  pageSize?: number;
  pageToken?: string;
  filter?: string;
}

interface GetQueueRequest {
  name: string;
}

interface CreateQueueRequest {
  parent: string;
  queue: {
    name?: string;
    rateLimits?: ProtoRateLimits | null;
    retryConfig?: ProtoRetryConfig | null;
    [key: string]: unknown;
  };
}

interface UpdateQueueRequest {
  queue: { name: string; [key: string]: unknown };
  updateMask?: { paths?: string[] };
}

interface DeleteQueueRequest {
  name: string;
}

interface PurgeQueueRequest {
  name: string;
}

interface PauseQueueRequest {
  name: string;
}

interface ResumeQueueRequest {
  name: string;
}

interface ListTasksRequest {
  parent: string;
  responseView?: string;
  pageSize?: number;
  pageToken?: string;
}

interface GetTaskRequest {
  name: string;
  responseView?: string;
}

interface CreateTaskRequest {
  parent: string;
  task: ProtoTask;
  responseView?: string;
}

interface DeleteTaskRequest {
  name: string;
}

interface RunTaskRequest {
  name: string;
  responseView?: string;
}

interface IamRequest {
  resource: string;
  [key: string]: unknown;
}

// ── Duration / Timestamp conversion utilities ──

function parseDurationStr(s: string): ProtoDuration {
  const match = s.match(/^(\d+)(?:\.(\d+))?s$/);

  if (!match) {
    return { seconds: '0', nanos: 0 };
  }

  const seconds = match[1] ?? '0';
  const fracStr = match[2] ?? '';
  const nanos = fracStr
    ? Math.round(Number.parseInt(fracStr.padEnd(9, '0').substring(0, 9), 10))
    : 0;

  return { seconds, nanos };
}

function isoToTimestamp(iso: string): ProtoTimestamp {
  const ms = new Date(iso).getTime();
  const seconds = Math.floor(ms / 1000);
  const nanos = (ms % 1000) * 1_000_000;

  return { seconds: seconds.toString(), nanos };
}

function timestampToIso(ts: ProtoTimestamp | null | undefined): string | undefined {
  if (!ts || !ts.seconds) {
    return undefined;
  }

  const ms = Number.parseInt(ts.seconds, 10) * 1000 + Math.floor((ts.nanos ?? 0) / 1_000_000);

  return new Date(ms).toISOString();
}

function protoDurationToStr(d: ProtoDuration | null | undefined): string | undefined {
  if (!d) {
    return undefined;
  }

  const secs = Number.parseInt(d.seconds || '0', 10);
  const nanos = d.nanos ?? 0;

  if (nanos === 0) {
    return `${secs}s`;
  }

  const frac = String(nanos).padStart(9, '0').replace(/0+$/, '');

  return `${secs}.${frac}s`;
}

const GRPC_HTTP_METHOD_NAMES: Record<string, string> = {
  HTTP_METHOD_UNSPECIFIED: 'POST',
  POST: 'POST',
  GET: 'GET',
  HEAD: 'HEAD',
  PUT: 'PUT',
  DELETE: 'DELETE',
  PATCH: 'PATCH',
  OPTIONS: 'OPTIONS',
};

function normalizeGrpcHttpMethod(m: string | number | undefined): string | undefined {
  if (m == null) {
    return undefined;
  }

  if (typeof m === 'number') {
    return m === 0 ? 'POST' : undefined;
  }

  return GRPC_HTTP_METHOD_NAMES[m] ?? m;
}

// ── Request transformation: proto → service layer ──

function bytesToBase64(b: string | Uint8Array | null | undefined): string | undefined {
  if (!b) {
    return undefined;
  }

  if (b instanceof Uint8Array) {
    if (b.length === 0) {
      return undefined;
    }

    let binary = '';

    for (const byte of b) {
      binary += String.fromCharCode(byte);
    }

    return btoa(binary);
  }

  return b.length === 0 ? undefined : b;
}

function buildHttpRequestFromProto(hr: ProtoHttpRequest): Record<string, unknown> | undefined {
  if (!hr.url) {
    return undefined;
  }

  const obj: Record<string, unknown> = {
    url: hr.url,
    httpMethod: normalizeGrpcHttpMethod(hr.httpMethod) ?? 'POST',
  };

  if (hr.headers && Object.keys(hr.headers).length > 0) {
    obj.headers = hr.headers;
  }

  const body = bytesToBase64(hr.body as string | Uint8Array | null | undefined);

  if (body) {
    obj.body = body;
  }

  if (hr.oauthToken?.serviceAccountEmail) {
    obj.oauthToken = hr.oauthToken;
  }

  if (hr.oidcToken?.serviceAccountEmail) {
    obj.oidcToken = hr.oidcToken;
  }

  return obj;
}

function buildAppEngineHttpRequestFromProto(
  ae: ProtoAppEngineHttpRequest
): Record<string, unknown> | undefined {
  if (!ae.relativeUri && !ae.body && !ae.httpMethod) {
    return undefined;
  }

  const obj: Record<string, unknown> = {};

  if (ae.httpMethod) {
    obj.httpMethod = normalizeGrpcHttpMethod(ae.httpMethod) ?? 'POST';
  }

  if (ae.relativeUri) {
    obj.relativeUri = ae.relativeUri;
  }

  if (ae.headers && Object.keys(ae.headers).length > 0) {
    obj.headers = ae.headers;
  }

  const body = bytesToBase64(ae.body as string | Uint8Array | null | undefined);

  if (body) {
    obj.body = body;
  }

  if (ae.appEngineRouting) {
    obj.appEngineRouting = ae.appEngineRouting;
  }

  return obj;
}

function buildTaskRequestBody(
  task: ProtoTask,
  responseView: string | undefined
): Record<string, unknown> {
  const taskBody: Record<string, unknown> = {};

  const payloadType = task.payloadType;

  if (payloadType === 'httpRequest' && task.httpRequest) {
    const hr = buildHttpRequestFromProto(task.httpRequest);

    if (hr) {
      taskBody.httpRequest = hr;
    }
  } else if (payloadType === 'appEngineHttpRequest' && task.appEngineHttpRequest) {
    const ae = buildAppEngineHttpRequestFromProto(task.appEngineHttpRequest);

    if (ae) {
      taskBody.appEngineHttpRequest = ae;
    }
  } else if (task.httpRequest?.url) {
    const hr = buildHttpRequestFromProto(task.httpRequest);

    if (hr) {
      taskBody.httpRequest = hr;
    }
  }

  if (task.name) {
    taskBody.name = task.name;
  }

  const scheduleTimeIso = timestampToIso(task.scheduleTime);

  if (scheduleTimeIso) {
    taskBody.scheduleTime = scheduleTimeIso;
  }

  const dispatchDeadlineStr = protoDurationToStr(task.dispatchDeadline);

  if (dispatchDeadlineStr) {
    taskBody.dispatchDeadline = dispatchDeadlineStr;
  }

  const viewStr = normalizeResponseView(responseView);

  return { task: taskBody, ...(viewStr ? { responseView: viewStr } : {}) };
}

function normalizeResponseView(v: string | undefined): string | undefined {
  if (!v || v === 'VIEW_UNSPECIFIED' || v === '0') {
    return undefined;
  }

  if (v === 'BASIC' || v === '1') {
    return 'BASIC';
  }

  if (v === 'FULL' || v === '2') {
    return 'FULL';
  }

  return undefined;
}

// ── Response transformation: service layer → proto ──

function rateLimitsToProto(r: RateLimits): ProtoRateLimits {
  return {
    maxDispatchesPerSecond: r.maxDispatchesPerSecond,
    maxBurstSize: r.maxBurstSize,
    maxConcurrentDispatches: r.maxConcurrentDispatches,
  };
}

function retryConfigToProto(r: TaskRetryConfig): ProtoRetryConfig {
  return {
    maxAttempts: r.maxAttempts,
    maxRetryDuration: parseDurationStr(r.maxRetryDuration),
    minBackoff: parseDurationStr(r.minBackoff),
    maxBackoff: parseDurationStr(r.maxBackoff),
    maxDoublings: r.maxDoublings,
  };
}

function queueResponseToProto(q: QueueResponse): Record<string, unknown> {
  const proto: Record<string, unknown> = {
    name: q.name,
    state: q.state,
    rateLimits: rateLimitsToProto(q.rateLimits),
    retryConfig: retryConfigToProto(q.retryConfig),
    taskTtl: parseDurationStr(q.taskTtl),
    tombstoneTtl: parseDurationStr(q.tombstoneTtl),
  };

  if (q.purgeTime) {
    proto.purgeTime = isoToTimestamp(q.purgeTime);
  }

  if (q.stackdriverLoggingConfig) {
    proto.stackdriverLoggingConfig = q.stackdriverLoggingConfig;
  }

  if (q.httpTarget) {
    proto.httpTarget = q.httpTarget;
  }

  if (q.appEngineRoutingOverride) {
    proto.appEngineRoutingOverride = q.appEngineRoutingOverride;
  }

  return proto;
}

function taskResponseToProto(t: TaskResponse): Record<string, unknown> {
  const proto: Record<string, unknown> = {
    name: t.name,
    scheduleTime: isoToTimestamp(t.scheduleTime),
    createTime: isoToTimestamp(t.createTime),
    dispatchDeadline: parseDurationStr(t.dispatchDeadline),
    dispatchCount: t.dispatchCount,
    responseCount: t.responseCount,
  };

  if (t.httpRequest) {
    proto.httpRequest = t.httpRequest;
  }

  if (t.appEngineHttpRequest) {
    proto.appEngineHttpRequest = t.appEngineHttpRequest;
  }

  if (t.firstAttempt) {
    proto.firstAttempt = convertAttempt(t.firstAttempt);
  }

  if (t.lastAttempt) {
    proto.lastAttempt = convertAttempt(t.lastAttempt);
  }

  return proto;
}

function convertAttempt(a: NonNullable<TaskResponse['firstAttempt']>): Record<string, unknown> {
  const out: Record<string, unknown> = {};

  if (a.scheduleTime) {
    out.scheduleTime = isoToTimestamp(a.scheduleTime);
  }

  if (a.dispatchTime) {
    out.dispatchTime = isoToTimestamp(a.dispatchTime);
  }

  if (a.responseTime) {
    out.responseTime = isoToTimestamp(a.responseTime);
  }

  if (a.responseStatus) {
    out.responseStatus = a.responseStatus;
  }

  return out;
}

function listQueuesResponseToProto(result: {
  queues: QueueResponse[];
  nextPageToken?: string | undefined;
}): Record<string, unknown> {
  return {
    queues: result.queues.map(queueResponseToProto),
    nextPageToken: result.nextPageToken ?? '',
  };
}

function listTasksResponseToProto(result: {
  tasks: TaskResponse[];
  nextPageToken?: string | undefined;
}): Record<string, unknown> {
  return {
    tasks: result.tasks.map(taskResponseToProto),
    nextPageToken: result.nextPageToken ?? '',
  };
}

// ── Error mapping ──

const TASKS_ERROR_TO_GRPC: Record<string, grpc.status> = {
  NOT_FOUND: grpc.status.NOT_FOUND,
  ALREADY_EXISTS: grpc.status.ALREADY_EXISTS,
  INVALID_ARGUMENT: grpc.status.INVALID_ARGUMENT,
  FAILED_PRECONDITION: grpc.status.FAILED_PRECONDITION,
};

function toGrpcError(err: unknown): grpc.ServiceError {
  const code =
    err instanceof TasksError
      ? (TASKS_ERROR_TO_GRPC[err.code] ?? grpc.status.INTERNAL)
      : grpc.status.INTERNAL;

  const message = err instanceof Error ? err.message : 'Internal server error';

  const grpcErr = Object.assign(new Error(message), {
    code,
    name: 'ServiceError',
  }) as grpc.ServiceError;

  return grpcErr;
}

function unimplemented(methodName: string): grpc.ServiceError {
  return Object.assign(new Error(`${methodName} not implemented`), {
    code: grpc.status.UNIMPLEMENTED,
    name: 'ServiceError',
  }) as grpc.ServiceError;
}

// ── Handler class ──

export class CloudTasksGrpcHandlers {
  private queueService: QueueService;
  private taskService: TaskService;

  constructor(queueService: QueueService, taskService: TaskService) {
    this.queueService = queueService;
    this.taskService = taskService;
  }

  // ── Queue methods ──

  listQueues = async (
    call: grpc.ServerUnaryCall<ListQueuesRequest, unknown>,
    callback: grpc.sendUnaryData<unknown>
  ): Promise<void> => {
    try {
      const { parent, pageSize, pageToken, filter } = call.request;
      const { project, location } = parseQueueNameSafe(`${parent}/queues/__placeholder__`);
      const effectivePageSize = pageSize != null && pageSize > 0 ? pageSize : undefined;

      const result = await this.queueService.listQueues(
        project,
        location,
        effectivePageSize,
        pageToken,
        filter
      );

      callback(null, listQueuesResponseToProto(result));
    } catch (err) {
      callback(toGrpcError(err));
    }
  };

  getQueue = async (
    call: grpc.ServerUnaryCall<GetQueueRequest, unknown>,
    callback: grpc.sendUnaryData<unknown>
  ): Promise<void> => {
    try {
      const queue = await this.queueService.getQueue(call.request.name);

      callback(null, queueResponseToProto(queue));
    } catch (err) {
      callback(toGrpcError(err));
    }
  };

  createQueue = async (
    call: grpc.ServerUnaryCall<CreateQueueRequest, unknown>,
    callback: grpc.sendUnaryData<unknown>
  ): Promise<void> => {
    try {
      const { parent, queue } = call.request;
      const { project, location } = parseQueueNameSafe(`${parent}/queues/__placeholder__`);

      let queueId: string;

      if (queue.name) {
        if (queue.name.includes('/')) {
          const expectedPrefix = `${parent}/queues/`;

          if (!queue.name.startsWith(expectedPrefix)) {
            throw new TasksError(
              'INVALID_ARGUMENT',
              `queue.name "${queue.name}" does not belong to parent "${parent}"`
            );
          }

          const queueIdFromName = queue.name.substring(expectedPrefix.length);

          if (!queueIdFromName || queueIdFromName.includes('/')) {
            throw new TasksError(
              'INVALID_ARGUMENT',
              `queue.name "${queue.name}" is not a valid queue resource name`
            );
          }

          queueId = queueIdFromName;
        } else {
          queueId = queue.name;
        }
      } else {
        throw new TasksError('INVALID_ARGUMENT', 'queue.name is required');
      }

      const body = buildQueueRequestBody(queue);
      const result = await this.queueService.createQueue(project, location, queueId, body);

      callback(null, queueResponseToProto(result));
    } catch (err) {
      callback(toGrpcError(err));
    }
  };

  updateQueue = async (
    call: grpc.ServerUnaryCall<UpdateQueueRequest, unknown>,
    callback: grpc.sendUnaryData<unknown>
  ): Promise<void> => {
    try {
      const { queue, updateMask } = call.request;
      const paths = updateMask?.paths ?? [];
      const updateMaskStr = paths.length > 0 ? convertUpdateMaskPaths(paths) : undefined;
      const body = buildQueueRequestBody(queue);
      const result = await this.queueService.updateQueue(queue.name, body, updateMaskStr);

      callback(null, queueResponseToProto(result));
    } catch (err) {
      callback(toGrpcError(err));
    }
  };

  deleteQueue = async (
    call: grpc.ServerUnaryCall<DeleteQueueRequest, unknown>,
    callback: grpc.sendUnaryData<unknown>
  ): Promise<void> => {
    try {
      await this.queueService.deleteQueue(call.request.name);

      callback(null, {});
    } catch (err) {
      callback(toGrpcError(err));
    }
  };

  purgeQueue = async (
    call: grpc.ServerUnaryCall<PurgeQueueRequest, unknown>,
    callback: grpc.sendUnaryData<unknown>
  ): Promise<void> => {
    try {
      const result = await this.queueService.purgeQueue(call.request.name);

      callback(null, queueResponseToProto(result));
    } catch (err) {
      callback(toGrpcError(err));
    }
  };

  pauseQueue = async (
    call: grpc.ServerUnaryCall<PauseQueueRequest, unknown>,
    callback: grpc.sendUnaryData<unknown>
  ): Promise<void> => {
    try {
      const result = await this.queueService.pauseQueue(call.request.name);

      callback(null, queueResponseToProto(result));
    } catch (err) {
      callback(toGrpcError(err));
    }
  };

  resumeQueue = async (
    call: grpc.ServerUnaryCall<ResumeQueueRequest, unknown>,
    callback: grpc.sendUnaryData<unknown>
  ): Promise<void> => {
    try {
      const result = await this.queueService.resumeQueue(call.request.name);

      callback(null, queueResponseToProto(result));
    } catch (err) {
      callback(toGrpcError(err));
    }
  };

  // ── Task methods ──

  listTasks = async (
    call: grpc.ServerUnaryCall<ListTasksRequest, unknown>,
    callback: grpc.sendUnaryData<unknown>
  ): Promise<void> => {
    try {
      const { parent, responseView, pageSize, pageToken } = call.request;
      const view = normalizeResponseView(responseView);
      const effectivePageSize = pageSize != null && pageSize > 0 ? pageSize : undefined;
      const result = await this.taskService.listTasks(parent, view, effectivePageSize, pageToken);

      callback(null, listTasksResponseToProto(result));
    } catch (err) {
      callback(toGrpcError(err));
    }
  };

  getTask = async (
    call: grpc.ServerUnaryCall<GetTaskRequest, unknown>,
    callback: grpc.sendUnaryData<unknown>
  ): Promise<void> => {
    try {
      const view = normalizeResponseView(call.request.responseView);
      const task = await this.taskService.getTask(call.request.name, view);

      callback(null, taskResponseToProto(task));
    } catch (err) {
      callback(toGrpcError(err));
    }
  };

  createTask = async (
    call: grpc.ServerUnaryCall<CreateTaskRequest, unknown>,
    callback: grpc.sendUnaryData<unknown>
  ): Promise<void> => {
    try {
      const { parent, task, responseView } = call.request;
      const parsed = parseQueueNameSafe(parent);
      const body = buildTaskRequestBody(task, responseView);
      const result = await this.taskService.createTask(
        parsed.project,
        parsed.location,
        parsed.queueId,
        body
      );

      callback(null, taskResponseToProto(result));
    } catch (err) {
      callback(toGrpcError(err));
    }
  };

  deleteTask = async (
    call: grpc.ServerUnaryCall<DeleteTaskRequest, unknown>,
    callback: grpc.sendUnaryData<unknown>
  ): Promise<void> => {
    try {
      await this.taskService.deleteTask(call.request.name);

      callback(null, {});
    } catch (err) {
      callback(toGrpcError(err));
    }
  };

  runTask = async (
    call: grpc.ServerUnaryCall<RunTaskRequest, unknown>,
    callback: grpc.sendUnaryData<unknown>
  ): Promise<void> => {
    try {
      const view = normalizeResponseView(call.request.responseView);
      const result = await this.taskService.runTask(call.request.name, view);

      callback(null, taskResponseToProto(result));
    } catch (err) {
      callback(toGrpcError(err));
    }
  };

  // ── IAM stubs (UNIMPLEMENTED) ──

  getIamPolicy = async (
    _call: grpc.ServerUnaryCall<IamRequest, unknown>,
    callback: grpc.sendUnaryData<unknown>
  ): Promise<void> => {
    callback(unimplemented('GetIamPolicy'));
  };

  setIamPolicy = async (
    _call: grpc.ServerUnaryCall<IamRequest, unknown>,
    callback: grpc.sendUnaryData<unknown>
  ): Promise<void> => {
    callback(unimplemented('SetIamPolicy'));
  };

  testIamPermissions = async (
    _call: grpc.ServerUnaryCall<IamRequest, unknown>,
    callback: grpc.sendUnaryData<unknown>
  ): Promise<void> => {
    callback(unimplemented('TestIamPermissions'));
  };

  // ── Build the gRPC service implementation object ──

  toServiceImplementation(): grpc.UntypedServiceImplementation {
    return {
      ListQueues: this.listQueues,
      GetQueue: this.getQueue,
      CreateQueue: this.createQueue,
      UpdateQueue: this.updateQueue,
      DeleteQueue: this.deleteQueue,
      PurgeQueue: this.purgeQueue,
      PauseQueue: this.pauseQueue,
      ResumeQueue: this.resumeQueue,
      ListTasks: this.listTasks,
      GetTask: this.getTask,
      CreateTask: this.createTask,
      DeleteTask: this.deleteTask,
      RunTask: this.runTask,
      GetIamPolicy: this.getIamPolicy,
      SetIamPolicy: this.setIamPolicy,
      TestIamPermissions: this.testIamPermissions,
    };
  }
}

// ── Update mask path converter (proto snake_case → service camelCase) ──

const PROTO_FIELD_TO_CAMEL: Record<string, string> = {
  rate_limits: 'rateLimits',
  retry_config: 'retryConfig',
  stackdriver_logging_config: 'stackdriverLoggingConfig',
  http_target: 'httpTarget',
  app_engine_routing_override: 'appEngineRoutingOverride',
  purge_time: 'purgeTime',
  state: 'state',
  name: 'name',
};

function convertUpdateMaskPaths(paths: string[]): string {
  const camelPaths = paths.map(p => {
    const dotIdx = p.indexOf('.');
    const topLevel = dotIdx >= 0 ? p.substring(0, dotIdx) : p;

    return PROTO_FIELD_TO_CAMEL[topLevel] ?? topLevel;
  });

  return [...new Set(camelPaths)].join(',');
}

// ── Queue request body builder ──

function buildQueueRequestBody(queue: Record<string, unknown>): Record<string, unknown> {
  const body: Record<string, unknown> = {};

  const rl = queue.rateLimits as ProtoRateLimits | null | undefined;

  if (rl) {
    const rateLimits: Record<string, number> = {};

    const maxDispatches = rl.maxDispatchesPerSecond;

    if (maxDispatches != null && maxDispatches > 0) {
      rateLimits.maxDispatchesPerSecond = maxDispatches;
    }

    const maxBurst = rl.maxBurstSize;

    if (maxBurst != null) {
      rateLimits.maxBurstSize = maxBurst;
    }

    const maxConcurrent = rl.maxConcurrentDispatches;

    if (maxConcurrent != null) {
      rateLimits.maxConcurrentDispatches = maxConcurrent;
    }

    if (Object.keys(rateLimits).length > 0) {
      body.rateLimits = rateLimits;
    }
  }

  const rc = queue.retryConfig as ProtoRetryConfig | null | undefined;

  if (rc) {
    body.retryConfig = {
      maxAttempts: rc.maxAttempts,
      maxRetryDuration: protoDurationToStr(rc.maxRetryDuration),
      minBackoff: protoDurationToStr(rc.minBackoff),
      maxBackoff: protoDurationToStr(rc.maxBackoff),
      maxDoublings: rc.maxDoublings,
    };
  }

  if (queue.stackdriverLoggingConfig) {
    body.stackdriverLoggingConfig = queue.stackdriverLoggingConfig;
  }

  if (queue.httpTarget) {
    body.httpTarget = queue.httpTarget;
  }

  if (queue.appEngineRoutingOverride) {
    body.appEngineRoutingOverride = queue.appEngineRoutingOverride;
  }

  return body;
}
