/**
 * Secret Manager rules. No HTTP and no protobuf.
 */

import { ResourceMutex } from '@/shared/utils/resource-mutex.ts';
import type { SecretRepository, StoredVersion } from './repository.ts';
import type {
  AccessedSecret,
  PageRequest,
  PayloadInput,
  SecretName,
  SecretSpecInput,
  SecretVersionLocator,
  SecretVersionPage,
  SecretVersionView,
  SecretView,
  VersionTransition,
} from './types.ts';
import {
  admitPayload,
  etagFromGeneration,
  formatSecretName,
  formatSecretParent,
  formatSecretVersionName,
  nextVersionState,
  parsePageToken,
  resolvePageSize,
  resolveSpec,
  resolveVersionNumber,
  SecretManagerError,
} from './types.ts';

export class SecretManager {
  private readonly repository: SecretRepository;

  private readonly clock: () => Date;

  private readonly mutex = new ResourceMutex();

  constructor(repository: SecretRepository, clock: () => Date = () => new Date()) {
    this.repository = repository;
    this.clock = clock;
  }

  async createSecret(name: SecretName, input: SecretSpecInput): Promise<SecretView> {
    const resource = formatSecretName(name);
    const spec = resolveSpec(name, input, this.clock());

    return this.mutex.runExclusively(resource, async () => {
      const existing = await this.repository.getByName(resource);

      if (existing) {
        throw new SecretManagerError(
          'ALREADY_EXISTS',
          `Secret ${resource} already exists`,
          resource
        );
      }

      const stored = await this.repository.insert({
        name: resource,
        parent: formatSecretParent(name.parent),
        generation: 1,
        createTime: this.clock().toISOString(),
        spec,
      });

      return toView(stored);
    });
  }

  async getSecret(name: SecretName): Promise<SecretView> {
    const resource = formatSecretName(name);
    const stored = await this.repository.getByName(resource);

    if (stored == null) {
      throw new SecretManagerError('NOT_FOUND', `Secret ${resource} not found`, resource);
    }

    return toView(stored);
  }

  async addVersion(name: SecretName, payload: PayloadInput): Promise<SecretVersionView> {
    const resource = formatSecretName(name);
    const checked = admitPayload(payload);

    return this.mutex.runExclusively(resource, async () => {
      const secret = await this.repository.getByName(resource);

      if (secret == null) {
        throw new SecretManagerError('NOT_FOUND', `Secret ${resource} not found`, resource);
      }

      const newest = await this.repository.findNewestVersion(resource);
      const number = (newest?.number ?? 0) + 1;
      const stored = await this.repository.insertVersion({
        secretName: resource,
        number,
        state: 'ENABLED',
        createTime: this.clock().toISOString(),
        destroyTime: null,
        generation: 1,
        payloadData: checked.dataBase64,
        payloadCrc32c: checked.crc32c,
        clientSpecifiedPayloadChecksum: checked.clientSpecified,
      });

      return toVersionView(stored);
    });
  }

  async getVersion(
    locator: SecretVersionLocator,
    requestedName: string
  ): Promise<SecretVersionView> {
    const stored = await this.loadVersion(locator, requestedName);

    return toVersionView(stored);
  }

  async accessVersion(
    locator: SecretVersionLocator,
    requestedName: string
  ): Promise<AccessedSecret> {
    const stored = await this.loadVersion(locator, requestedName);

    if (stored.state !== 'ENABLED' || stored.payloadData == null || stored.payloadCrc32c == null) {
      throw new SecretManagerError(
        'FAILED_PRECONDITION',
        `SecretVersion ${requestedName} is in ${stored.state} state`,
        requestedName
      );
    }

    return {
      name: formatSecretVersionName(stored.secretName, stored.number),
      data: new Uint8Array(Buffer.from(stored.payloadData, 'base64')),
      crc32c: stored.payloadCrc32c,
    };
  }

  async listVersions(name: SecretName, page: PageRequest): Promise<SecretVersionPage> {
    const resource = formatSecretName(name);
    const limit = resolvePageSize(page.pageSize);
    const offset = parsePageToken(page.pageToken);
    const secret = await this.repository.getByName(resource);

    if (secret == null) {
      throw new SecretManagerError('NOT_FOUND', `Secret ${resource} not found`, resource);
    }

    const listed = await this.repository.listVersions(resource, limit, offset);
    const next = offset + listed.versions.length;

    return {
      versions: listed.versions.map(toVersionView),
      totalSize: listed.total,
      nextPageToken: next < listed.total ? String(next) : null,
    };
  }

  async changeVersionState(
    locator: SecretVersionLocator,
    requestedName: string,
    etag: string | null,
    transition: VersionTransition
  ): Promise<SecretVersionView> {
    const resource = formatSecretName(locator.secret);

    return this.mutex.runExclusively(resource, async () => {
      const stored = await this.loadVersion(locator, requestedName);
      const versionName = formatSecretVersionName(stored.secretName, stored.number);

      if (etag != null && etag !== etagFromGeneration(stored.generation)) {
        throw new SecretManagerError('ABORTED', `etag does not match SecretVersion ${versionName}`);
      }

      const target = nextVersionState(stored.state, transition, versionName);

      if (target == null) {
        return toVersionView(stored);
      }

      const patch = {
        state: target,
        generation: stored.generation + 1,
        ...(target === 'DESTROYED'
          ? { destroyTime: this.clock().toISOString(), payloadData: null, payloadCrc32c: null }
          : {}),
      };

      await this.repository.updateVersion(stored.secretName, stored.number, patch);

      return toVersionView({ ...stored, ...patch });
    });
  }

  private async loadVersion(
    locator: SecretVersionLocator,
    requestedName: string
  ): Promise<StoredVersion> {
    const resource = formatSecretName(locator.secret);
    const secret = await this.repository.getByName(resource);

    if (secret == null) {
      throw new SecretManagerError('NOT_FOUND', `Secret ${resource} not found`, resource);
    }

    const newest = await this.repository.findNewestVersion(resource);
    const number = resolveVersionNumber(
      locator.selector,
      newest?.number ?? null,
      secret.spec.versionAliases,
      requestedName
    );
    const stored = await this.repository.findVersion(resource, number);

    if (stored == null) {
      throw new SecretManagerError(
        'NOT_FOUND',
        `SecretVersion ${requestedName} not found`,
        requestedName,
        'SecretVersion'
      );
    }

    return stored;
  }
}

function toView(stored: {
  name: string;
  createTime: string;
  generation: number;
  spec: SecretView['spec'];
}): SecretView {
  return {
    name: stored.name,
    createTime: stored.createTime,
    etag: etagFromGeneration(stored.generation),
    spec: stored.spec,
  };
}

function toVersionView(stored: StoredVersion): SecretVersionView {
  return {
    name: formatSecretVersionName(stored.secretName, stored.number),
    state: stored.state,
    createTime: stored.createTime,
    destroyTime: stored.destroyTime,
    etag: etagFromGeneration(stored.generation),
    clientSpecifiedPayloadChecksum: stored.clientSpecifiedPayloadChecksum,
  };
}
