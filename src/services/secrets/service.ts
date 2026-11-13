/**
 * Secret Manager rules. No HTTP and no protobuf.
 */

import { ResourceMutex } from '@/shared/utils/resource-mutex.ts';
import type { SecretRepository, StoredVersion } from './repository.ts';
import type {
  AccessedSecret,
  PayloadInput,
  SecretName,
  SecretSpecInput,
  SecretUpdate,
  SecretVersionLocator,
  SecretVersionView,
  SecretView,
} from './types.ts';
import {
  admitPayload,
  applySecretUpdate,
  etagFromGeneration,
  formatSecretName,
  formatSecretParent,
  formatSecretVersionName,
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

  async updateSecret(name: SecretName, update: SecretUpdate): Promise<SecretView> {
    const resource = formatSecretName(name);

    return this.mutex.runExclusively(resource, async () => {
      const stored = await this.repository.getByName(resource);

      if (stored == null) {
        throw new SecretManagerError('NOT_FOUND', `Secret ${resource} not found`, resource);
      }

      if (update.etag != null && update.etag !== etagFromGeneration(stored.generation)) {
        throw new SecretManagerError(
          'ABORTED',
          `The etag does not match the current etag of ${resource}`
        );
      }

      const spec = applySecretUpdate(stored.spec, update.spec, update.fields, this.clock());

      if (Bun.deepEquals(spec, stored.spec)) {
        return toView(stored);
      }

      const updated = await this.repository.update({
        ...stored,
        generation: stored.generation + 1,
        spec,
      });

      return toView(updated);
    });
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
        `SecretVersion ${requestedName} is not readable`,
        requestedName
      );
    }

    return {
      name: formatSecretVersionName(stored.secretName, stored.number),
      data: new Uint8Array(Buffer.from(stored.payloadData, 'base64')),
      crc32c: stored.payloadCrc32c,
    };
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
    etag: etagFromGeneration(stored.generation),
    clientSpecifiedPayloadChecksum: stored.clientSpecifiedPayloadChecksum,
  };
}
