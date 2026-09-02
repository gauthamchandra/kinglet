/**
 * End-to-End Test Setup
 *
 * This file configures the test environment for end-to-end tests.
 * E2E tests verify complete workflows across all services and components.
 */

import { afterAll, beforeAll } from 'bun:test';
import type { Config } from '@/shared/types/index.ts';
import { getAvailablePorts } from '../test-utils/helpers.ts';

// Test configuration for E2E tests - will be populated with dynamic ports
let E2E_TEST_CONFIG: Partial<Config>;

let testServer: any = null;

/**
 * Global setup for E2E tests - starts the full kinglet server
 */
beforeAll(async () => {
  console.log('🚀 Setting up E2E test environment...');

  // Get dynamic ports for E2E tests
  const [httpPort, grpcPort] = await getAvailablePorts(2);

  // Initialize test configuration with dynamic ports
  E2E_TEST_CONFIG = {
    server: {
      httpPort,
      grpcPort,
      maxConnections: 50,
    },
    storage: {
      type: 'memory', // Use memory storage for fast E2E tests
      cacheSize: 10 * 1024 * 1024, // 10MB cache
    },
    auth: {
      enabled: false, // Disable auth for E2E tests
      mode: 'bypass',
    },
    services: {
      pubsub: { enabled: true },
      scheduler: { enabled: true },
      tasks: { enabled: true },
      secrets: { enabled: true },
    },
    logging: {
      level: 'error', // Reduce noise in E2E tests
      prettyPrint: false,
    },
  };

  // TODO: When the main server is implemented, start it here
  // testServer = await startServer(E2E_TEST_CONFIG);

  // Wait for server to be ready
  // await waitForServerReady(E2E_TEST_CONFIG.server!.httpPort!);

  console.log('✅ E2E test environment ready');
});

/**
 * Global teardown for E2E tests - stops the test server
 */
afterAll(async () => {
  console.log('🧹 Tearing down E2E test environment...');

  if (testServer) {
    await testServer.stop();
    testServer = null;
  }

  console.log('✅ E2E test environment cleaned up');
});

/**
 * Helper function to wait for server to be ready
 */
async function waitForServerReady(port: number, timeout: number = 10000): Promise<void> {
  const start = Date.now();

  while (Date.now() - start < timeout) {
    try {
      const response = await fetch(`http://localhost:${port}/healthcheck`);
      if (response.ok) {
        return;
      }
    } catch {
      // Server not ready yet
    }

    await new Promise(resolve => setTimeout(resolve, 100));
  }

  throw new Error(`Server failed to start within ${timeout}ms`);
}

/**
 * Get the E2E test configuration
 */
export function getE2EConfig(): Partial<Config> {
  return { ...E2E_TEST_CONFIG };
}

/**
 * Get the base URL for HTTP requests in E2E tests
 */
export function getBaseUrl(): string {
  return `http://localhost:${E2E_TEST_CONFIG.server!.httpPort!}`;
}

/**
 * Get the gRPC endpoint for E2E tests
 */
export function getGrpcEndpoint(): string {
  return `localhost:${E2E_TEST_CONFIG.server!.grpcPort!}`;
}
