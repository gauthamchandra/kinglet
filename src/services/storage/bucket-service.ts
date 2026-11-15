/**
 * Bucket Service - business logic for Cloud Storage bucket operations
 */

import type { ResourceMutex } from '@/shared/utils/resource-mutex.ts';
import type { BucketRepository } from './bucket-repository.ts';
import type { IamPolicyRepository } from './iam-repository.ts';
import type { ObjectRepository } from './object-repository.ts';
import type { BucketListResponse, BucketRecord, BucketResponse } from './types.ts';
import {
  bucketIamResourceId,
  bucketRecordToResponse,
  CreateBucketRequestSchema,
  DEFAULT_STORAGE_CLASS,
  parseBucketName,
  requestToBucketRecord,
  UpdateBucketRequestSchema,
} from './types.ts';

export type GcsErrorCode =
  | 'NOT_FOUND'
  | 'ALREADY_EXISTS'
  | 'INVALID_ARGUMENT'
  | 'BUCKET_NOT_EMPTY'
  | 'CONDITION_NOT_MET'
  | 'NOT_MODIFIED'
  | 'PERMISSION_DENIED'
  | 'ABORTED';

/** Query preconditions on `buckets.get`, `patch`, `update`, and `delete`. */
export interface BucketMetagenerationPreconditions {
  ifMetagenerationMatch?: string;
  ifMetagenerationNotMatch?: string;
}

export class GcsError extends Error {
  readonly code: GcsErrorCode;

  constructor(code: GcsErrorCode, message: string) {
    super(message);
    this.name = 'GcsError';
    this.code = code;
  }
}

export class BucketService {
  private bucketRepo: BucketRepository;
  private objectRepo: ObjectRepository;
  private iamRepo: IamPolicyRepository;
  private writes: ResourceMutex;

  constructor(
    bucketRepo: BucketRepository,
    objectRepo: ObjectRepository,
    iamRepo: IamPolicyRepository,
    writes: ResourceMutex
  ) {
    this.bucketRepo = bucketRepo;
    this.objectRepo = objectRepo;
    this.iamRepo = iamRepo;
    this.writes = writes;
  }

  async createBucket(project: string, body: unknown): Promise<BucketResponse> {
    const parsed = CreateBucketRequestSchema.safeParse(body);

    if (!parsed.success) {
      throw new GcsError('INVALID_ARGUMENT', `Invalid bucket request: ${parsed.error.message}`);
    }

    try {
      parseBucketName(parsed.data.name);
    } catch {
      throw new GcsError('INVALID_ARGUMENT', `Invalid bucket name: ${parsed.data.name}`);
    }

    const existing = await this.bucketRepo.getBucketByName(parsed.data.name);

    if (existing) {
      throw new GcsError('ALREADY_EXISTS', `Bucket ${parsed.data.name} already exists`);
    }

    const record = requestToBucketRecord(parsed.data.name, parsed.data, project);
    const created = await this.bucketRepo.createBucket(record);

    return bucketRecordToResponse(created);
  }

  async getBucket(
    name: string,
    preconditions?: BucketMetagenerationPreconditions
  ): Promise<BucketResponse> {
    const record = await this.loadBucket(name, preconditions, 'NOT_MODIFIED');

    return bucketRecordToResponse(record);
  }

  async listBuckets(
    project: string,
    pageSize?: number,
    pageToken?: string
  ): Promise<BucketListResponse> {
    const result = await this.bucketRepo.listBuckets(project, pageSize, pageToken);

    const response: BucketListResponse = {
      kind: 'storage#buckets',
      items: result.buckets.map(bucketRecordToResponse),
    };

    if (result.nextPageToken) {
      response.nextPageToken = result.nextPageToken;
    }

    return response;
  }

  async patchBucket(
    name: string,
    body: unknown,
    preconditions?: BucketMetagenerationPreconditions
  ): Promise<BucketResponse> {
    const parsed = UpdateBucketRequestSchema.safeParse(body);

    if (!parsed.success) {
      throw new GcsError('INVALID_ARGUMENT', `Invalid update request: ${parsed.error.message}`);
    }

    return this.writes.runExclusively(bucketIamResourceId(name), async () => {
      const existing = await this.loadBucket(name, preconditions);
      const updates: Record<string, unknown> = {};

      if (parsed.data.storageClass !== undefined) {
        updates.storageClass = parsed.data.storageClass;
      }

      if (parsed.data.versioning !== undefined) {
        updates.versioning = JSON.stringify(parsed.data.versioning);
      }

      if (parsed.data.labels !== undefined) {
        updates.labels = JSON.stringify(parsed.data.labels);
      }

      if (parsed.data.cors !== undefined) {
        updates.cors = JSON.stringify(parsed.data.cors);
      }

      if (parsed.data.lifecycle !== undefined) {
        updates.lifecycle = JSON.stringify(parsed.data.lifecycle);
      }

      updates.metageneration = existing.metageneration + 1;
      updates.updated = new Date().toISOString();

      const updated = await this.bucketRepo.updateBucket(name, updates);

      if (!updated) {
        throw new GcsError('NOT_FOUND', `Bucket ${name} not found`);
      }

      return bucketRecordToResponse(updated);
    });
  }

  async updateBucket(
    name: string,
    body: unknown,
    preconditions?: BucketMetagenerationPreconditions
  ): Promise<BucketResponse> {
    const parsed = UpdateBucketRequestSchema.safeParse(body);

    if (!parsed.success) {
      throw new GcsError('INVALID_ARGUMENT', `Invalid update request: ${parsed.error.message}`);
    }

    return this.writes.runExclusively(bucketIamResourceId(name), async () => {
      const existing = await this.loadBucket(name, preconditions);

      // PUT performs full replacement: omitted fields reset to defaults
      const updates: Record<string, unknown> = {
        storageClass: parsed.data.storageClass ?? DEFAULT_STORAGE_CLASS,
        versioning: parsed.data.versioning ? JSON.stringify(parsed.data.versioning) : null,
        labels: parsed.data.labels ? JSON.stringify(parsed.data.labels) : null,
        cors: parsed.data.cors ? JSON.stringify(parsed.data.cors) : null,
        lifecycle: parsed.data.lifecycle ? JSON.stringify(parsed.data.lifecycle) : null,
        metageneration: existing.metageneration + 1,
        updated: new Date().toISOString(),
      };

      const updated = await this.bucketRepo.updateBucket(name, updates);

      if (!updated) {
        throw new GcsError('NOT_FOUND', `Bucket ${name} not found`);
      }

      return bucketRecordToResponse(updated);
    });
  }

  async deleteBucket(
    name: string,
    preconditions?: BucketMetagenerationPreconditions
  ): Promise<void> {
    await this.writes.runExclusively(bucketIamResourceId(name), async () => {
      await this.loadBucket(name, preconditions);

      const objectCount = await this.objectRepo.countObjectsInBucket(name);

      if (objectCount > 0) {
        throw new GcsError(
          'BUCKET_NOT_EMPTY',
          `Cannot delete bucket ${name}: bucket is not empty (contains ${objectCount} objects)`
        );
      }

      await this.bucketRepo.deleteBucket(name);
      await this.iamRepo.deleteByResourceId(bucketIamResourceId(name));
    });
  }

  /**
   * Load a bucket and apply metageneration preconditions.
   *
   * A malformed query value is `INVALID_ARGUMENT` before the lookup, so a bad
   * precondition does not hide behind `NOT_FOUND`. A missing bucket is
   * `NOT_FOUND` even when the precondition would have failed.
   *
   * A failing `ifMetagenerationNotMatch` on GET is `NOT_MODIFIED` (HTTP 304).
   * The same miss on patch, update, and delete stays `CONDITION_NOT_MET`.
   */
  private async loadBucket(
    name: string,
    preconditions?: BucketMetagenerationPreconditions,
    notMatchCode: 'CONDITION_NOT_MET' | 'NOT_MODIFIED' = 'CONDITION_NOT_MET'
  ): Promise<BucketRecord> {
    const match = parseMetagenerationQuery(
      preconditions?.ifMetagenerationMatch,
      'ifMetagenerationMatch'
    );
    const notMatch = parseMetagenerationQuery(
      preconditions?.ifMetagenerationNotMatch,
      'ifMetagenerationNotMatch'
    );

    const record = await this.bucketRepo.getBucketByName(name);

    if (!record) {
      throw new GcsError('NOT_FOUND', `Bucket ${name} not found`);
    }

    if (match != null && record.metageneration !== match) {
      throw new GcsError(
        'CONDITION_NOT_MET',
        `Bucket metageneration ${String(record.metageneration)} does not match ifMetagenerationMatch ${String(match)}`
      );
    }

    if (notMatch != null && record.metageneration === notMatch) {
      throw new GcsError(
        notMatchCode,
        `Bucket metageneration ${String(record.metageneration)} matches ifMetagenerationNotMatch`
      );
    }

    return record;
  }
}

/**
 * Parse a discovery `format: int64` query value.
 *
 * Absent and empty mean the precondition was not sent. Anything that is not a
 * canonical decimal integer (no sign, no leading zeros) is `INVALID_ARGUMENT`.
 */
function parseMetagenerationQuery(value: string | undefined, field: string): number | undefined {
  if (value == null || value === '') {
    return undefined;
  }

  if (!/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new GcsError('INVALID_ARGUMENT', `Invalid ${field}: ${value}`);
  }

  const parsed = Number(value);

  if (!Number.isSafeInteger(parsed)) {
    throw new GcsError('INVALID_ARGUMENT', `Invalid ${field}: ${value}`);
  }

  return parsed;
}
