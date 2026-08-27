/**
 * Business rules for AlloyDB instances. No HTTP concerns live here.
 */

import type { OperationResponse, OperationsStore } from '@/core/operations/operations-store.ts';
import type { BaseRecord } from '@/core/storage/types.ts';
import type { ResourceMutex } from '@/shared/utils/resource-mutex.ts';
import type { ClusterRepository } from './cluster-repository.ts';
import type { InstanceRepository } from './instance-repository.ts';
import type { ConnectionInfo, InstanceRecord, InstanceResponse } from './types.ts';
import {
  AlloyDbError,
  buildClusterName,
  buildConnectionInfo,
  buildInstanceName,
  INSTANCE_SPEC_ENUM_FIELDS,
  INSTANCE_TYPE_ENUM,
  InstanceType,
  instanceRecordToResponse,
  instanceRequestToRecord,
  isValidInstanceId,
  MUTABLE_INSTANCE_FIELDS,
  normalizeEnum,
  normalizeSpecFieldValue,
  parseSpecJson,
} from './types.ts';
import { resolveMaskedFields } from './update-mask.ts';

const RESOURCE_TYPE = 'Instance';

const INSTANCE_TYPES: ReadonlySet<string> = new Set(Object.values(InstanceType));

// A cluster holds one primary plus a bounded set of read pools, so listing every
// instance in a single page to check placement never approaches this ceiling.
const ALL_INSTANCES_IN_CLUSTER = 1_000_000;

export interface ValidatableOptions {
  validateOnly?: boolean | undefined;
}

export interface UpdateInstanceOptions extends ValidatableOptions {
  updateMask?: string | undefined;
  allowMissing?: boolean | undefined;
}

export interface ListInstancesResponse {
  instances: InstanceResponse[];
  nextPageToken?: string | undefined;
}

/**
 * <p>Instance placement is a cluster-wide invariant — a cluster holds at most one
 * PRIMARY — so every mutation that reads or changes a cluster's topology is
 * serialized on the <i>cluster</i>'s name via {@link ResourceMutex}. Keying on the
 * instance's own name would let two creates in the same cluster run concurrently
 * and each pass a placement check the other invalidates.
 */
export class InstanceService {
  private readonly instances: InstanceRepository;
  private readonly clusters: ClusterRepository;
  private readonly operations: OperationsStore;
  private readonly clusterMutex: ResourceMutex;

  constructor(
    instances: InstanceRepository,
    clusters: ClusterRepository,
    operations: OperationsStore,
    clusterMutex: ResourceMutex
  ) {
    this.instances = instances;
    this.clusters = clusters;
    this.operations = operations;
    this.clusterMutex = clusterMutex;
  }

  async createInstance(
    project: string,
    location: string,
    clusterId: string,
    instanceId: string,
    body: Record<string, unknown>,
    options: ValidatableOptions
  ): Promise<OperationResponse> {
    validateInstanceIdFormat(instanceId);
    requireInstanceType(body.instanceType);
    validateInstanceType(body.instanceType);
    validateReadPoolNodeCount(body);

    return this.clusterMutex.runExclusively(buildClusterName(project, location, clusterId), () =>
      this.createInstanceExclusively(project, location, clusterId, instanceId, body, options)
    );
  }

  private async createInstanceExclusively(
    project: string,
    location: string,
    clusterId: string,
    instanceId: string,
    body: Record<string, unknown>,
    options: ValidatableOptions
  ): Promise<OperationResponse> {
    // Re-checked inside the lock, not before it: a concurrent cluster delete
    // holds this same key, so validating the parent outside would let the create
    // pass against a cluster the cascade then removes, orphaning the instance.
    await this.requireCluster(project, location, clusterId);

    const name = buildInstanceName(project, location, clusterId, instanceId);

    if (await this.instances.getByName(name)) {
      throw new AlloyDbError('ALREADY_EXISTS', `Instance ${name} already exists`, name);
    }

    const requestedType = normalizeEnum(body.instanceType, INSTANCE_TYPE_ENUM);
    const instanceType = typeof requestedType === 'string' ? requestedType : InstanceType.PRIMARY;

    await this.validateInstancePlacement(project, location, clusterId, name, instanceType);

    const record = instanceRequestToRecord(name, body);

    return this.completeMutation(project, location, name, 'create', options, record, () =>
      this.instances.create(record)
    );
  }

  async getInstance(
    project: string,
    location: string,
    clusterId: string,
    instanceId: string
  ): Promise<InstanceResponse> {
    return instanceRecordToResponse(
      await this.getInstanceOrThrow(buildInstanceName(project, location, clusterId, instanceId))
    );
  }

  /**
   * <p><b>NOTE:</b> the discovery document does not say whether listing under a
   * missing parent 404s or returns an empty page. NOT_FOUND is chosen so a typo'd
   * cluster id fails loudly and locally instead of looking like a cluster that
   * genuinely has no instances. Flagged in the PR as inferred behaviour.
   */
  async listInstances(
    project: string,
    location: string,
    clusterId: string,
    pageSize?: number,
    pageToken?: string
  ): Promise<ListInstancesResponse> {
    await this.requireCluster(project, location, clusterId);

    const result = await this.instances.listInstances(
      project,
      location,
      clusterId,
      pageSize,
      pageToken
    );

    return {
      instances: result.instances.map(instanceRecordToResponse),
      nextPageToken: result.nextPageToken,
    };
  }

  async updateInstance(
    project: string,
    location: string,
    clusterId: string,
    instanceId: string,
    body: Record<string, unknown>,
    options: UpdateInstanceOptions
  ): Promise<OperationResponse> {
    return this.clusterMutex.runExclusively(buildClusterName(project, location, clusterId), () =>
      this.updateInstanceExclusively(project, location, clusterId, instanceId, body, options)
    );
  }

  private async updateInstanceExclusively(
    project: string,
    location: string,
    clusterId: string,
    instanceId: string,
    body: Record<string, unknown>,
    options: UpdateInstanceOptions
  ): Promise<OperationResponse> {
    const name = buildInstanceName(project, location, clusterId, instanceId);
    // Read inside the lock, not before it: a snapshot taken before acquiring the
    // mutex can be stale by the time the merge runs, and buildInstanceUpdates
    // rewrites the whole spec from it — silently reverting a concurrent PATCH.
    const existing = await this.instances.getByName(name);

    if (!existing) {
      if (options.allowMissing !== true) {
        throw new AlloyDbError('NOT_FOUND', `Instance ${name} not found`, name);
      }

      // Already holding the cluster lock, so run the create body directly with the
      // same validations createInstance applies — re-entering createInstance would
      // deadlock on this key.
      validateInstanceIdFormat(instanceId);
      requireInstanceType(body.instanceType);
      validateInstanceType(body.instanceType);

      validateReadPoolNodeCount(body);

      return this.createInstanceExclusively(
        project,
        location,
        clusterId,
        instanceId,
        body,
        options
      );
    }

    const updates = buildInstanceUpdates(existing, body, options.updateMask);

    if (typeof updates.instanceType === 'string') {
      await this.validateInstancePlacement(
        project,
        location,
        clusterId,
        name,
        updates.instanceType
      );
    }

    const updated: InstanceRecord = { ...existing, ...updates };

    return this.completeMutation(project, location, name, 'update', options, updated, () =>
      this.instances.update(name, updates)
    );
  }

  async deleteInstance(
    project: string,
    location: string,
    clusterId: string,
    instanceId: string,
    options: ValidatableOptions
  ): Promise<OperationResponse> {
    const name = buildInstanceName(project, location, clusterId, instanceId);

    // Serialized with create/update: deleting a cluster's primary while a read
    // pool is mid-placement-check would otherwise leave the pool without one.
    return this.clusterMutex.runExclusively(buildClusterName(project, location, clusterId), () =>
      this.deleteInstanceExclusively(project, location, clusterId, name, options)
    );
  }

  private async deleteInstanceExclusively(
    project: string,
    location: string,
    clusterId: string,
    name: string,
    options: ValidatableOptions
  ): Promise<OperationResponse> {
    const instance = await this.getInstanceOrThrow(name);

    await this.validatePrimaryHasNoDependentReadPools(project, location, clusterId, instance);

    if (options.validateOnly === true) {
      return this.operations.buildUnpersistedOperation(
        project,
        location,
        name,
        'delete',
        RESOURCE_TYPE
      );
    }

    await this.instances.delete(name);

    return this.operations.createOperation(project, location, name, 'delete', RESOURCE_TYPE);
  }

  async getConnectionInfo(
    project: string,
    location: string,
    clusterId: string,
    instanceId: string
  ): Promise<ConnectionInfo> {
    return buildConnectionInfo(
      await this.getInstanceOrThrow(buildInstanceName(project, location, clusterId, instanceId))
    );
  }

  private async completeMutation(
    project: string,
    location: string,
    name: string,
    verb: string,
    options: ValidatableOptions,
    projected: Omit<InstanceRecord, keyof BaseRecord>,
    apply: () => Promise<InstanceRecord | null>
  ): Promise<OperationResponse> {
    if (options.validateOnly === true) {
      return this.operations.buildUnpersistedOperation(
        project,
        location,
        name,
        verb,
        RESOURCE_TYPE,
        instanceRecordToResponse(projected)
      );
    }

    const applied = await apply();

    if (!applied) {
      throw new AlloyDbError('NOT_FOUND', `Instance ${name} not found`, name);
    }

    return this.operations.createOperation(
      project,
      location,
      name,
      verb,
      RESOURCE_TYPE,
      instanceRecordToResponse(applied)
    );
  }

  private async getInstanceOrThrow(name: string): Promise<InstanceRecord> {
    const record = await this.instances.getByName(name);

    if (!record) {
      throw new AlloyDbError('NOT_FOUND', `Instance ${name} not found`, name);
    }

    return record;
  }

  /**
   * An instance's name nests inside its cluster's, so a missing parent must be
   * reported as a missing `Cluster` rather than letting an orphan exist whose
   * parent can never be fetched.
   */
  private async requireCluster(
    project: string,
    location: string,
    clusterId: string
  ): Promise<void> {
    const clusterName = buildClusterName(project, location, clusterId);

    if (await this.clusters.getByName(clusterName)) return;

    throw new AlloyDbError('NOT_FOUND', `Cluster ${clusterName} not found`, clusterName, 'Cluster');
  }

  /**
   * Enforce the instance-placement rules real AlloyDB applies but the discovery
   * document leaves to the control plane: a cluster holds at most one PRIMARY, a
   * READ_POOL needs a primary to read from, and SECONDARY instances come only from
   * instances.createsecondary — a verb this emulator omits. Runs on both create and
   * a type-changing update, so neither path can persist a topology production rejects.
   *
   * <p>The instance being written is excluded by name, so leaving an existing PRIMARY
   * as PRIMARY is fine, while converting a cluster's only primary into a read pool —
   * which would leave it with none — is not.
   */
  private async validateInstancePlacement(
    project: string,
    location: string,
    clusterId: string,
    instanceName: string,
    instanceType: string
  ): Promise<void> {
    if (instanceType === InstanceType.SECONDARY) {
      throw new AlloyDbError(
        'INVALID_ARGUMENT',
        'SECONDARY instances are created through instances.createsecondary, which this emulator does not implement'
      );
    }

    const clusterName = buildClusterName(project, location, clusterId);
    const { instances } = await this.instances.listInstances(
      project,
      location,
      clusterId,
      ALL_INSTANCES_IN_CLUSTER
    );
    const anotherIsPrimary = instances.some(
      instance => instance.name !== instanceName && instance.instanceType === InstanceType.PRIMARY
    );

    if (instanceType === InstanceType.PRIMARY && anotherIsPrimary) {
      throw new AlloyDbError(
        'FAILED_PRECONDITION',
        `Cluster ${clusterName} already has a primary instance`,
        clusterName
      );
    }

    if (instanceType === InstanceType.READ_POOL && !anotherIsPrimary) {
      throw new AlloyDbError(
        'FAILED_PRECONDITION',
        `Cluster ${clusterName} has no primary instance; a read pool requires an existing primary`,
        clusterName
      );
    }
  }

  /**
   * A read pool reads from its cluster's primary, so deleting the primary while
   * read pools remain would strand them — the delete counterpart of the create
   * and update rule that a READ_POOL requires an existing primary. Deleting a
   * read pool, or a primary with none depending on it, is unaffected.
   */
  private async validatePrimaryHasNoDependentReadPools(
    project: string,
    location: string,
    clusterId: string,
    instance: InstanceRecord
  ): Promise<void> {
    if (instance.instanceType !== InstanceType.PRIMARY) return;

    const { instances } = await this.instances.listInstances(
      project,
      location,
      clusterId,
      ALL_INSTANCES_IN_CLUSTER
    );
    const dependentReadPools = instances.filter(
      other => other.name !== instance.name && other.instanceType === InstanceType.READ_POOL
    );

    if (dependentReadPools.length === 0) return;

    const clusterName = buildClusterName(project, location, clusterId);

    throw new AlloyDbError(
      'FAILED_PRECONDITION',
      `Cluster ${clusterName} primary cannot be deleted while ${dependentReadPools.length} read pool(s) depend on it`,
      clusterName
    );
  }
}

function validateInstanceIdFormat(instanceId: string): void {
  if (isValidInstanceId(instanceId)) return;

  throw new AlloyDbError(
    'INVALID_ARGUMENT',
    `Instance ID "${instanceId}" must be 1-63 characters, start with a lowercase letter, contain only lowercase letters, digits and dashes, and end alphanumerically`
  );
}

/**
 * AlloyDB requires `instanceType` at creation (gcloud and the API reject a body
 * without it), so create demands it explicitly rather than letting an omitted
 * value fall through to a silent PRIMARY default. PATCH keeps using
 * {@link validateInstanceType} alone, which preserves an absent type.
 */
function requireInstanceType(instanceType: unknown): void {
  if (instanceType !== undefined) return;

  throw new AlloyDbError(
    'INVALID_ARGUMENT',
    `Instance.instanceType is required and must be one of ${[...INSTANCE_TYPES].join(', ')}`
  );
}

/**
 * <p><b>NOTE:</b> normalized before validating because the official client's REST
 * fallback sends `instanceType: 1` rather than `"PRIMARY"`. The <i>original</i>
 * value is reported on failure so the message names what the client actually sent.
 */
function validateInstanceType(instanceType: unknown): void {
  if (instanceType === undefined) return;

  const normalized = normalizeEnum(instanceType, INSTANCE_TYPE_ENUM);

  if (INSTANCE_TYPES.has(String(normalized))) return;

  throw new AlloyDbError(
    'INVALID_ARGUMENT',
    `Instance.instanceType "${String(instanceType)}" must be one of ${[...INSTANCE_TYPES].join(', ')}`
  );
}

/**
 * A read pool must declare its capacity: the discovery document marks
 * `readPoolConfig` "required if the value of instanceType is READ_POOL", and real
 * AlloyDB rejects a pool without a `nodeCount` of at least one (a size-1, zonal
 * pool is the minimum). Accepting one here would let a create pass locally and
 * fail in production. The field is meaningless on a PRIMARY, so it is only
 * enforced for read pools, and `instanceType` is normalized first since the
 * official client sends it as a wire number.
 */
function validateReadPoolNodeCount(body: Record<string, unknown>): void {
  if (normalizeEnum(body.instanceType, INSTANCE_TYPE_ENUM) !== InstanceType.READ_POOL) return;

  const readPoolConfig =
    body.readPoolConfig !== null && typeof body.readPoolConfig === 'object'
      ? (body.readPoolConfig as Record<string, unknown>)
      : undefined;

  const nodeCount = Number(readPoolConfig?.nodeCount);

  if (Number.isInteger(nodeCount) && nodeCount >= 1) return;

  throw new AlloyDbError(
    'INVALID_ARGUMENT',
    'READ_POOL instances require readPoolConfig.nodeCount to be at least 1'
  );
}

/**
 * Fold a PATCH body into the columns the repository should write.
 *
 * <p>A masked field absent from the body is deleted rather than skipped, per
 * FieldMask semantics — see {@link resolveMaskedFields}.
 */
function buildInstanceUpdates(
  existing: InstanceRecord,
  body: Record<string, unknown>,
  updateMask?: string
): Partial<Omit<InstanceRecord, keyof BaseRecord>> {
  const maskedFields = resolveMaskedFields(body, MUTABLE_INSTANCE_FIELDS, updateMask);
  const spec = parseSpecJson(existing.spec);
  const updates: Partial<Omit<InstanceRecord, keyof BaseRecord>> = {
    updateTime: new Date().toISOString(),
  };

  for (const field of maskedFields) {
    // instanceType is writable but has its own column rather than living in spec.
    // It is a required column, so a masked clear cannot null it: an absent value
    // preserves the existing type rather than silently rewriting a READ_POOL or
    // SECONDARY instance to PRIMARY.
    if (field === 'instanceType') {
      if (!('instanceType' in body)) continue;

      validateInstanceType(body.instanceType);

      const normalized = normalizeEnum(body.instanceType, INSTANCE_TYPE_ENUM);

      updates.instanceType = typeof normalized === 'string' ? normalized : existing.instanceType;
      continue;
    }

    if (field in body) {
      spec[field] = normalizeSpecFieldValue(field, body[field], INSTANCE_SPEC_ENUM_FIELDS);
    } else {
      delete spec[field];
    }
  }

  updates.spec = JSON.stringify(spec);

  return updates;
}
