/**
 * Object HTTP route handlers for Cloud Storage
 */

import type {
  RouteContext,
  RouteDefinition,
  RouteRequest,
  RouteResponse,
} from '@/core/gateway/request-router.ts';
import { ResponseUtils, StandardResponseFormatter } from '@/core/gateway/response-handlers.ts';
import type { Logger } from '@/shared/utils/logger.ts';
import { handleGcsError } from './error-handler.ts';
import type { ObjectService } from './object-service.ts';
import { parseObjectName } from './types.ts';

interface ResumableUpload {
  bucket: string;
  name: string;
  contentType: string;
  createdAt: number;
}

const RESUMABLE_UPLOAD_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const MAX_PENDING_UPLOADS = 10_000;

export class ObjectHandlers {
  private service: ObjectService;
  private responseUtils: ResponseUtils;
  private resumableUploads = new Map<string, ResumableUpload>();
  private uploadCounter = 0;

  constructor(service: ObjectService, logger: Logger) {
    this.service = service;
    const formatter = new StandardResponseFormatter(logger);
    this.responseUtils = new ResponseUtils(formatter);
  }

  getRoutes(): RouteDefinition[] {
    return [
      {
        id: 'storage.objects.insert',
        method: 'POST',
        path: '/upload/storage/v1/b/:bucket/o',
        handler: (req, ctx) => this.handleInsertObject(req, ctx),
      },
      {
        id: 'storage.objects.resumable',
        method: 'PUT',
        path: '/upload/storage/v1/b/:bucket/o',
        handler: (req, ctx) => this.handleResumableUpload(req, ctx),
      },
      {
        id: 'storage.objects.get',
        method: 'GET',
        path: '/storage/v1/b/:bucket/o/:object',
        handler: (req, ctx) => this.handleGetObject(req, ctx),
      },
      {
        id: 'storage.objects.list',
        method: 'GET',
        path: '/storage/v1/b/:bucket/o',
        handler: (req, ctx) => this.handleListObjects(req, ctx),
      },
      {
        id: 'storage.objects.delete',
        method: 'DELETE',
        path: '/storage/v1/b/:bucket/o/:object',
        handler: (req, ctx) => this.handleDeleteObject(req, ctx),
      },
      {
        id: 'storage.objects.patch',
        method: 'PATCH',
        path: '/storage/v1/b/:bucket/o/:object',
        handler: (req, ctx) => this.handlePatchObject(req, ctx),
      },
      {
        id: 'storage.objects.update',
        method: 'PUT',
        path: '/storage/v1/b/:bucket/o/:object',
        handler: (req, ctx) => this.handleUpdateObject(req, ctx),
      },
      {
        id: 'storage.objects.compose',
        method: 'POST',
        path: '/storage/v1/b/:bucket/o/:object/compose',
        handler: (req, ctx) => this.handleComposeObject(req, ctx),
      },
      {
        id: 'storage.objects.copy',
        method: 'POST',
        path: '/storage/v1/b/:srcBucket/o/:srcObject/copyTo/b/:dstBucket/o/:dstObject',
        handler: (req, ctx) => this.handleCopyObject(req, ctx),
      },
      {
        id: 'storage.objects.rewrite',
        method: 'POST',
        path: '/storage/v1/b/:srcBucket/o/:srcObject/rewriteTo/b/:dstBucket/o/:dstObject',
        handler: (req, ctx) => this.handleRewriteObject(req, ctx),
      },
    ];
  }

  private async handleInsertObject(req: RouteRequest, _ctx: RouteContext): Promise<RouteResponse> {
    try {
      const bucket = req.params.bucket ?? '';
      const uploadType = req.query.uploadType as string | undefined;

      // Resumable upload initiation: return Location header with upload_id
      if (uploadType === 'resumable') {
        const body = (req.body ?? {}) as { name?: string; contentType?: string };
        const name = parseObjectName(body.name ?? (req.query.name as string) ?? '');
        // Use contentType from the JSON body only — the request's Content-Type header
        // describes the initiation request itself (application/json), not the object.
        const contentType = body.contentType ?? 'application/octet-stream';

        this.evictStaleUploads();

        this.uploadCounter++;
        const uploadId = String(this.uploadCounter);

        this.resumableUploads.set(uploadId, { bucket, name, contentType, createdAt: Date.now() });

        const origin = req.originalRequest ? new URL(req.originalRequest.url).origin : '';

        return {
          status: 200,
          headers: {
            location: `${origin}/upload/storage/v1/b/${bucket}/o?uploadType=resumable&upload_id=${uploadId}`,
          },
          body: {},
        };
      }

      const name = parseObjectName((req.query.name as string) ?? '');
      const contentType = req.headers['content-type'] ?? 'application/octet-stream';

      let data: Uint8Array;

      if (req.originalRequest) {
        data = new Uint8Array(await req.originalRequest.arrayBuffer());
      } else {
        data = new Uint8Array(0);
      }

      const result = await this.service.insertObject(bucket, name, data, { contentType });
      return this.responseUtils.success(result);
    } catch (err) {
      return this.handleError(err);
    }
  }

  private async handleResumableUpload(
    req: RouteRequest,
    _ctx: RouteContext
  ): Promise<RouteResponse> {
    try {
      const uploadId = req.query.upload_id as string | undefined;

      if (!uploadId) {
        return this.responseUtils.badRequest('Missing upload_id');
      }

      const upload = this.resumableUploads.get(uploadId);

      if (!upload) {
        return this.responseUtils.notFound('Upload', `Upload ${uploadId} not found`);
      }

      this.resumableUploads.delete(uploadId);

      let data: Uint8Array;

      if (req.originalRequest) {
        data = new Uint8Array(await req.originalRequest.arrayBuffer());
      } else {
        data = new Uint8Array(0);
      }

      const result = await this.service.insertObject(upload.bucket, upload.name, data, {
        contentType: upload.contentType,
      });

      return this.responseUtils.success(result);
    } catch (err) {
      return this.handleError(err);
    }
  }

  private async handleGetObject(req: RouteRequest, _ctx: RouteContext): Promise<RouteResponse> {
    try {
      const bucket = req.params.bucket ?? '';
      const name = parseObjectName(req.params.object ?? '');
      const alt = req.query.alt as string | undefined;

      if (alt === 'media') {
        const data = await this.service.getObjectMedia(bucket, name);
        const metadata = await this.service.getObject(bucket, name);

        return {
          status: 200,
          headers: {
            'content-type': metadata.contentType,
            'content-length': String(data.length),
          },
          body: data,
        };
      }

      const result = await this.service.getObject(bucket, name);
      return this.responseUtils.success(result);
    } catch (err) {
      return this.handleError(err);
    }
  }

  private async handleListObjects(req: RouteRequest, _ctx: RouteContext): Promise<RouteResponse> {
    try {
      const bucket = req.params.bucket ?? '';
      const prefix = (req.query.prefix as string) || undefined;
      const delimiter = (req.query.delimiter as string) || undefined;
      const maxResultsRaw = req.query.maxResults
        ? parseInt(req.query.maxResults as string, 10)
        : undefined;
      const maxResults =
        maxResultsRaw && !Number.isNaN(maxResultsRaw) && maxResultsRaw > 0
          ? maxResultsRaw
          : undefined;
      const pageToken = (req.query.pageToken as string) || undefined;

      const listOptions: Parameters<typeof this.service.listObjects>[1] = {};

      if (prefix) listOptions.prefix = prefix;
      if (delimiter) listOptions.delimiter = delimiter;
      if (maxResults) listOptions.maxResults = maxResults;
      if (pageToken) listOptions.pageToken = pageToken;

      const result = await this.service.listObjects(bucket, listOptions);
      return this.responseUtils.success(result);
    } catch (err) {
      return this.handleError(err);
    }
  }

  private async handleDeleteObject(req: RouteRequest, _ctx: RouteContext): Promise<RouteResponse> {
    try {
      const bucket = req.params.bucket ?? '';
      const name = parseObjectName(req.params.object ?? '');

      await this.service.deleteObject(bucket, name);
      return { status: 204 };
    } catch (err) {
      return this.handleError(err);
    }
  }

  private async handlePatchObject(req: RouteRequest, _ctx: RouteContext): Promise<RouteResponse> {
    try {
      const bucket = req.params.bucket ?? '';
      const name = parseObjectName(req.params.object ?? '');
      const body = (req.body ?? {}) as { metadata?: Record<string, string>; contentType?: string };

      const result = await this.service.patchObject(bucket, name, body);
      return this.responseUtils.success(result);
    } catch (err) {
      return this.handleError(err);
    }
  }

  private async handleUpdateObject(req: RouteRequest, _ctx: RouteContext): Promise<RouteResponse> {
    try {
      const bucket = req.params.bucket ?? '';
      const name = parseObjectName(req.params.object ?? '');
      const body = (req.body ?? {}) as { metadata?: Record<string, string>; contentType?: string };

      const result = await this.service.updateObject(bucket, name, body);
      return this.responseUtils.success(result);
    } catch (err) {
      return this.handleError(err);
    }
  }

  private async handleComposeObject(req: RouteRequest, _ctx: RouteContext): Promise<RouteResponse> {
    try {
      const bucket = req.params.bucket ?? '';
      const destination = parseObjectName(req.params.object ?? '');

      const result = await this.service.composeObjects(bucket, destination, req.body);
      return this.responseUtils.success(result);
    } catch (err) {
      return this.handleError(err);
    }
  }

  private async handleCopyObject(req: RouteRequest, _ctx: RouteContext): Promise<RouteResponse> {
    try {
      const srcBucket = req.params.srcBucket ?? '';
      const srcObject = parseObjectName(req.params.srcObject ?? '');
      const dstBucket = req.params.dstBucket ?? '';
      const dstObject = parseObjectName(req.params.dstObject ?? '');

      const result = await this.service.copyObject(srcBucket, srcObject, dstBucket, dstObject);
      return this.responseUtils.success(result);
    } catch (err) {
      return this.handleError(err);
    }
  }

  private async handleRewriteObject(req: RouteRequest, _ctx: RouteContext): Promise<RouteResponse> {
    try {
      const srcBucket = req.params.srcBucket ?? '';
      const srcObject = parseObjectName(req.params.srcObject ?? '');
      const dstBucket = req.params.dstBucket ?? '';
      const dstObject = parseObjectName(req.params.dstObject ?? '');

      const result = await this.service.rewriteObject(srcBucket, srcObject, dstBucket, dstObject);
      return this.responseUtils.success(result);
    } catch (err) {
      return this.handleError(err);
    }
  }

  private handleError(err: unknown): RouteResponse {
    return handleGcsError(err, 'Object', this.responseUtils);
  }

  private evictStaleUploads(): void {
    if (this.resumableUploads.size < MAX_PENDING_UPLOADS) {
      return;
    }

    const now = Date.now();

    for (const [id, upload] of this.resumableUploads) {
      if (now - upload.createdAt > RESUMABLE_UPLOAD_TTL_MS) {
        this.resumableUploads.delete(id);
      }
    }
  }
}
