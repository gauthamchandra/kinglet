/**
 * Subscription and Publish HTTP route handlers for Cloud Pub/Sub
 */

import type {
  RouteContext,
  RouteDefinition,
  RouteRequest,
  RouteResponse,
} from '@/core/gateway/request-router.ts';
import { ResponseUtils, StandardResponseFormatter } from '@/core/gateway/response-handlers.ts';
import type { Logger } from '@/shared/utils/logger.ts';
import type { SubscriptionService } from './subscription-service.ts';
import { buildSubscriptionName, buildTopicName, handlePubSubError } from './types.ts';

export class SubscriptionHandlers {
  private service: SubscriptionService;
  private responseUtils: ResponseUtils;

  constructor(service: SubscriptionService, logger: Logger) {
    this.service = service;
    const formatter = new StandardResponseFormatter(logger);

    this.responseUtils = new ResponseUtils(formatter);
  }

  getRoutes(): RouteDefinition[] {
    return [
      // Subscription CRUD
      {
        id: 'pubsub.subscriptions.create',
        method: 'PUT',
        path: '/v1/projects/:project/subscriptions/:subscription',
        handler: (req, ctx) => this.handleCreateSubscription(req, ctx),
      },
      {
        id: 'pubsub.subscriptions.get',
        method: 'GET',
        path: '/v1/projects/:project/subscriptions/:subscription',
        handler: (req, ctx) => this.handleGetSubscription(req, ctx),
      },
      {
        id: 'pubsub.subscriptions.list',
        method: 'GET',
        path: '/v1/projects/:project/subscriptions',
        handler: (req, ctx) => this.handleListSubscriptions(req, ctx),
      },
      {
        id: 'pubsub.subscriptions.delete',
        method: 'DELETE',
        path: '/v1/projects/:project/subscriptions/:subscription',
        handler: (req, ctx) => this.handleDeleteSubscription(req, ctx),
      },
      {
        id: 'pubsub.subscriptions.patch',
        method: 'PATCH',
        path: '/v1/projects/:project/subscriptions/:subscription',
        handler: (req, ctx) => this.handleUpdateSubscription(req, ctx),
      },
      // Publish (topic-scoped)
      {
        id: 'pubsub.topics.publish',
        method: 'POST',
        path: '/v1/projects/:project/topics/:topic:publish',
        handler: (req, ctx) => this.handlePublish(req, ctx),
      },
      // Pull / Ack / Deadline
      {
        id: 'pubsub.subscriptions.pull',
        method: 'POST',
        path: '/v1/projects/:project/subscriptions/:subscription:pull',
        handler: (req, ctx) => this.handlePull(req, ctx),
      },
      {
        id: 'pubsub.subscriptions.acknowledge',
        method: 'POST',
        path: '/v1/projects/:project/subscriptions/:subscription:acknowledge',
        handler: (req, ctx) => this.handleAcknowledge(req, ctx),
      },
      {
        id: 'pubsub.subscriptions.modifyAckDeadline',
        method: 'POST',
        path: '/v1/projects/:project/subscriptions/:subscription:modifyAckDeadline',
        handler: (req, ctx) => this.handleModifyAckDeadline(req, ctx),
      },
      {
        id: 'pubsub.subscriptions.modifyPushConfig',
        method: 'POST',
        path: '/v1/projects/:project/subscriptions/:subscription:modifyPushConfig',
        handler: (req, ctx) => this.handleModifyPushConfig(req, ctx),
      },
      {
        id: 'pubsub.subscriptions.seek',
        method: 'POST',
        path: '/v1/projects/:project/subscriptions/:subscription:seek',
        handler: (req, ctx) => this.handleSeek(req, ctx),
      },
      {
        id: 'pubsub.subscriptions.detach',
        method: 'POST',
        path: '/v1/projects/:project/subscriptions/:subscription:detach',
        handler: (req, ctx) => this.handleDetach(req, ctx),
      },
      // Topic sub-resource: list subscriptions
      {
        id: 'pubsub.topics.subscriptions.list',
        method: 'GET',
        path: '/v1/projects/:project/topics/:topic/subscriptions',
        handler: (req, ctx) => this.handleListTopicSubscriptions(req, ctx),
      },
    ];
  }

  private async handleCreateSubscription(
    req: RouteRequest,
    _ctx: RouteContext
  ): Promise<RouteResponse> {
    try {
      const { project, subscription } = req.params;
      const result = await this.service.createSubscription(
        project as string,
        subscription as string,
        req.body ?? {}
      );

      return this.responseUtils.success(result);
    } catch (err) {
      return handlePubSubError(err, 'Subscription', this.responseUtils);
    }
  }

  private async handleGetSubscription(
    req: RouteRequest,
    _ctx: RouteContext
  ): Promise<RouteResponse> {
    try {
      const { project, subscription } = req.params;
      const name = buildSubscriptionName(project as string, subscription as string);
      const result = await this.service.getSubscription(name);

      return this.responseUtils.success(result);
    } catch (err) {
      return handlePubSubError(err, 'Subscription', this.responseUtils);
    }
  }

  private async handleListSubscriptions(
    req: RouteRequest,
    _ctx: RouteContext
  ): Promise<RouteResponse> {
    try {
      const { project } = req.params;
      const pageSize = req.query.pageSize ? parseInt(req.query.pageSize as string, 10) : undefined;
      const pageToken = req.query.pageToken as string | undefined;
      const result = await this.service.listSubscriptions(project as string, pageSize, pageToken);

      return this.responseUtils.success(result);
    } catch (err) {
      return handlePubSubError(err, 'Subscription', this.responseUtils);
    }
  }

  private async handleDeleteSubscription(
    req: RouteRequest,
    _ctx: RouteContext
  ): Promise<RouteResponse> {
    try {
      const { project, subscription } = req.params;
      const name = buildSubscriptionName(project as string, subscription as string);
      await this.service.deleteSubscription(name);

      return this.responseUtils.success({});
    } catch (err) {
      return handlePubSubError(err, 'Subscription', this.responseUtils);
    }
  }

  private async handleUpdateSubscription(
    req: RouteRequest,
    _ctx: RouteContext
  ): Promise<RouteResponse> {
    try {
      const { project, subscription } = req.params;
      const name = buildSubscriptionName(project as string, subscription as string);
      const result = await this.service.updateSubscription(name, req.body);

      return this.responseUtils.success(result);
    } catch (err) {
      return handlePubSubError(err, 'Subscription', this.responseUtils);
    }
  }

  private async handlePublish(req: RouteRequest, _ctx: RouteContext): Promise<RouteResponse> {
    try {
      const { project, topic } = req.params;
      const topicName = buildTopicName(project as string, topic as string);
      const result = await this.service.publish(topicName, req.body);

      return this.responseUtils.success(result);
    } catch (err) {
      return handlePubSubError(err, 'Topic', this.responseUtils);
    }
  }

  private async handlePull(req: RouteRequest, _ctx: RouteContext): Promise<RouteResponse> {
    try {
      const { project, subscription } = req.params;
      const name = buildSubscriptionName(project as string, subscription as string);
      const result = await this.service.pull(name, req.body);

      return this.responseUtils.success(result);
    } catch (err) {
      return handlePubSubError(err, 'Subscription', this.responseUtils);
    }
  }

  private async handleAcknowledge(req: RouteRequest, _ctx: RouteContext): Promise<RouteResponse> {
    try {
      const { project, subscription } = req.params;
      const name = buildSubscriptionName(project as string, subscription as string);
      await this.service.acknowledge(name, req.body);

      return this.responseUtils.success({});
    } catch (err) {
      return handlePubSubError(err, 'Subscription', this.responseUtils);
    }
  }

  private async handleModifyAckDeadline(
    req: RouteRequest,
    _ctx: RouteContext
  ): Promise<RouteResponse> {
    try {
      const { project, subscription } = req.params;
      const name = buildSubscriptionName(project as string, subscription as string);
      await this.service.modifyAckDeadline(name, req.body);

      return this.responseUtils.success({});
    } catch (err) {
      return handlePubSubError(err, 'Subscription', this.responseUtils);
    }
  }

  private async handleModifyPushConfig(
    req: RouteRequest,
    _ctx: RouteContext
  ): Promise<RouteResponse> {
    try {
      const { project, subscription } = req.params;
      const name = buildSubscriptionName(project as string, subscription as string);
      await this.service.modifyPushConfig(name, req.body);

      return this.responseUtils.success({});
    } catch (err) {
      return handlePubSubError(err, 'Subscription', this.responseUtils);
    }
  }

  private async handleSeek(req: RouteRequest, _ctx: RouteContext): Promise<RouteResponse> {
    try {
      const { project, subscription } = req.params;
      const name = buildSubscriptionName(project as string, subscription as string);
      await this.service.seek(name, req.body);

      return this.responseUtils.success({});
    } catch (err) {
      return handlePubSubError(err, 'Subscription', this.responseUtils);
    }
  }

  private async handleDetach(req: RouteRequest, _ctx: RouteContext): Promise<RouteResponse> {
    try {
      const { project, subscription } = req.params;
      const name = buildSubscriptionName(project as string, subscription as string);
      await this.service.detachSubscription(name);

      return this.responseUtils.success({});
    } catch (err) {
      return handlePubSubError(err, 'Subscription', this.responseUtils);
    }
  }

  private async handleListTopicSubscriptions(
    req: RouteRequest,
    _ctx: RouteContext
  ): Promise<RouteResponse> {
    try {
      const { project, topic } = req.params;
      const topicName = buildTopicName(project as string, topic as string);
      const result = await this.service.listTopicSubscriptions(topicName);

      return this.responseUtils.success(result);
    } catch (err) {
      return handlePubSubError(err, 'Topic', this.responseUtils);
    }
  }
}
