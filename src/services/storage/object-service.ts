/**
 * Object Service - business logic for Cloud Storage object operations
 */

import type { BlobStore } from './blob-store.ts';
import type { BucketRepository } from './bucket-repository.ts';
import { GcsError } from './bucket-service.ts';
import type { ObjectRepository } from './object-repository.ts';
import type { ObjectListResponse, ObjectResponse, RewriteResponse } from './types.ts';
import { ComposeRequestSchema, objectRecordToResponse, requestToObjectRecord } from './types.ts';

export class ObjectService {
  private objectRepo: ObjectRepository;
  private bucketRepo: BucketRepository;
  private blobStore: BlobStore;
  private generationCounter = 0;

  constructor(objectRepo: ObjectRepository, bucketRepo: BucketRepository, blobStore: BlobStore) {
    this.objectRepo = objectRepo;
    this.bucketRepo = bucketRepo;
    this.blobStore = blobStore;
  }

  async insertObject(
    bucket: string,
    name: string,
    data: Uint8Array,
    options?: {
      contentType?: string;
      metadata?: Record<string, string>;
      contentEncoding?: string;
      contentDisposition?: string;
      contentLanguage?: string;
      cacheControl?: string;
    }
  ): Promise<ObjectResponse> {
    await this.ensureBucketExists(bucket);

    // Delete existing object with the same name (overwrite)
    const existing = await this.objectRepo.getObject(bucket, name);

    if (existing) {
      await this.blobStore.delete(existing.blobPath);
      await this.objectRepo.deleteObject(bucket, name);
    }

    this.generationCounter++;
    const generation = String(Date.now() * 1000 + this.generationCounter);
    const storeResult = await this.blobStore.store(bucket, name, generation, data);

    const bucketRecord = await this.bucketRepo.getBucketByName(bucket);

    const objectData: Parameters<typeof requestToObjectRecord>[2] = {
      size: storeResult.size,
      md5Hash: storeResult.md5Hash,
      crc32c: storeResult.crc32c,
      blobPath: storeResult.blobPath,
    };

    if (options?.contentType) objectData.contentType = options.contentType;
    if (options?.metadata) objectData.metadata = options.metadata;
    if (bucketRecord?.storageClass) objectData.storageClass = bucketRecord.storageClass;
    if (options?.contentEncoding) objectData.contentEncoding = options.contentEncoding;
    if (options?.contentDisposition) objectData.contentDisposition = options.contentDisposition;
    if (options?.contentLanguage) objectData.contentLanguage = options.contentLanguage;
    if (options?.cacheControl) objectData.cacheControl = options.cacheControl;

    const recordData = requestToObjectRecord(bucket, name, objectData);

    // Override generation to match the one used for blob storage
    const record = await this.objectRepo.createObject({ ...recordData, generation });

    return objectRecordToResponse(record);
  }

  async getObject(bucket: string, name: string): Promise<ObjectResponse> {
    const record = await this.objectRepo.getObject(bucket, name);

    if (!record) {
      throw new GcsError('NOT_FOUND', `Object ${name} not found in bucket ${bucket}`);
    }

    return objectRecordToResponse(record);
  }

  async getObjectMedia(
    bucket: string,
    name: string
  ): Promise<{ data: Uint8Array; contentType: string }> {
    const record = await this.objectRepo.getObject(bucket, name);

    if (!record) {
      throw new GcsError('NOT_FOUND', `Object ${name} not found in bucket ${bucket}`);
    }

    const data = await this.blobStore.retrieve(record.blobPath);

    if (!data) {
      throw new GcsError('NOT_FOUND', `Object data for ${name} not found`);
    }

    return { data, contentType: record.contentType };
  }

  async listObjects(
    bucket: string,
    options?: {
      prefix?: string;
      delimiter?: string;
      maxResults?: number;
      pageToken?: string;
    }
  ): Promise<ObjectListResponse> {
    await this.ensureBucketExists(bucket);

    const result = await this.objectRepo.listObjects(bucket, options);

    const response: ObjectListResponse = {
      kind: 'storage#objects',
      items: result.objects.map(objectRecordToResponse),
    };

    if (result.prefixes.length > 0) {
      response.prefixes = result.prefixes;
    }

    if (result.nextPageToken) {
      response.nextPageToken = result.nextPageToken;
    }

    return response;
  }

  async patchObject(
    bucket: string,
    name: string,
    body: { metadata?: Record<string, string>; contentType?: string }
  ): Promise<ObjectResponse> {
    const existing = await this.objectRepo.getObject(bucket, name);

    if (!existing) {
      throw new GcsError('NOT_FOUND', `Object ${name} not found in bucket ${bucket}`);
    }

    const updates: Record<string, unknown> = {};

    if (body.metadata !== undefined) {
      updates.metadata = JSON.stringify(body.metadata);
    }

    if (body.contentType !== undefined) {
      updates.contentType = body.contentType;
    }

    updates.metageneration = existing.metageneration + 1;
    updates.updated = new Date().toISOString();

    const updated = await this.objectRepo.updateObject(bucket, name, updates);

    if (!updated) {
      throw new GcsError('NOT_FOUND', `Object ${name} not found in bucket ${bucket}`);
    }

    return objectRecordToResponse(updated);
  }

  async updateObject(
    bucket: string,
    name: string,
    body: { metadata?: Record<string, string>; contentType?: string }
  ): Promise<ObjectResponse> {
    const existing = await this.objectRepo.getObject(bucket, name);

    if (!existing) {
      throw new GcsError('NOT_FOUND', `Object ${name} not found in bucket ${bucket}`);
    }

    // PUT performs full replacement: omitted fields reset to defaults
    const updates: Record<string, unknown> = {
      metadata: body.metadata ? JSON.stringify(body.metadata) : null,
      contentType: body.contentType ?? 'application/octet-stream',
      metageneration: existing.metageneration + 1,
      updated: new Date().toISOString(),
    };

    const updated = await this.objectRepo.updateObject(bucket, name, updates);

    if (!updated) {
      throw new GcsError('NOT_FOUND', `Object ${name} not found in bucket ${bucket}`);
    }

    return objectRecordToResponse(updated);
  }

  async deleteObject(bucket: string, name: string): Promise<void> {
    const record = await this.objectRepo.getObject(bucket, name);

    if (!record) {
      throw new GcsError('NOT_FOUND', `Object ${name} not found in bucket ${bucket}`);
    }

    await this.blobStore.delete(record.blobPath);
    await this.objectRepo.deleteObject(bucket, name);
  }

  async copyObject(
    srcBucket: string,
    srcName: string,
    dstBucket: string,
    dstName: string
  ): Promise<ObjectResponse> {
    await this.ensureBucketExists(dstBucket);

    const srcRecord = await this.objectRepo.getObject(srcBucket, srcName);

    if (!srcRecord) {
      throw new GcsError('NOT_FOUND', `Source object ${srcName} not found in bucket ${srcBucket}`);
    }

    const srcData = await this.blobStore.retrieve(srcRecord.blobPath);

    if (!srcData) {
      throw new GcsError('NOT_FOUND', `Source object data for ${srcName} not found`);
    }

    const copyOptions: Parameters<typeof this.insertObject>[3] = {
      contentType: srcRecord.contentType,
    };

    if (srcRecord.metadata) {
      copyOptions.metadata = JSON.parse(srcRecord.metadata) as Record<string, string>;
    }

    return this.insertObject(dstBucket, dstName, srcData, copyOptions);
  }

  async rewriteObject(
    srcBucket: string,
    srcName: string,
    dstBucket: string,
    dstName: string
  ): Promise<RewriteResponse> {
    const resource = await this.copyObject(srcBucket, srcName, dstBucket, dstName);

    return {
      kind: 'storage#rewriteResponse',
      totalBytesRewritten: resource.size,
      objectSize: resource.size,
      done: true,
      resource,
    };
  }

  async composeObjects(
    bucket: string,
    destinationName: string,
    body: unknown
  ): Promise<ObjectResponse> {
    const parsed = ComposeRequestSchema.safeParse(body);

    if (!parsed.success) {
      throw new GcsError('INVALID_ARGUMENT', `Invalid compose request: ${parsed.error.message}`);
    }

    await this.ensureBucketExists(bucket);

    const chunks: Uint8Array[] = [];

    for (const src of parsed.data.sourceObjects) {
      const record = await this.objectRepo.getObject(bucket, src.name);

      if (!record) {
        throw new GcsError('NOT_FOUND', `Source object ${src.name} not found in bucket ${bucket}`);
      }

      const data = await this.blobStore.retrieve(record.blobPath);

      if (!data) {
        throw new GcsError('NOT_FOUND', `Source object data for ${src.name} not found`);
      }

      chunks.push(data);
    }

    const totalSize = chunks.reduce((sum, c) => sum + c.length, 0);
    const concatenated = new Uint8Array(totalSize);
    let offset = 0;

    for (const chunk of chunks) {
      concatenated.set(chunk, offset);
      offset += chunk.length;
    }

    const composeOptions: Parameters<typeof this.insertObject>[3] = {};

    if (parsed.data.destination?.contentType) {
      composeOptions.contentType = parsed.data.destination.contentType;
    }

    if (parsed.data.destination?.metadata) {
      composeOptions.metadata = parsed.data.destination.metadata;
    }

    return this.insertObject(bucket, destinationName, concatenated, composeOptions);
  }

  private async ensureBucketExists(bucket: string): Promise<void> {
    const record = await this.bucketRepo.getBucketByName(bucket);

    if (!record) {
      throw new GcsError('NOT_FOUND', `Bucket ${bucket} not found`);
    }
  }
}
