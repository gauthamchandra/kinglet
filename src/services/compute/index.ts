/**
 * Compute Service — entry point.
 *
 * Wires repository, security policy service, handlers, and the local listener.
 */

import type { Server } from 'bun';
import type { RouteDefinition } from '@/core/gateway/request-router.ts';
import type { StorageManager } from '@/core/storage/manager.ts';
import type { Logger } from '@/shared/utils/logger.ts';
import { ComputeHandlers } from './handlers.ts';
import { startArmorListener } from './listener.ts';
import { SecurityPolicyService } from './service.ts';

export interface ComputeServiceOptions {
  listenerPort?: number | undefined;
  defaultPolicyName?: string | undefined;
}

export interface ComputeStartResult {
  listenerStarted: boolean;
  listenerPort?: number;
}

export class ComputeService {
  private storage: StorageManager;
  private logger: Logger;
  private options: ComputeServiceOptions;
  private policyService: SecurityPolicyService | null = null;
  private handlers: ComputeHandlers | null = null;
  private listenerServer: Server | null = null;

  constructor(storage: StorageManager, logger: Logger, options: ComputeServiceOptions = {}) {
    this.storage = storage;
    this.logger = logger;
    this.options = options;
  }

  async initialize(): Promise<void> {
    this.policyService = new SecurityPolicyService(this.storage, this.logger);
    await this.policyService.initialize();

    this.handlers = new ComputeHandlers(this.policyService, this.logger);

    this.logger.info('Compute service initialized');
  }

  getRoutes(): RouteDefinition[] {
    if (this.handlers == null) {
      throw new Error('ComputeService not initialized. Call initialize() first.');
    }

    return this.handlers.getRoutes();
  }

  start(): ComputeStartResult {
    if (this.policyService == null) {
      throw new Error('ComputeService not initialized. Call initialize() first.');
    }

    const listenerPort = this.options.listenerPort ?? 8787;
    const defaultPolicyName = this.options.defaultPolicyName;
    const policyService = this.policyService;

    try {
      this.listenerServer = startArmorListener({
        port: listenerPort,
        defaultPolicyName,
        getPolicies: () => policyService.listAll(),
      });
    } catch (error) {
      this.logger.warn(
        `Cloud Armor listener failed to bind 127.0.0.1:${listenerPort}; Compute control plane is still available`,
        { error: error instanceof Error ? error.message : String(error) }
      );

      return { listenerStarted: false };
    }

    const boundPort = this.listenerServer.port;

    this.logger.info(`Cloud Armor listener started on 127.0.0.1:${boundPort}`);

    if (boundPort != null) {
      return { listenerStarted: true, listenerPort: boundPort };
    }

    return { listenerStarted: true };
  }

  async stop(): Promise<void> {
    if (this.listenerServer != null) {
      this.listenerServer.stop();
      this.listenerServer = null;
    }

    this.logger.info('Compute service stopped');
  }

  getSecurityPolicyService(): SecurityPolicyService {
    if (this.policyService == null) {
      throw new Error('ComputeService not initialized. Call initialize() first.');
    }

    return this.policyService;
  }
}
