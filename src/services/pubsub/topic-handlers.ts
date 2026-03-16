/**
 * Topic HTTP route handlers for Cloud Pub/Sub
 */

import type {
  RouteContext,
  RouteDefinition,
  RouteRequest,
  RouteResponse,
} from '@/core/gateway/request-router.ts';
import { ResponseUtils, StandardResponseFormatter } from '@/core/gateway/response-handlers.ts';
import type { Logger } from '@/shared/utils/logger.ts';
import type { TopicService } from './topic-service.ts';
import { buildTopicName, handlePubSubError } from './types.ts';

export class TopicHandlers {
  private service: TopicService;
  private responseUtils: ResponseUtils;

  constructor(service: TopicService, logger: Logger) {
    this.service = service;
    const formatter = new StandardResponseFormatter(logger);

    this.responseUtils = new ResponseUtils(formatter);
  }

  getRoutes(): RouteDefinition[] {
    return [
      {
        id: 'pubsub.topics.create',
        method: 'PUT',
        path: '/v1/projects/:project/topics/:topic',
        handler: (req, ctx) => this.handleCreateTopic(req, ctx),
      },
      {
        id: 'pubsub.topics.get',
        method: 'GET',
        path: '/v1/projects/:project/topics/:topic',
        handler: (req, ctx) => this.handleGetTopic(req, ctx),
      },
      {
        id: 'pubsub.topics.list',
        method: 'GET',
        path: '/v1/projects/:project/topics',
        handler: (req, ctx) => this.handleListTopics(req, ctx),
      },
      {
        id: 'pubsub.topics.delete',
        method: 'DELETE',
        path: '/v1/projects/:project/topics/:topic',
        handler: (req, ctx) => this.handleDeleteTopic(req, ctx),
      },
      {
        id: 'pubsub.topics.patch',
        method: 'PATCH',
        path: '/v1/projects/:project/topics/:topic',
        handler: (req, ctx) => this.handleUpdateTopic(req, ctx),
      },
    ];
  }

  private async handleCreateTopic(req: RouteRequest, _ctx: RouteContext): Promise<RouteResponse> {
    try {
      const { project, topic } = req.params;
      const result = await this.service.createTopic(
        project as string,
        topic as string,
        req.body ?? {}
      );

      return this.responseUtils.success(result);
    } catch (err) {
      return handlePubSubError(err, 'Topic', this.responseUtils);
    }
  }

  private async handleGetTopic(req: RouteRequest, _ctx: RouteContext): Promise<RouteResponse> {
    try {
      const { project, topic } = req.params;
      const name = buildTopicName(project as string, topic as string);
      const result = await this.service.getTopic(name);

      return this.responseUtils.success(result);
    } catch (err) {
      return handlePubSubError(err, 'Topic', this.responseUtils);
    }
  }

  private async handleListTopics(req: RouteRequest, _ctx: RouteContext): Promise<RouteResponse> {
    try {
      const { project } = req.params;
      const pageSize = req.query.pageSize ? parseInt(req.query.pageSize as string, 10) : undefined;
      const pageToken = req.query.pageToken as string | undefined;
      const result = await this.service.listTopics(project as string, pageSize, pageToken);

      return this.responseUtils.success(result);
    } catch (err) {
      return handlePubSubError(err, 'Topic', this.responseUtils);
    }
  }

  private async handleDeleteTopic(req: RouteRequest, _ctx: RouteContext): Promise<RouteResponse> {
    try {
      const { project, topic } = req.params;
      const name = buildTopicName(project as string, topic as string);
      await this.service.deleteTopic(name);

      return this.responseUtils.success({});
    } catch (err) {
      return handlePubSubError(err, 'Topic', this.responseUtils);
    }
  }

  private async handleUpdateTopic(req: RouteRequest, _ctx: RouteContext): Promise<RouteResponse> {
    try {
      const { project, topic } = req.params;
      const name = buildTopicName(project as string, topic as string);
      const result = await this.service.updateTopic(name, req.body);

      return this.responseUtils.success(result);
    } catch (err) {
      return handlePubSubError(err, 'Topic', this.responseUtils);
    }
  }
}
