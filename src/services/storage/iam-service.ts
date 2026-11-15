/**
 * Bucket IAM. Policies are stored and returned. They are not evaluated.
 */

import type { ResourceMutex } from '@/shared/utils/resource-mutex.ts';
import type { BucketRepository } from './bucket-repository.ts';
import { GcsError } from './bucket-service.ts';
import type { IamPolicyRepository } from './iam-repository.ts';
import type { PolicyBinding, PolicyResponse, TestIamPermissionsResponse } from './types.ts';
import { bucketIamResourceId, SetIamPolicyRequestSchema } from './types.ts';

export class IamService {
  private bucketRepo: BucketRepository;
  private iamRepo: IamPolicyRepository;
  private writes: ResourceMutex;

  constructor(bucketRepo: BucketRepository, iamRepo: IamPolicyRepository, writes: ResourceMutex) {
    this.bucketRepo = bucketRepo;
    this.iamRepo = iamRepo;
    this.writes = writes;
  }

  async getIamPolicy(bucket: string): Promise<PolicyResponse> {
    await this.ensureBucket(bucket);

    const resourceId = bucketIamResourceId(bucket);
    const stored = await this.iamRepo.getByResourceId(resourceId);

    if (!stored) {
      return emptyPolicy(resourceId);
    }

    return policyFromRecord(stored.resourceId, stored.version, stored.etag, stored.bindings);
  }

  async setIamPolicy(bucket: string, body: unknown): Promise<PolicyResponse> {
    const parsed = SetIamPolicyRequestSchema.safeParse(body);

    if (!parsed.success) {
      throw new GcsError('INVALID_ARGUMENT', `Invalid IAM policy: ${parsed.error.message}`);
    }

    const resourceId = bucketIamResourceId(bucket);

    // Same lock as bucket delete. The bucket is checked again inside it so a
    // delete that ran while this set was queued cannot be followed by a write.
    return this.writes.runExclusively(resourceId, async () => {
      await this.ensureBucket(bucket);

      const stored = await this.iamRepo.getByResourceId(resourceId);
      const currentEtag = stored ? stored.etag : emptyPolicyEtag(resourceId);

      // A missing or empty etag is an unconditional write. A non-empty etag must match.
      if (isPresentEtag(parsed.data.etag) && parsed.data.etag !== currentEtag) {
        throw new GcsError(
          'ABORTED',
          'The IAM policy etag does not match. Re-read the policy and retry.'
        );
      }

      // A missing version is 1. A version the caller sent is stored as given.
      const version = parsed.data.version != null ? parsed.data.version : 1;
      const bindings = parsed.data.bindings ?? [];
      const etag = rotateEtag(currentEtag);
      const saved = await this.iamRepo.save({
        resourceId,
        version,
        etag,
        bindings: JSON.stringify(bindings),
      });

      return policyFromRecord(saved.resourceId, saved.version, saved.etag, saved.bindings);
    });
  }

  async testIamPermissions(
    bucket: string,
    permissions: string[]
  ): Promise<TestIamPermissionsResponse> {
    await this.ensureBucket(bucket);

    return {
      kind: 'storage#testIamPermissionsResponse',
      permissions,
    };
  }

  private async ensureBucket(bucket: string): Promise<void> {
    const record = await this.bucketRepo.getBucketByName(bucket);

    if (!record) {
      throw new GcsError('NOT_FOUND', `Bucket ${bucket} not found`);
    }
  }
}

function emptyPolicy(resourceId: string): PolicyResponse {
  // No stored policy means no bindings. Real GCS also returns the project's
  // legacy bucket roles. This emulator has no project members to put there.
  return {
    kind: 'storage#policy',
    resourceId,
    version: 1,
    etag: emptyPolicyEtag(resourceId),
    bindings: [],
  };
}

function policyFromRecord(
  resourceId: string,
  version: number,
  etag: string,
  bindings: string
): PolicyResponse {
  return {
    kind: 'storage#policy',
    resourceId,
    version,
    etag,
    bindings: JSON.parse(bindings) as PolicyBinding[],
  };
}

function isPresentEtag(etag: string | undefined): etag is string {
  return typeof etag === 'string' && etag.length > 0;
}

function emptyPolicyEtag(resourceId: string): string {
  return btoa(`kinglet-empty-iam:${resourceId}`);
}

function freshEtag(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));

  return Buffer.from(bytes).toString('base64');
}

function rotateEtag(previous: string): string {
  let next = freshEtag();

  while (next === previous) {
    next = freshEtag();
  }

  return next;
}
