/**
 * Bucket Service - business logic for Cloud Storage bucket operations
 */

import type { BucketRepository } from './bucket-repository.ts';
import type { ObjectRepository } from './object-repository.ts';
import type { BucketListResponse, BucketResponse } from './types.ts';
import {
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
  | 'FAILED_PRECONDITION';

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

  constructor(bucketRepo: BucketRepository, objectRepo: ObjectRepository) {
    this.bucketRepo = bucketRepo;
    this.objectRepo = objectRepo;
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

  async getBucket(name: string): Promise<BucketResponse> {
    const record = await this.bucketRepo.getBucketByName(name);

    if (!record) {
      throw new GcsError('NOT_FOUND', `Bucket ${name} not found`);
    }

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

  async patchBucket(name: string, body: unknown): Promise<BucketResponse> {
    const parsed = UpdateBucketRequestSchema.safeParse(body);

    if (!parsed.success) {
      throw new GcsError('INVALID_ARGUMENT', `Invalid update request: ${parsed.error.message}`);
    }

    const existing = await this.bucketRepo.getBucketByName(name);

    if (!existing) {
      throw new GcsError('NOT_FOUND', `Bucket ${name} not found`);
    }

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
  }

  async updateBucket(name: string, body: unknown): Promise<BucketResponse> {
    const parsed = UpdateBucketRequestSchema.safeParse(body);

    if (!parsed.success) {
      throw new GcsError('INVALID_ARGUMENT', `Invalid update request: ${parsed.error.message}`);
    }

    const existing = await this.bucketRepo.getBucketByName(name);

    if (!existing) {
      throw new GcsError('NOT_FOUND', `Bucket ${name} not found`);
    }

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
  }

  async deleteBucket(name: string): Promise<void> {
    const existing = await this.bucketRepo.getBucketByName(name);

    if (!existing) {
      throw new GcsError('NOT_FOUND', `Bucket ${name} not found`);
    }

    const objectCount = await this.objectRepo.countObjectsInBucket(name);

    if (objectCount > 0) {
      throw new GcsError(
        'FAILED_PRECONDITION',
        `Cannot delete bucket ${name}: bucket is not empty (contains ${objectCount} objects)`
      );
    }

    await this.bucketRepo.deleteBucket(name);
  }
}
