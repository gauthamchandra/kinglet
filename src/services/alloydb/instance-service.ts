/**
 * Business rules for AlloyDB instances. No HTTP concerns live here.
 */

import type { OperationResponse, OperationsStore } from '@/core/operations/operations-store.ts';
import type { BaseRecord } from '@/core/storage/types.ts';
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

export class InstanceService {
  private readonly instances: InstanceRepository;
  private readonly clusters: ClusterRepository;
  private readonly operations: OperationsStore;

  constructor(
    instances: InstanceRepository,
    clusters: ClusterRepository,
    operations: OperationsStore
  ) {
    this.instances = instances;
    this.clusters = clusters;
    this.operations = operations;
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
    validateInstanceType(body.instanceType);
    await this.requireCluster(project, location, clusterId);

    const name = buildInstanceName(project, location, clusterId, instanceId);

    if (await this.instances.getByName(name)) {
      throw new AlloyDbError('ALREADY_EXISTS', `Instance ${name} already exists`, name);
    }

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
    const name = buildInstanceName(project, location, clusterId, instanceId);
    const existing = await this.instances.getByName(name);

    if (!existing) {
      if (options.allowMissing !== true) {
        throw new AlloyDbError('NOT_FOUND', `Instance ${name} not found`, name);
      }

      return this.createInstance(project, location, clusterId, instanceId, body, options);
    }

    const updates = buildInstanceUpdates(existing, body, options.updateMask);
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

    await this.getInstanceOrThrow(name);

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
}

function validateInstanceIdFormat(instanceId: string): void {
  if (isValidInstanceId(instanceId)) return;

  throw new AlloyDbError(
    'INVALID_ARGUMENT',
    `Instance ID "${instanceId}" must be 1-63 characters, start with a lowercase letter, contain only lowercase letters, digits and dashes, and end alphanumerically`
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
    if (field === 'instanceType') {
      validateInstanceType(body.instanceType);

      const normalized = normalizeEnum(body.instanceType, INSTANCE_TYPE_ENUM);

      updates.instanceType = typeof normalized === 'string' ? normalized : InstanceType.PRIMARY;
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
