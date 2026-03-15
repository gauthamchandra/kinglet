/**
 * Snapshot HTTP route handlers for Cloud Pub/Sub
 */

import type {
  RouteContext,
  RouteDefinition,
  RouteRequest,
  RouteResponse,
} from '@/core/gateway/request-router.ts';
import { ResponseUtils, StandardResponseFormatter } from '@/core/gateway/response-handlers.ts';
import type { Logger } from '@/shared/utils/logger.ts';
import type { SnapshotService } from './snapshot-service.ts';
import { buildSnapshotName, buildTopicName, handlePubSubError } from './types.ts';

export class SnapshotHandlers {
  private service: SnapshotService;
  private responseUtils: ResponseUtils;

  constructor(service: SnapshotService, logger: Logger) {
    this.service = service;
    const formatter = new StandardResponseFormatter(logger);

    this.responseUtils = new ResponseUtils(formatter);
  }

  getRoutes(): RouteDefinition[] {
    return [
      {
        id: 'pubsub.snapshots.create',
        method: 'PUT',
        path: '/v1/projects/:project/snapshots/:snapshot',
        handler: (req, ctx) => this.handleCreateSnapshot(req, ctx),
      },
      {
        id: 'pubsub.snapshots.get',
        method: 'GET',
        path: '/v1/projects/:project/snapshots/:snapshot',
        handler: (req, ctx) => this.handleGetSnapshot(req, ctx),
      },
      {
        id: 'pubsub.snapshots.list',
        method: 'GET',
        path: '/v1/projects/:project/snapshots',
        handler: (req, ctx) => this.handleListSnapshots(req, ctx),
      },
      {
        id: 'pubsub.snapshots.patch',
        method: 'PATCH',
        path: '/v1/projects/:project/snapshots/:snapshot',
        handler: (req, ctx) => this.handleUpdateSnapshot(req, ctx),
      },
      {
        id: 'pubsub.snapshots.delete',
        method: 'DELETE',
        path: '/v1/projects/:project/snapshots/:snapshot',
        handler: (req, ctx) => this.handleDeleteSnapshot(req, ctx),
      },
      // Topic sub-resource: list snapshots for a topic
      {
        id: 'pubsub.topics.snapshots.list',
        method: 'GET',
        path: '/v1/projects/:project/topics/:topic/snapshots',
        handler: (req, ctx) => this.handleListTopicSnapshots(req, ctx),
      },
    ];
  }

  private async handleCreateSnapshot(
    req: RouteRequest,
    _ctx: RouteContext
  ): Promise<RouteResponse> {
    try {
      const { project, snapshot } = req.params;
      const result = await this.service.createSnapshot(
        project as string,
        snapshot as string,
        req.body ?? {}
      );

      return this.responseUtils.success(result);
    } catch (err) {
      return handlePubSubError(err, 'Snapshot', this.responseUtils);
    }
  }

  private async handleGetSnapshot(req: RouteRequest, _ctx: RouteContext): Promise<RouteResponse> {
    try {
      const { project, snapshot } = req.params;
      const name = buildSnapshotName(project as string, snapshot as string);
      const result = await this.service.getSnapshot(name);

      return this.responseUtils.success(result);
    } catch (err) {
      return handlePubSubError(err, 'Snapshot', this.responseUtils);
    }
  }

  private async handleListSnapshots(req: RouteRequest, _ctx: RouteContext): Promise<RouteResponse> {
    try {
      const { project } = req.params;
      const pageSize = req.query.pageSize ? parseInt(req.query.pageSize as string, 10) : undefined;
      const pageToken = req.query.pageToken as string | undefined;
      const result = await this.service.listSnapshots(project as string, pageSize, pageToken);

      return this.responseUtils.success(result);
    } catch (err) {
      return handlePubSubError(err, 'Snapshot', this.responseUtils);
    }
  }

  private async handleUpdateSnapshot(
    req: RouteRequest,
    _ctx: RouteContext
  ): Promise<RouteResponse> {
    try {
      const { project, snapshot } = req.params;
      const name = buildSnapshotName(project as string, snapshot as string);
      const result = await this.service.updateSnapshot(name, req.body);

      return this.responseUtils.success(result);
    } catch (err) {
      return handlePubSubError(err, 'Snapshot', this.responseUtils);
    }
  }

  private async handleDeleteSnapshot(
    req: RouteRequest,
    _ctx: RouteContext
  ): Promise<RouteResponse> {
    try {
      const { project, snapshot } = req.params;
      const name = buildSnapshotName(project as string, snapshot as string);
      await this.service.deleteSnapshot(name);

      return this.responseUtils.success({});
    } catch (err) {
      return handlePubSubError(err, 'Snapshot', this.responseUtils);
    }
  }

  private async handleListTopicSnapshots(
    req: RouteRequest,
    _ctx: RouteContext
  ): Promise<RouteResponse> {
    try {
      const { project, topic } = req.params;
      const topicName = buildTopicName(project as string, topic as string);
      const result = await this.service.listTopicSnapshots(topicName);

      return this.responseUtils.success(result);
    } catch (err) {
      return handlePubSubError(err, 'Topic', this.responseUtils);
    }
  }
}
