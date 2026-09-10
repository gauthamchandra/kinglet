/**
 * Business rules for AlloyDB clusters. No HTTP concerns live here.
 */

import type { OperationResponse, OperationsStore } from '@/core/operations/operations-store.ts';
import type { BaseRecord } from '@/core/storage/types.ts';
import type { PostgresDataPlane } from '@/shared/postgres-data-plane/data-plane-manager.ts';
import { DisabledDataPlane } from '@/shared/postgres-data-plane/data-plane-manager.ts';
import type { Logger } from '@/shared/utils/logger.ts';
import type { ResourceMutex } from '@/shared/utils/resource-mutex.ts';
import type { ClusterRepository } from './cluster-repository.ts';
import { buildInstanceListPrefix, type InstanceRepository } from './instance-repository.ts';
import type { ClusterRecord, ClusterResponse } from './types.ts';
import {
  AlloyDbError,
  buildClusterName,
  buildDataPlaneInstanceKey,
  buildUserName,
  CLUSTER_SPEC_ENUM_FIELDS,
  clusterRecordToResponse,
  clusterRequestToRecord,
  isValidClusterId,
  isValidUserId,
  MUTABLE_CLUSTER_FIELDS,
  normalizeSpecFieldValue,
  parseInstanceName,
  parseSpecJson,
  readInitialUser,
  UserType,
  userRequestToRecord,
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
  private readonly logger: Logger;
  private readonly dataPlane: PostgresDataPlane;

  constructor(
    clusters: ClusterRepository,
    instances: InstanceRepository,
    users: UserRepository,
    operations: OperationsStore,
    clusterMutex: ResourceMutex,
    logger: Logger,
    dataPlane: PostgresDataPlane = new DisabledDataPlane()
  ) {
    this.clusters = clusters;
    this.instances = instances;
    this.users = users;
    this.operations = operations;
    this.clusterMutex = clusterMutex;
    this.logger = logger;
    this.dataPlane = dataPlane;
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

    return this.completeMutation(project, location, name, 'create', options, record, async () => {
      const created = await this.clusters.create(record);

      // The initial user is the cluster's first connectable role. Persist it as a
      // User row (with password) so the data plane can authenticate connections
      // the same way a later users.create would.
      await this.createInitialUser(project, location, clusterId, body);

      return created;
    });
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
    // with instances still addressable beneath its name. Drop each instance's
    // data plane before deleting the rows, or a later cluster of the same name
    // would inherit half-built Postgres directories.
    const childInstances = await this.instances.listAllInstancesInCluster(
      project,
      location,
      clusterId
    );

    for (const instance of childInstances) {
      const parsed = parseInstanceName(instance.name);

      if (!parsed) {
        this.logger.warn(
          `Skipping data-plane drop for AlloyDB instance with unparseable name ${instance.name}`
        );
        continue;
      }

      // One instance's drop failing must not abort the cascade: stopping mid-loop
      // would leave the instances already dropped holding rows that still report
      // READY with nothing listening, and every retry would fail on the same
      // instance, so the cluster could never be deleted. The rows always go.
      try {
        await this.dataPlane.dropInstance(
          project,
          buildDataPlaneInstanceKey(parsed.location, parsed.clusterId, parsed.instanceId)
        );
      } catch (error) {
        this.logger.error(
          `Failed to drop the data plane for AlloyDB instance ${instance.name} while deleting ${name}; its Postgres data may remain on disk`,
          error
        );
      }
    }

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

  /**
   * Persist the cluster's initial user (username + password) as a User row so
   * the data plane can authenticate it. Create-only: rotating the password
   * afterwards goes through users.patch, so a rename-only cluster PATCH cannot
   * blank the stored secret.
   */
  private async createInitialUser(
    project: string,
    location: string,
    clusterId: string,
    body: Record<string, unknown>
  ): Promise<void> {
    const { username, password } = readInitialUser(body);

    // validateInitialUser has already required both, so neither is null here.
    // Guarded rather than defaulted: an empty stored password is what tells the
    // wire server to accept the user with no password at all, so it must never
    // be the fallback. (ALLOYDB_IAM_USER is accepted as user metadata, but the
    // wire server offers cleartext only — there is no IAM token login path.)
    if (username === null || password === null) {
      throw new AlloyDbError(
        'INTERNAL',
        `Cluster ${buildClusterName(project, location, clusterId)} reached user creation without a validated initialUser`
      );
    }

    await this.users.create(
      userRequestToRecord(buildUserName(project, location, clusterId, username), {
        password,
        userType: UserType.ALLOYDB_BUILT_IN,
      })
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

  // Both are required on create — the username and the password for the initial
  // postgres role. Inferred rather than stated outright: the discovery document
  // marks `Cluster.initialUser` itself Required but puts no required flag on
  // `UserPassword.user`/`.password`, and a cluster with neither has no way in.
  // Flagged in the PR. The password is stored on the matching User row for
  // data-plane auth and never returned on the cluster resource.
  if (
    typeof username !== 'string' ||
    username.length === 0 ||
    typeof password !== 'string' ||
    password.length === 0
  ) {
    throw new AlloyDbError(
      'INVALID_ARGUMENT',
      'Cluster.initialUser is required and must carry both a "user" username and a "password"'
    );
  }

  // The username becomes a User row of its own, so it has to satisfy the same id
  // rule users.create enforces. Without this, cluster create mints a user whose
  // name breaks the discovery document's `users/[^/]+` shape and which no client
  // can then GET, PATCH or DELETE.
  if (!isValidUserId(username)) {
    throw new AlloyDbError(
      'INVALID_ARGUMENT',
      `Cluster.initialUser.user "${username}" must not contain "/"`
    );
  }
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
    // `initialUser` carries a password: only the username lands on the cluster
    // row. On create the password is persisted on the matching User row; a PATCH
    // deliberately does not rotate it (see createInitialUser).
    if (field === 'initialUser') {
      updates.initialUserName = readInitialUser(body).username;
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
