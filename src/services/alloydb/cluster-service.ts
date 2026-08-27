/**
 * Business rules for AlloyDB clusters. No HTTP concerns live here.
 */

import type { OperationResponse, OperationsStore } from '@/core/operations/operations-store.ts';
import type { BaseRecord } from '@/core/storage/types.ts';
import type { ResourceMutex } from '@/shared/utils/resource-mutex.ts';
import type { ClusterRepository } from './cluster-repository.ts';
import { buildInstanceListPrefix, type InstanceRepository } from './instance-repository.ts';
import type { ClusterRecord, ClusterResponse } from './types.ts';
import {
  AlloyDbError,
  buildClusterName,
  CLUSTER_SPEC_ENUM_FIELDS,
  clusterRecordToResponse,
  clusterRequestToRecord,
  isValidClusterId,
  MUTABLE_CLUSTER_FIELDS,
  normalizeSpecFieldValue,
  parseSpecJson,
  readInitialUsername,
} from './types.ts';
import { resolveMaskedFields } from './update-mask.ts';
import { buildUserListPrefix, type UserRepository } from './user-repository.ts';

const RESOURCE_TYPE = 'Cluster';

export interface ValidatableOptions {
  validateOnly?: boolean | undefined;
}

export interface UpdateClusterOptions extends ValidatableOptions {
  updateMask?: string | undefined;
  allowMissing?: boolean | undefined;
}

export interface DeleteClusterOptions extends ValidatableOptions {
  force?: boolean | undefined;
}

export interface ListClustersResponse {
  clusters: ClusterResponse[];
  nextPageToken?: string | undefined;
}

export class ClusterService {
  private readonly clusters: ClusterRepository;
  private readonly instances: InstanceRepository;
  private readonly users: UserRepository;
  private readonly operations: OperationsStore;
  private readonly clusterMutex: ResourceMutex;

  constructor(
    clusters: ClusterRepository,
    instances: InstanceRepository,
    users: UserRepository,
    operations: OperationsStore,
    clusterMutex: ResourceMutex
  ) {
    this.clusters = clusters;
    this.instances = instances;
    this.users = users;
    this.operations = operations;
    this.clusterMutex = clusterMutex;
  }

  /**
   * <p>Runs under the shared cluster mutex so two same-id creates cannot both pass
   * the existence check and race into a duplicate row — which in memory mode would
   * only trip the repository's plain-Error guard and surface as 500 rather than a
   * clean 409.
   */
  async createCluster(
    project: string,
    location: string,
    clusterId: string,
    body: Record<string, unknown>,
    options: ValidatableOptions
  ): Promise<OperationResponse> {
    this.validateClusterId(clusterId);
    validateInitialUser(body);
    validateNetworkConfiguration(body);

    return this.clusterMutex.runExclusively(buildClusterName(project, location, clusterId), () =>
      this.createClusterExclusively(project, location, clusterId, body, options)
    );
  }

  private async createClusterExclusively(
    project: string,
    location: string,
    clusterId: string,
    body: Record<string, unknown>,
    options: ValidatableOptions
  ): Promise<OperationResponse> {
    const name = buildClusterName(project, location, clusterId);

    if (await this.clusters.getByName(name)) {
      throw new AlloyDbError('ALREADY_EXISTS', `Cluster ${name} already exists`, name);
    }

    const record = clusterRequestToRecord(name, body);

    return this.completeMutation(project, location, name, 'create', options, record, () =>
      this.clusters.create(record)
    );
  }

  async getCluster(project: string, location: string, clusterId: string): Promise<ClusterResponse> {
    return clusterRecordToResponse(
      await this.getClusterOrThrow(buildClusterName(project, location, clusterId))
    );
  }

  async listClusters(
    project: string,
    location: string,
    pageSize?: number,
    pageToken?: string
  ): Promise<ListClustersResponse> {
    const result = await this.clusters.listClusters(project, location, pageSize, pageToken);

    return {
      clusters: result.clusters.map(clusterRecordToResponse),
      nextPageToken: result.nextPageToken,
    };
  }

  /**
   * <p><b>NOTE:</b> `allowMissing` is documented as "update succeeds even if
   * cluster is not found. In that case, a new cluster is created", so the missing
   * branch runs the same creation path — inline to stay under the one lock the
   * update already holds, rather than inventing a second path with weaker checks.
   */
  async updateCluster(
    project: string,
    location: string,
    clusterId: string,
    body: Record<string, unknown>,
    options: UpdateClusterOptions
  ): Promise<OperationResponse> {
    return this.clusterMutex.runExclusively(buildClusterName(project, location, clusterId), () =>
      this.updateClusterExclusively(project, location, clusterId, body, options)
    );
  }

  private async updateClusterExclusively(
    project: string,
    location: string,
    clusterId: string,
    body: Record<string, unknown>,
    options: UpdateClusterOptions
  ): Promise<OperationResponse> {
    const name = buildClusterName(project, location, clusterId);
    // Read inside the lock so a concurrent PATCH committed first is merged on
    // top of, not silently reverted by, this one's whole-spec rewrite.
    const existing = await this.clusters.getByName(name);

    if (!existing) {
      if (options.allowMissing !== true) {
        throw new AlloyDbError('NOT_FOUND', `Cluster ${name} not found`, name);
      }

      this.validateClusterId(clusterId);
      validateInitialUser(body);
      validateNetworkConfiguration(body);

      return this.createClusterExclusively(project, location, clusterId, body, options);
    }

    const updates = buildClusterUpdates(existing, body, options.updateMask);
    const updated: ClusterRecord = { ...existing, ...updates };

    return this.completeMutation(project, location, name, 'update', options, updated, () =>
      this.clusters.update(name, updates)
    );
  }

  /**
   * <p>Runs under the cluster mutex shared with {@link InstanceService} and
   * {@link UserService}: the cascade below removes children, so it must exclude
   * an in-flight child create that already validated this cluster as its parent —
   * otherwise the create persists after the cascade and orphans its resource
   * beneath a cluster that no longer exists.
   */
  async deleteCluster(
    project: string,
    location: string,
    clusterId: string,
    options: DeleteClusterOptions
  ): Promise<OperationResponse> {
    return this.clusterMutex.runExclusively(buildClusterName(project, location, clusterId), () =>
      this.deleteClusterExclusively(project, location, clusterId, options)
    );
  }

  private async deleteClusterExclusively(
    project: string,
    location: string,
    clusterId: string,
    options: DeleteClusterOptions
  ): Promise<OperationResponse> {
    const name = buildClusterName(project, location, clusterId);

    await this.getClusterOrThrow(name);
    await this.validateNoBlockingInstances(project, location, clusterId, options.force);

    if (options.validateOnly === true) {
      return this.operations.buildUnpersistedOperation(
        project,
        location,
        name,
        'delete',
        RESOURCE_TYPE
      );
    }

    // Children first: a failure partway through must not leave a deleted cluster
    // with instances still addressable beneath its name.
    await this.instances.deleteByPrefix(buildInstanceListPrefix(project, location, clusterId));
    await this.users.deleteByPrefix(buildUserListPrefix(project, location, clusterId));
    await this.clusters.delete(name);

    return this.operations.createOperation(project, location, name, 'delete', RESOURCE_TYPE);
  }

  /**
   * Emit the operation for a mutation, applying it first unless this is a
   * `validateOnly` request. Validation has already run by this point, so a dry run
   * differs from the real thing only in whether anything is written.
   */
  private async completeMutation(
    project: string,
    location: string,
    name: string,
    verb: string,
    options: ValidatableOptions,
    projected: Omit<ClusterRecord, keyof BaseRecord>,
    apply: () => Promise<ClusterRecord | null>
  ): Promise<OperationResponse> {
    if (options.validateOnly === true) {
      return this.operations.buildUnpersistedOperation(
        project,
        location,
        name,
        verb,
        RESOURCE_TYPE,
        clusterRecordToResponse(projected)
      );
    }

    const applied = await apply();

    if (!applied) {
      throw new AlloyDbError('NOT_FOUND', `Cluster ${name} not found`, name);
    }

    return this.operations.createOperation(
      project,
      location,
      name,
      verb,
      RESOURCE_TYPE,
      clusterRecordToResponse(applied)
    );
  }

  private async getClusterOrThrow(name: string): Promise<ClusterRecord> {
    const record = await this.clusters.getByName(name);

    if (!record) {
      throw new AlloyDbError('NOT_FOUND', `Cluster ${name} not found`, name);
    }

    return record;
  }

  private validateClusterId(clusterId: string): void {
    if (isValidClusterId(clusterId)) return;

    throw new AlloyDbError(
      'INVALID_ARGUMENT',
      `Cluster ID "${clusterId}" must be 1-63 characters of lowercase letters, numbers, and dashes`
    );
  }

  /**
   * `force` governs child *instances* only — "Whether to cascade delete child
   * instances for given cluster". Users are removed either way, since a user
   * cannot outlive the cluster whose name contains it.
   */
  private async validateNoBlockingInstances(
    project: string,
    location: string,
    clusterId: string,
    force?: boolean
  ): Promise<void> {
    if (force === true) return;

    const childInstances = await this.instances.countByPrefix(
      buildInstanceListPrefix(project, location, clusterId)
    );

    if (childInstances > 0) {
      throw new AlloyDbError(
        'FAILED_PRECONDITION',
        `Cluster ${buildClusterName(project, location, clusterId)} still has ${childInstances} instance(s); set force=true to delete them along with the cluster`
      );
    }
  }
}

/**
 * <p><b>NOTE:</b> `Cluster.network` is documented "Required… This is required to
 * create a cluster. Deprecated, use network_config.network instead." Requiring
 * the deprecated field on its own would reject valid modern requests, so any of
 * the three legitimate shapes satisfies this and only a cluster with no
 * networking at all is refused. Inferred from the field descriptions rather than
 * stated outright — flagged in the PR.
 *
 * <p>A PSC-only cluster counts only when `pscConfig.pscEnabled` is true. A merely
 * present `pscConfig` — `null`, `{}`, or `{ pscEnabled: false }` — leaves the
 * cluster with no VPC network and PSC switched off, which real AlloyDB rejects.
 */
function validateNetworkConfiguration(body: Record<string, unknown>): void {
  const networkConfig = body.networkConfig;
  const configuredNetwork =
    networkConfig !== null && typeof networkConfig === 'object'
      ? (networkConfig as Record<string, unknown>).network
      : undefined;

  const hasNetwork =
    typeof body.network === 'string' && body.network.length > 0
      ? true
      : typeof configuredNetwork === 'string' && configuredNetwork.length > 0;

  const pscConfig = body.pscConfig;
  const hasEnabledPsc =
    pscConfig !== null &&
    typeof pscConfig === 'object' &&
    (pscConfig as Record<string, unknown>).pscEnabled === true;

  if (hasNetwork || hasEnabledPsc) return;

  throw new AlloyDbError(
    'INVALID_ARGUMENT',
    'Cluster requires a network: set networkConfig.network, the deprecated network field, or pscConfig.pscEnabled=true for a PSC-only cluster'
  );
}

function validateInitialUser(body: Record<string, unknown>): void {
  const initialUser =
    body.initialUser !== null && typeof body.initialUser === 'object'
      ? (body.initialUser as Record<string, unknown>)
      : undefined;

  const username = initialUser?.user;
  const password = initialUser?.password;

  // Real AlloyDB requires both on create — the username and the password for the
  // postgres role — even though the password is discarded here (no data plane to
  // create the role in). Accepting a body without a password would let a request
  // pass locally and then fail against production.
  if (
    typeof username === 'string' &&
    username.length > 0 &&
    typeof password === 'string' &&
    password.length > 0
  ) {
    return;
  }

  throw new AlloyDbError(
    'INVALID_ARGUMENT',
    'Cluster.initialUser is required and must carry both a "user" username and a "password"'
  );
}

/**
 * Fold a PATCH body into the columns the repository should write.
 *
 * <p>A masked field absent from the body is deleted rather than skipped, per
 * FieldMask semantics — see {@link resolveMaskedFields}.
 */
function buildClusterUpdates(
  existing: ClusterRecord,
  body: Record<string, unknown>,
  updateMask?: string
): Partial<Omit<ClusterRecord, keyof BaseRecord>> {
  const maskedFields = resolveMaskedFields(body, MUTABLE_CLUSTER_FIELDS, updateMask);
  const spec = parseSpecJson(existing.spec);
  const updates: Partial<Omit<ClusterRecord, keyof BaseRecord>> = {
    updateTime: new Date().toISOString(),
  };

  for (const field of maskedFields) {
    // `initialUser` carries a password, so only its username is ever stored.
    if (field === 'initialUser') {
      updates.initialUserName = readInitialUsername(body);
      continue;
    }

    if (field in body) {
      spec[field] = normalizeSpecFieldValue(field, body[field], CLUSTER_SPEC_ENUM_FIELDS);
    } else {
      delete spec[field];
    }
  }

  // Networking is required on create; a PATCH that masks `network`/`networkConfig`/
  // `pscConfig` without supplying a replacement would otherwise persist a cluster
  // create rejects. Validate the merged spec so an unrelated PATCH still passes.
  validateNetworkConfiguration(spec);

  updates.spec = JSON.stringify(spec);

  return updates;
}
