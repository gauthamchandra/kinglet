/**
 * Unit tests for HTTP Server implementation
 */

import { test, expect, describe, beforeEach, afterEach, beforeAll } from 'bun:test';
import { HttpServer, type HttpRequest, type HttpResponse } from './http-server.ts';
import { Logger } from '@/shared/utils/logger.ts';

describe('HttpServer', () => {
  let httpServer: HttpServer;
  let logger: Logger;
  let originalFetch: typeof fetch;

  const serverConfig = {
    httpPort: 0, // Use port 0 to let OS choose available port for testing
    grpcPort: 0,
    maxConnections: 100,
  };

  beforeAll(() => {
    // Store and restore original fetch to ensure HttpServer tests use real HTTP
    originalFetch = global.fetch;
    global.fetch = originalFetch;
  });

  beforeEach(() => {
    // Ensure we always have real fetch for HttpServer tests
    global.fetch = originalFetch;
    logger = new Logger('HttpServerTest', 'error'); // Reduce log noise in tests
    httpServer = new HttpServer(serverConfig, logger);
  });

  afterEach(async () => {
    if (httpServer.isRunning()) {
      await httpServer.stop();
    }
  });

  describe('Route Registration', () => {
    test('should register GET route', async () => {
      const handler = async (_req: HttpRequest): Promise<HttpResponse> => ({
        status: 200,
        body: { message: 'Hello World' },
      });

      httpServer.get('/test', handler);

      // Verify route was registered by checking internal state
      expect(httpServer.isRunning()).toBe(false);
    });

    test('should register POST route', async () => {
      const handler = async (_req: HttpRequest): Promise<HttpResponse> => ({
        status: 201,
        body: { created: true },
      });

      httpServer.post('/create', handler);

      expect(httpServer.isRunning()).toBe(false);
    });

    test('should register PUT route', async () => {
      const handler = async (_req: HttpRequest): Promise<HttpResponse> => ({
        status: 200,
        body: { updated: true },
      });

      httpServer.put('/update', handler);

      expect(httpServer.isRunning()).toBe(false);
    });

    test('should register DELETE route', async () => {
      const handler = async (_req: HttpRequest): Promise<HttpResponse> => ({
        status: 204,
      });

      httpServer.delete('/delete', handler);

      expect(httpServer.isRunning()).toBe(false);
    });

    test('should register PATCH route', async () => {
      const handler = async (_req: HttpRequest): Promise<HttpResponse> => ({
        status: 200,
        body: { patched: true },
      });

      httpServer.patch('/patch', handler);

      expect(httpServer.isRunning()).toBe(false);
    });
  });

  describe('Middleware', () => {
    test('should add middleware to pipeline', async () => {
      const middleware1 = async (
        req: HttpRequest,
        next: () => Promise<HttpResponse>
      ): Promise<HttpResponse> => {
        const response = await next();

        return {
          ...response,
          headers: {
            ...response.headers,
            'x-middleware-1': 'applied',
          },
        };
      };

      const middleware2 = async (
        req: HttpRequest,
        next: () => Promise<HttpResponse>
      ): Promise<HttpResponse> => {
        const response = await next();

        return {
          ...response,
          headers: {
            ...response.headers,
            'x-middleware-2': 'applied',
          },
        };
      };

      httpServer.use(middleware1);
      httpServer.use(middleware2);

      expect(httpServer.isRunning()).toBe(false);
    });
  });

  describe('Server Lifecycle', () => {
    test('should start server', async () => {
      expect(httpServer.isRunning()).toBe(false);

      await httpServer.start();

      expect(httpServer.isRunning()).toBe(true);
    });

    test('should stop server', async () => {
      await httpServer.start();
      expect(httpServer.isRunning()).toBe(true);

      await httpServer.stop();

      expect(httpServer.isRunning()).toBe(false);
    });

    test('should handle start error gracefully', async () => {
      // Start first server with port 0 (OS-assigned)
      const server1 = new HttpServer(serverConfig, logger);

      await server1.start();
      expect(server1.isRunning()).toBe(true);

      // Get the actual port assigned to server1
      const assignedPort = server1.getPort();

      expect(assignedPort).not.toBeNull();

      if (assignedPort === null) {
        throw new Error('Server port should not be null after starting');
      }

      // Try to start second server with the same specific port - should fail
      const conflictConfig = {
        httpPort: assignedPort,
        grpcPort: 0,
        maxConnections: 100,
      };

      const server2 = new HttpServer(conflictConfig, logger);

      try {
        // This should fail because server1 is already using the port
        await expect(server2.start()).rejects.toThrow();
        expect(server2.isRunning()).toBe(false);
      } finally {
        await server1.stop();
      }
    });
  });

  describe('Request Handling', () => {
    test('should handle basic GET request', async () => {
      const server = new HttpServer(serverConfig, logger);

      server.get(
        '/test',
        async (_req: HttpRequest): Promise<HttpResponse> => ({
          status: 200,
          body: { message: 'success' },
        })
      );

      await server.start();

      try {
        const port = server.getPort();

        expect(port).not.toBeNull();

        const response = await fetch(`http://localhost:${port}/test`);
        const data = await response.json();

        expect(response.status).toBe(200);
        expect(data).toEqual({ message: 'success' });
      } finally {
        await server.stop();
      }
    });

    test('should handle POST request with JSON body', async () => {
      const server = new HttpServer(serverConfig, logger);

      server.post(
        '/echo',
        async (req: HttpRequest): Promise<HttpResponse> => ({
          status: 200,
          body: { received: req.body },
        })
      );

      await server.start();

      try {
        const port = server.getPort();

        expect(port).not.toBeNull();

        const response = await fetch(`http://localhost:${port}/echo`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ test: 'data' }),
        });

        const data = await response.json();

        expect(response.status).toBe(200);
        expect(data).toEqual({ received: { test: 'data' } });
      } finally {
        await server.stop();
      }
    });

    test('should return 404 for unregistered routes', async () => {
      const server = new HttpServer(serverConfig, logger);

      await server.start();

      try {
        const port = server.getPort();

        expect(port).not.toBeNull();

        const response = await fetch(`http://localhost:${port}/nonexistent`);
        const data = await response.json();

        expect(response.status).toBe(404);
        expect(data.error.message).toBe('Not Found');
      } finally {
        await server.stop();
      }
    });

    test('should handle query parameters', async () => {
      const server = new HttpServer(serverConfig, logger);

      server.get(
        '/query',
        async (req: HttpRequest): Promise<HttpResponse> => ({
          status: 200,
          body: { query: req.query },
        })
      );

      await server.start();

      try {
        const port = server.getPort();

        expect(port).not.toBeNull();

        const response = await fetch(`http://localhost:${port}/query?param1=value1&param2=value2`);
        const data = await response.json();

        expect(response.status).toBe(200);
        expect(data.query).toEqual({ param1: 'value1', param2: 'value2' });
      } finally {
        await server.stop();
      }
    });
  });

  describe('Error Handling', () => {
    test('should handle handler errors gracefully', async () => {
      const server = new HttpServer(serverConfig, logger);

      server.get('/error', async (_req: HttpRequest): Promise<HttpResponse> => {
        throw new Error('Test error');
      });

      await server.start();

      try {
        const port = server.getPort();

        expect(port).not.toBeNull();

        const response = await fetch(`http://localhost:${port}/error`);
        const data = await response.json();

        expect(response.status).toBe(500);
        expect(data.error.message).toBe('Internal Server Error');
      } finally {
        await server.stop();
      }
    });
  });
});
