/**
 * Secret Manager rules. No HTTP and no protobuf.
 */

import { ResourceMutex } from '@/shared/utils/resource-mutex.ts';
import type { SecretRepository } from './repository.ts';
import type { SecretName, SecretSpecInput, SecretView } from './types.ts';
import {
  etagFromGeneration,
  formatSecretName,
  formatSecretParent,
  resolveSpec,
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
