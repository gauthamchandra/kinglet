/**
 * Instance Service - business logic for Memorystore instances
 */

import type { BaseRecord } from '@/core/storage/types.ts';
import type { BackupRepository } from './backup-repository.ts';
import type { InstanceRepository } from './instance-repository.ts';
import type { OperationsStore } from './operations.ts';
import type { TokenAuthRepository } from './token-auth-repository.ts';
import {
  AddTokenAuthUserRequestSchema,
  buildBackupCollectionName,
  buildBackupName,
  buildInstanceName,
  buildTokenAuthUserName,
  extractResourceId,
  type InstanceRecord,
  type InstanceResponse,
  instanceRecordToResponse,
  instanceRequestToRecord,
  MemoryStoreError,
  type OperationResponse,
  parseInstanceName,
  serializeInstanceFieldValue,
} from './types.ts';
import type { ValkeyProcessManager } from './valkey-process-manager.ts';

// The complement of the `readOnly` properties on the discovery document's
// Instance schema (memorystore.discovery-document.private.json), i.e. every
// field a real `instances.patch` accepts in its updateMask. `name` is
// additionally excluded even though the document marks it non-readOnly,
// since it is the resource's own identifier and must only ever be derived by
// the emulator itself, never accepted from a client PATCH body.
const MUTABLE_INSTANCE_FIELDS = new Set([
  'labels',
  'replicaCount',
  'shardCount',
  'nodeType',
  'mode',
  'engineVersion',
  'authorizationMode',
  'transitEncryptionMode',
  'deletionProtectionEnabled',
  'engineConfigs',
  'zoneDistributionConfig',
  'persistenceConfig',
  'automatedBackupConfig',
  'maintenancePolicy',
  'crossInstanceReplicationConfig',
  'aclPolicy',
  'endpoints',
  'kmsKey',
  'serverCaMode',
  'serverCaPool',
  'maintenanceVersion',
  'pscAutoConnections',
  'ondemandMaintenance',
  'gcsSource',
  'managedBackupSource',
  'rotateServerCertificate',
  'simulateMaintenanceEvent',
  'allowFewerZonesDeployment',
  'asyncInstanceEndpointsDeletionEnabled',
]);

// Of the fields above, only these correspond to a column this emulator
// actually persists (see InstanceRecord / instanceTableSchema). The rest are
// legitimate, non-readOnly fields on the real Instance resource that this
// emulator does not yet model end-to-end; accepting them keeps PATCH from
// misreporting a real field as "read-only or unknown", but the value has no
// persisted effect until the field is modeled.
const PERSISTED_INSTANCE_FIELDS = new Set([
  'labels',
  'replicaCount',
  'shardCount',
  'nodeType',
  'mode',
  'engineVersion',
  'authorizationMode',
  'transitEncryptionMode',
  'deletionProtectionEnabled',
  'engineConfigs',
  'zoneDistributionConfig',
  'persistenceConfig',
  'automatedBackupConfig',
  'maintenancePolicy',
  'crossInstanceReplicationConfig',
  'aclPolicy',
  'endpoints',
]);

export interface ListInstancesResponse {
  instances: InstanceResponse[];
  nextPageToken?: string;
}

function generateBackupId(): string {
  const timestamp = new Date()
    .toISOString()
    .replace(/[-:.TZ]/g, '')
    .substring(0, 14);
  const suffix = Math.random().toString(16).substring(2, 6);

  return `${timestamp}_${suffix}`;
}

export class InstanceService {
  private repo: InstanceRepository;
  private operationsStore: OperationsStore;
  private valkeyProcessManager: ValkeyProcessManager;
  private backupRepository: BackupRepository;
  private tokenAuthRepository: TokenAuthRepository;
  // Tail of the in-flight create chain per instance name, so overlapping
  // creates for the SAME name run one at a time (see runExclusivelyPerName).
  private inFlightCreateByName = new Map<string, Promise<unknown>>();

  constructor(
    repo: InstanceRepository,
    operationsStore: OperationsStore,
    valkeyProcessManager: ValkeyProcessManager,
    backupRepository: BackupRepository,
    tokenAuthRepository: TokenAuthRepository
  ) {
    this.repo = repo;
    this.operationsStore = operationsStore;
    this.valkeyProcessManager = valkeyProcessManager;
    this.backupRepository = backupRepository;
    this.tokenAuthRepository = tokenAuthRepository;
  }

  async createInstance(
    project: string,
    location: string,
    instanceId: string,
    body: Record<string, unknown>
  ): Promise<OperationResponse> {
    this.validateInstanceIdFormat(instanceId);

    const name = buildInstanceName(project, location, instanceId);

    // Serialize concurrent creates for the SAME name. Without this, two
    // overlapping creates both pass the existence check, both spawn a server,
    // and the loser's rollback (stopServerForInstance) tears down the live
    // valkey-server the winner already returned to its caller — leaving a
    // persisted instance whose discoveryEndpoints point at a dead process.
    // Serialized, the second create observes the persisted row and fails
    // ALREADY_EXISTS before it ever touches the process manager.
    return this.runExclusivelyPerName(name, () =>
      this.createInstanceExclusively(project, location, instanceId, name, body)
    );
  }

  private async createInstanceExclusively(
    project: string,
    location: string,
    instanceId: string,
    name: string,
    body: Record<string, unknown>
  ): Promise<OperationResponse> {
    const existing = await this.repo.getInstanceByName(name);

    if (existing) {
      throw new MemoryStoreError('ALREADY_EXISTS', `Instance ${name} already exists`, name);
    }

    const record = instanceRequestToRecord(name, body);
    const backupCollectionName = buildBackupCollectionName(project, location, instanceId);

    record.state = 'ACTIVE';
    record.nodeConfig = JSON.stringify({ sizeGb: 1 });
    record.backupCollection = backupCollectionName;

    const endpoint = await this.valkeyProcessManager.startServerForInstance(name);

    record.discoveryEndpoints = JSON.stringify([endpoint]);

    // The valkey-server is already running once startServerForInstance returns,
    // but the instance is not persisted yet — so a failure in either persist
    // step below would orphan that process and its port with no persisted row
    // for deleteInstance to ever clean up. Tearing it down here keeps
    // createInstance atomic: it either fully succeeds or leaves nothing behind.
    let isInstancePersisted = false;
    let wasBackupCollectionCreatedHere = false;

    try {
      const created = await this.repo.createInstance(record);

      isInstancePersisted = true;

      // The Instance advertises backupCollection immediately, so the collection
      // has to exist from creation. Materialising it only on the first backup
      // left getInstance() handing back a name that backupCollections.get 404s.
      wasBackupCollectionCreatedHere = await this.backupRepository.createBackupCollectionIfMissing(
        backupCollectionName,
        name,
        created.uid
      );

      // `return await`, not a bare `return`: a returned promise is adopted by
      // this async function, so its rejection would bypass the catch below and
      // the final step of a create would escape rollback entirely.
      return await this.operationsStore.createOperation(
        project,
        location,
        name,
        'create',
        'Instance',
        instanceRecordToResponse(created) as unknown as Record<string, unknown>
      );
    } catch (error) {
      // The spawned server is torn down first because it is the one undo whose
      // failure would leak an OS process and a port rather than a row, and a
      // throw from any later step would skip it.
      await this.valkeyProcessManager.stopServerForInstance(name);

      // Only a collection this create materialised: one that already existed
      // outlives instances by design and belongs to whoever made it. Leaving
      // ours behind would be worse than a stray row, since a retry reuses it
      // and stays pinned to the failed create's instanceUid.
      if (wasBackupCollectionCreatedHere) {
        await this.backupRepository.deleteBackupCollection(backupCollectionName);
      }

      // The persisted row is worse still: a retry would fail with
      // ALREADY_EXISTS and getInstance would keep serving an instance the
      // caller was told had failed to create.
      if (isInstancePersisted) await this.repo.deleteInstance(name);

      throw error;
    }
  }

  /**
   * Run {@code operation} so that no two invocations for the same {@code name}
   * ever overlap.
   *
   * <p>Each call chains onto the previous one for that name and only its own
   * completion (success or failure) is awaited by the next in line — a
   * predecessor throwing must not stop the successor from running. The map
   * entry is dropped once this call is the tail, so it does not grow across
   * distinct instance names.
   */
  private async runExclusivelyPerName<T>(name: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.inFlightCreateByName.get(name) ?? Promise.resolve();
    const current = previous.then(operation, operation);

    this.inFlightCreateByName.set(name, current);

    try {
      return await current;
    } finally {
      if (this.inFlightCreateByName.get(name) === current) {
        this.inFlightCreateByName.delete(name);
      }
    }
  }

  /**
   * Reject instance IDs GCP itself would reject.
   *
   * <p>The restrictions come verbatim from the v1 discovery document's
   * `instanceId` parameter: 4-63 characters, beginning with a letter or digit,
   * containing only lowercase letters/digits/hyphens, and not ending in a
   * hyphen.
   *
   * <p><b>NOTE:</b> the lowercase rule is load-bearing rather than cosmetic
   * here. {@link RequestRouter} lowercases incoming path segments, so an
   * instance created with uppercase characters would be stored under its
   * original casing and then be permanently unreachable by name. Rejecting it
   * up front turns a silently broken resource into an honest 400.
   */
  private validateInstanceIdFormat(instanceId: string): void {
    if (!/^[a-z0-9][a-z0-9-]{2,61}[a-z0-9]$/.test(instanceId)) {
      throw new MemoryStoreError(
        'INVALID_ARGUMENT',
        `Invalid instanceId "${instanceId}": must be 4-63 characters, begin with a lowercase letter or digit, contain only lowercase letters, digits and hyphens, and not end with a hyphen`
      );
    }
  }

  async getInstance(name: string): Promise<InstanceResponse> {
    const record = await this.getExistingInstanceOrThrow(name);

    return instanceRecordToResponse(record);
  }

  async listInstances(
    project: string,
    location: string,
    pageSize?: number,
    pageToken?: string,
    _filter?: string,
    _orderBy?: string
  ): Promise<ListInstancesResponse> {
    const result = await this.repo.listInstances(project, location, pageSize, pageToken);

    const response: ListInstancesResponse = {
      instances: result.instances.map(instanceRecordToResponse),
    };

    if (result.nextPageToken) response.nextPageToken = result.nextPageToken;

    return response;
  }

  async updateInstance(
    name: string,
    body: Record<string, unknown>,
    updateMask?: string
  ): Promise<OperationResponse> {
    await this.getExistingInstanceOrThrow(name);

    const updates = this.buildInstanceUpdates(body, updateMask);
    const updated = await this.repo.updateInstance(name, updates);

    const { project, location } = parseInstanceName(name);

    return this.operationsStore.createOperation(
      project,
      location,
      name,
      'update',
      'Instance',
      updated
        ? (instanceRecordToResponse(updated) as unknown as Record<string, unknown>)
        : undefined
    );
  }

  async deleteInstance(name: string): Promise<OperationResponse> {
    const instance = await this.getExistingInstanceOrThrow(name);

    if (instance.deletionProtectionEnabled === 1) {
      throw new MemoryStoreError(
        'FAILED_PRECONDITION',
        `Instance ${name} has deletion protection enabled and cannot be deleted`,
        name
      );
    }

    await this.valkeyProcessManager.stopServerForInstance(name);

    // Token auth users (and their auth tokens) belong to the instance, so
    // leaving them behind would both leak readable credentials and let a
    // later instance created under the same id inherit the previous
    // instance's users.
    await this.tokenAuthRepository.deleteTokenAuthUsersForInstance(name);
    await this.repo.deleteInstance(name);

    const { project, location } = parseInstanceName(name);

    return this.operationsStore.createOperation(project, location, name, 'delete', 'Instance');
  }

  async getCertificateAuthority(name: string): Promise<Record<string, unknown>> {
    await this.getExistingInstanceOrThrow(name);

    return { name: `${name}/certificateAuthority`, managedServerCa: { caCerts: [] } };
  }

  async backupInstance(
    name: string,
    body: { ttl?: string; backupId?: string }
  ): Promise<OperationResponse> {
    const instance = await this.getExistingInstanceOrThrow(name);
    const { project, location, instance: instanceId } = parseInstanceName(name);
    const collectionName = buildBackupCollectionName(project, location, instanceId);

    const backupId = body.backupId ?? generateBackupId();
    const backupName = buildBackupName(project, location, instanceId, backupId);

    // Ahead of materialising the collection, so a rejected backup leaves
    // nothing behind. A generated backupId is checked too, not just a
    // client-supplied one: it is a timestamp truncated to the second plus four
    // hex digits, so two backups of the same instance can collide.
    const existingBackup = await this.backupRepository.getBackupByName(backupName);

    if (existingBackup) {
      throw new MemoryStoreError(
        'ALREADY_EXISTS',
        `Backup ${backupName} already exists`,
        backupName,
        'Backup'
      );
    }

    await this.backupRepository.createBackupCollectionIfMissing(collectionName, name, instance.uid);

    await this.backupRepository.createBackup({
      name: backupName,
      backupCollection: collectionName,
      uid: crypto.randomUUID(),
      instance: name,
      instanceUid: instance.uid,
      state: 'ACTIVE',
      backupType: 'ON_DEMAND',
      engineVersion: instance.engineVersion,
      replicaCount: instance.replicaCount,
      shardCount: instance.shardCount,
      nodeType: instance.nodeType,
      totalSizeBytes: '0',
      backupFiles: JSON.stringify([]),
      // NOTE: real Memorystore derives expireTime from the request's `ttl`
      // (or the collection's retention policy) so on-demand backups eventually
      // expire. This emulator does not yet model backup expiry — `body.ttl` is
      // accepted but ignored and backups are retained indefinitely. See the
      // limitations section of docs/adrs/007-memorystore-valkey-data-plane.md.
      expireTime: null,
      encryptionInfo: null,
    });

    return this.operationsStore.createOperation(project, location, backupName, 'backup', 'Backup');
  }

  async startMigration(
    name: string,
    _body: { selfManagedSource?: unknown }
  ): Promise<OperationResponse> {
    await this.getExistingInstanceOrThrow(name);

    const { project, location } = parseInstanceName(name);

    return this.operationsStore.createOperation(
      project,
      location,
      name,
      'startMigration',
      'Instance'
    );
  }

  async finishMigration(name: string, _body: { force?: boolean }): Promise<OperationResponse> {
    await this.getExistingInstanceOrThrow(name);

    const { project, location } = parseInstanceName(name);

    return this.operationsStore.createOperation(
      project,
      location,
      name,
      'finishMigration',
      'Instance'
    );
  }

  async rescheduleMaintenance(
    name: string,
    _body: { rescheduleType?: string; scheduleTime?: string }
  ): Promise<OperationResponse> {
    await this.getExistingInstanceOrThrow(name);

    const { project, location } = parseInstanceName(name);

    return this.operationsStore.createOperation(
      project,
      location,
      name,
      'rescheduleMaintenance',
      'Instance'
    );
  }

  async addTokenAuthUser(name: string, body: unknown): Promise<OperationResponse> {
    const parsed = AddTokenAuthUserRequestSchema.safeParse(body ?? {});

    if (!parsed.success) {
      throw new MemoryStoreError(
        'INVALID_ARGUMENT',
        `Invalid addTokenAuthUser request: ${parsed.error.message}`
      );
    }

    await this.getExistingInstanceOrThrow(name);

    const { project, location, instance } = parseInstanceName(name);

    const userId = extractResourceId(parsed.data.tokenAuthUser);
    const userName = buildTokenAuthUserName(project, location, instance, userId);

    const existingUser = await this.tokenAuthRepository.getTokenAuthUserByName(userName);

    if (existingUser) {
      throw new MemoryStoreError(
        'ALREADY_EXISTS',
        `TokenAuthUser ${userName} already exists`,
        userName,
        'TokenAuthUser'
      );
    }

    await this.tokenAuthRepository.createTokenAuthUser({
      name: userName,
      instance: name,
      state: 'ACTIVE',
    });

    return this.operationsStore.createOperation(
      project,
      location,
      userName,
      'addTokenAuthUser',
      'TokenAuthUser'
    );
  }

  private async getExistingInstanceOrThrow(name: string): Promise<InstanceRecord> {
    const record = await this.repo.getInstanceByName(name);

    if (!record) {
      throw new MemoryStoreError('NOT_FOUND', `Instance ${name} not found`, name);
    }

    return record;
  }

  private buildInstanceUpdates(
    body: Record<string, unknown>,
    updateMask?: string
  ): Partial<Omit<InstanceRecord, keyof BaseRecord>> {
    const maskedFields = updateMask
      ? this.resolveUpdateMaskRootFields(updateMask)
      : Object.keys(body);

    const updates: Record<string, unknown> = {};

    for (const field of maskedFields) {
      if (!MUTABLE_INSTANCE_FIELDS.has(field)) {
        // An explicit updateMask naming a read-only/identifying field is a client
        // error worth surfacing; a field merely present in a whole-resource PATCH
        // body (no updateMask given) is silently dropped instead.
        if (updateMask) {
          throw new MemoryStoreError(
            'INVALID_ARGUMENT',
            `Field "${field}" is read-only or unknown and cannot be updated`
          );
        }
        continue;
      }

      if (!(field in body) || !PERSISTED_INSTANCE_FIELDS.has(field)) continue;

      updates[field] = serializeInstanceFieldValue(field, body[field]);
    }

    return updates as Partial<Omit<InstanceRecord, keyof BaseRecord>>;
  }

  /**
   * Reduce each raw updateMask path to the top-level field it names.
   *
   * <p>This emulator only tracks mutability at the top level of the Instance
   * resource, so a nested path like `persistenceConfig.mode` is treated as
   * "replace the whole `persistenceConfig` object" rather than merged
   * field-by-field. The `*` wildcard is rejected outright rather than
   * silently expanded to every field in the body, since real FieldMask
   * semantics for `*` ("replace the whole resource") would otherwise let a
   * client overwrite server-set fields (`state`, `discoveryEndpoints`, ...)
   * by omission.
   */
  private resolveUpdateMaskRootFields(updateMask: string): string[] {
    return updateMask.split(',').map(rawField => {
      const trimmed = rawField.trim();

      if (trimmed === '*') {
        throw new MemoryStoreError(
          'INVALID_ARGUMENT',
          'Field mask wildcard "*" is not supported; specify explicit field paths'
        );
      }

      return trimmed.split('.')[0] ?? trimmed;
    });
  }
}
