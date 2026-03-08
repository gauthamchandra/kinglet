/**
 * Tests for SchedulerHandlers - HTTP route handlers
 *
 * Uses mocked JobService to test request-to-service mapping and response formatting.
 */

import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { RouteContext, RouteRequest } from '@/core/gateway/request-router.ts';
import { Logger } from '@/shared/utils/logger.ts';
import { SchedulerHandlers } from './handlers.ts';
import type { JobService } from './service.ts';
import { SchedulerError } from './service.ts';

function makeRouteRequest(overrides: Partial<RouteRequest> = {}): RouteRequest {
  return {
    method: 'GET',
    path: '/v1/projects/p/locations/l/jobs',
    query: {},
    headers: {},
    params: {},
    body: undefined,
    originalRequest: new Request('http://localhost'),
    ...overrides,
  };
}

function makeRouteContext(): RouteContext {
  return {
    routeId: 'test',
    startTime: Date.now(),
    metadata: {},
    logger: new Logger('test', 'error'),
  };
}

describe('SchedulerHandlers', () => {
  let mockService: JobService;
  let handlers: SchedulerHandlers;
  const ctx = makeRouteContext();

  beforeEach(() => {
    mockService = {
      createJob: mock(() =>
        Promise.resolve({
          name: 'projects/p/locations/l/jobs/j',
          description: '',
          schedule: '* * * * *',
          timeZone: 'UTC',
          state: 'ENABLED',
          httpTarget: { uri: 'https://example.com', httpMethod: 'POST' },
          retryConfig: {
            retryCount: 0,
            maxRetryDuration: '0s',
            minBackoffDuration: '5s',
            maxBackoffDuration: '3600s',
          },
          attemptDeadline: '180s',
          scheduleTime: '2024-01-01T00:01:00Z',
        })
      ),
      getJob: mock(() =>
        Promise.resolve({
          name: 'projects/p/locations/l/jobs/j',
          description: '',
          schedule: '* * * * *',
          timeZone: 'UTC',
          state: 'ENABLED',
          httpTarget: { uri: 'https://example.com', httpMethod: 'POST' },
          retryConfig: {
            retryCount: 0,
            maxRetryDuration: '0s',
            minBackoffDuration: '5s',
            maxBackoffDuration: '3600s',
          },
          attemptDeadline: '180s',
        })
      ),
      listJobs: mock(() =>
        Promise.resolve({
          jobs: [],
          nextPageToken: undefined,
        })
      ),
      updateJob: mock(() =>
        Promise.resolve({
          name: 'projects/p/locations/l/jobs/j',
          description: 'updated',
          schedule: '* * * * *',
          timeZone: 'UTC',
          state: 'ENABLED',
          httpTarget: { uri: 'https://example.com', httpMethod: 'POST' },
          retryConfig: {
            retryCount: 0,
            maxRetryDuration: '0s',
            minBackoffDuration: '5s',
            maxBackoffDuration: '3600s',
          },
          attemptDeadline: '180s',
        })
      ),
      deleteJob: mock(() => Promise.resolve()),
      pauseJob: mock(() =>
        Promise.resolve({
          name: 'projects/p/locations/l/jobs/j',
          description: '',
          schedule: '* * * * *',
          timeZone: 'UTC',
          state: 'PAUSED',
          httpTarget: { uri: 'https://example.com', httpMethod: 'POST' },
          retryConfig: {
            retryCount: 0,
            maxRetryDuration: '0s',
            minBackoffDuration: '5s',
            maxBackoffDuration: '3600s',
          },
          attemptDeadline: '180s',
        })
      ),
      resumeJob: mock(() =>
        Promise.resolve({
          name: 'projects/p/locations/l/jobs/j',
          description: '',
          schedule: '* * * * *',
          timeZone: 'UTC',
          state: 'ENABLED',
          httpTarget: { uri: 'https://example.com', httpMethod: 'POST' },
          retryConfig: {
            retryCount: 0,
            maxRetryDuration: '0s',
            minBackoffDuration: '5s',
            maxBackoffDuration: '3600s',
          },
          attemptDeadline: '180s',
        })
      ),
      runJob: mock(() =>
        Promise.resolve({
          name: 'projects/p/locations/l/jobs/j',
          description: '',
          schedule: '* * * * *',
          timeZone: 'UTC',
          state: 'ENABLED',
          httpTarget: { uri: 'https://example.com', httpMethod: 'POST' },
          retryConfig: {
            retryCount: 0,
            maxRetryDuration: '0s',
            minBackoffDuration: '5s',
            maxBackoffDuration: '3600s',
          },
          attemptDeadline: '180s',
        })
      ),
    } as unknown as JobService;

    handlers = new SchedulerHandlers(mockService, new Logger('test', 'error'));
  });

  describe('getRoutes', () => {
    test('should return 8 route definitions', () => {
      const routes = handlers.getRoutes();

      expect(routes.length).toBe(8);
    });

    test('should include correct methods and paths', () => {
      const routes = handlers.getRoutes();
      const routeSpecs = routes.map(r => `${r.method} ${r.path}`);

      expect(routeSpecs).toContain('POST /v1/projects/:project/locations/:location/jobs');
      expect(routeSpecs).toContain('GET /v1/projects/:project/locations/:location/jobs/:jobId');
      expect(routeSpecs).toContain('GET /v1/projects/:project/locations/:location/jobs');
      expect(routeSpecs).toContain('PATCH /v1/projects/:project/locations/:location/jobs/:jobId');
      expect(routeSpecs).toContain('DELETE /v1/projects/:project/locations/:location/jobs/:jobId');
      expect(routeSpecs).toContain(
        'POST /v1/projects/:project/locations/:location/jobs/:jobId:pause'
      );
      expect(routeSpecs).toContain(
        'POST /v1/projects/:project/locations/:location/jobs/:jobId:resume'
      );
      expect(routeSpecs).toContain(
        'POST /v1/projects/:project/locations/:location/jobs/:jobId:run'
      );
    });
  });

  describe('createJob handler', () => {
    test('should call service.createJob with extracted params', async () => {
      const route = handlers.getRoutes().find(r => r.id === 'scheduler.jobs.create');
      const request = makeRouteRequest({
        method: 'POST',
        params: { project: 'my-proj', location: 'us-central1' },
        body: {
          jobId: 'my-job',
          schedule: '* * * * *',
          httpTarget: { uri: 'https://example.com', httpMethod: 'POST' },
        },
      });

      const response = await route?.handler(request, ctx);

      expect(response?.status).toBe(200);
      expect(mockService.createJob).toHaveBeenCalled();
    });
  });

  describe('getJob handler', () => {
    test('should call service.getJob with resource name', async () => {
      const route = handlers.getRoutes().find(r => r.id === 'scheduler.jobs.get');
      const request = makeRouteRequest({
        method: 'GET',
        params: { project: 'p', location: 'l', jobId: 'j' },
      });

      const response = await route?.handler(request, ctx);

      expect(response?.status).toBe(200);
      expect(mockService.getJob).toHaveBeenCalledWith('projects/p/locations/l/jobs/j');
    });
  });

  describe('listJobs handler', () => {
    test('should pass pageSize and pageToken from query params', async () => {
      const route = handlers.getRoutes().find(r => r.id === 'scheduler.jobs.list');
      const request = makeRouteRequest({
        method: 'GET',
        params: { project: 'p', location: 'l' },
        query: { pageSize: '10', pageToken: 'abc' },
      });

      const response = await route?.handler(request, ctx);

      expect(response?.status).toBe(200);
      expect(mockService.listJobs).toHaveBeenCalledWith('p', 'l', 10, 'abc');
    });

    test('should ignore invalid pageSize values', async () => {
      const route = handlers.getRoutes().find(r => r.id === 'scheduler.jobs.list');
      const request = makeRouteRequest({
        method: 'GET',
        params: { project: 'p', location: 'l' },
        query: { pageSize: 'notanumber' },
      });

      const response = await route?.handler(request, ctx);

      expect(response?.status).toBe(200);
      expect(mockService.listJobs).toHaveBeenCalledWith('p', 'l', undefined, undefined);
    });

    test('should ignore negative pageSize values', async () => {
      const route = handlers.getRoutes().find(r => r.id === 'scheduler.jobs.list');
      const request = makeRouteRequest({
        method: 'GET',
        params: { project: 'p', location: 'l' },
        query: { pageSize: '-5' },
      });

      const response = await route?.handler(request, ctx);

      expect(response?.status).toBe(200);
      expect(mockService.listJobs).toHaveBeenCalledWith('p', 'l', undefined, undefined);
    });
  });

  describe('deleteJob handler', () => {
    test('should return 200 with empty object on success', async () => {
      const route = handlers.getRoutes().find(r => r.id === 'scheduler.jobs.delete');
      const request = makeRouteRequest({
        method: 'DELETE',
        params: { project: 'p', location: 'l', jobId: 'j' },
      });

      const response = await route?.handler(request, ctx);

      expect(response?.status).toBe(200);
      expect(mockService.deleteJob).toHaveBeenCalledWith('projects/p/locations/l/jobs/j');
    });
  });

  describe('error handling', () => {
    test('should return 404 for NOT_FOUND errors', async () => {
      (mockService.getJob as ReturnType<typeof mock>).mockRejectedValue(
        new SchedulerError('NOT_FOUND', 'Job not found')
      );

      const route = handlers.getRoutes().find(r => r.id === 'scheduler.jobs.get');
      const request = makeRouteRequest({
        params: { project: 'p', location: 'l', jobId: 'j' },
      });

      const response = await route?.handler(request, ctx);

      expect(response?.status).toBe(404);
    });

    test('should return 409 for ALREADY_EXISTS errors', async () => {
      (mockService.createJob as ReturnType<typeof mock>).mockRejectedValue(
        new SchedulerError('ALREADY_EXISTS', 'Job already exists')
      );

      const route = handlers.getRoutes().find(r => r.id === 'scheduler.jobs.create');
      const request = makeRouteRequest({
        method: 'POST',
        params: { project: 'p', location: 'us-central1' },
        body: {
          jobId: 'j',
          schedule: '* * * * *',
          httpTarget: { uri: 'https://example.com', httpMethod: 'POST' },
        },
      });

      const response = await route?.handler(request, ctx);

      expect(response?.status).toBe(409);
    });

    test('should return 400 for INVALID_ARGUMENT errors', async () => {
      (mockService.createJob as ReturnType<typeof mock>).mockRejectedValue(
        new SchedulerError('INVALID_ARGUMENT', 'Invalid argument')
      );

      const route = handlers.getRoutes().find(r => r.id === 'scheduler.jobs.create');
      const request = makeRouteRequest({
        method: 'POST',
        params: { project: 'p', location: 'l' },
        body: { jobId: 'j' },
      });

      const response = await route?.handler(request, ctx);

      expect(response?.status).toBe(400);
    });

    test('should return 400 for FAILED_PRECONDITION errors', async () => {
      (mockService.pauseJob as ReturnType<typeof mock>).mockRejectedValue(
        new SchedulerError('FAILED_PRECONDITION', 'Already paused')
      );

      const route = handlers.getRoutes().find(r => r.id === 'scheduler.jobs.pause');
      const request = makeRouteRequest({
        method: 'POST',
        params: { project: 'p', location: 'l', jobId: 'j' },
      });

      const response = await route?.handler(request, ctx);

      expect(response?.status).toBe(400);
    });
  });
});
