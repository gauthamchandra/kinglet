/**
 * LocalStack GCP Emulator
 * Entry point for the application
 */

import { Logger } from '@/shared/utils/logger.ts';

const logger = new Logger('Main');

async function main(): Promise<void> {
  try {
    logger.info('Starting LocalStack GCP Emulator...');
    logger.info('Bun version:', Bun.version);
    logger.info('TypeScript runtime ready!');

    // TODO: Initialize core services
    // TODO: Start HTTP and gRPC servers
    // TODO: Register service modules

    logger.info('LocalStack GCP Emulator started successfully');
  } catch (error) {
    logger.error('Failed to start LocalStack GCP Emulator:', error);
    process.exit(1);
  }
}

// Handle graceful shutdown
process.on('SIGINT', () => {
  logger.info('Received SIGINT, shutting down gracefully...');
  process.exit(0);
});

process.on('SIGTERM', () => {
  logger.info('Received SIGTERM, shutting down gracefully...');
  process.exit(0);
});

// Start the application
if (import.meta.main) {
  await main();
}
