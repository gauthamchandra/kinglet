/**
 * Compute Service — entry point.
 *
 * Wires repository, security policy service, handlers, and the local listener.
 */

import type { Server } from 'bun';
import type { RouteDefinition } from '@/core/gateway/request-router.ts';
import type { StorageManager } from '@/core/storage/manager.ts';
import { AddressGroupRepository } from '@/services/networksecurity/repository.ts';
import type { Logger } from '@/shared/utils/logger.ts';
import { loadAddressGroupLookup } from './address-group-lookup.ts';
import { ComputeHandlers } from './handlers.ts';
import { startArmorListener } from './listener.ts';
import { SecurityPolicyService } from './service.ts';

export interface ComputeServiceOptions {
  listenerPort?: number | undefined;
  listenerBind?: '127.0.0.1' | '0.0.0.0' | undefined;
  defaultPolicyName?: string | undefined;
}

export interface ComputeStartResult {
  listenerStarted: boolean;
  listenerPort?: number;
  listenerBind: '127.0.0.1' | '0.0.0.0';
}

export class ComputeService {
  private storage: StorageManager;
  private logger: Logger;
  private options: ComputeServiceOptions;
  private policyService: SecurityPolicyService | null = null;
  private addressGroups: AddressGroupRepository | null = null;
  private handlers: ComputeHandlers | null = null;
  private listenerServer: Server | null = null;

  constructor(storage: StorageManager, logger: Logger, options: ComputeServiceOptions = {}) {
    this.storage = storage;
    this.logger = logger;
    this.options = options;
  }

  async initialize(): Promise<void> {
    this.policyService = new SecurityPolicyService(this.storage, this.logger);
    this.addressGroups = new AddressGroupRepository(this.storage);
    await Promise.all([this.policyService.initialize(), this.addressGroups.initialize()]);

    this.handlers = new ComputeHandlers(this.policyService, this.logger);

    this.logger.info('Compute service initialized');
  }

  getRoutes(): RouteDefinition[] {
    if (this.handlers == null) {
      throw new Error('ComputeService not initialized. Call initialize() first.');
    }

    return this.handlers.getRoutes();
  }

  start(reservedHttpPort?: number): ComputeStartResult {
    if (this.policyService == null || this.addressGroups == null) {
      throw new Error('ComputeService not initialized. Call initialize() first.');
    }

    const listenerPort = this.options.listenerPort ?? 8787;
    const listenerBind = this.options.listenerBind ?? '127.0.0.1';
    const defaultPolicyName = this.options.defaultPolicyName;
    const policyService = this.policyService;
    const addressGroups = this.addressGroups;

    if (reservedHttpPort != null && listenerPort === reservedHttpPort) {
      this.logger.warn(
        `Cloud Armor evaluation server port ${listenerPort} is already used by the HTTP server; Compute control plane is still available`
      );

      return { listenerStarted: false, listenerBind };
    }

    try {
      this.listenerServer = startArmorListener({
        port: listenerPort,
        hostname: listenerBind,
        defaultPolicyName,
        getPolicies: () => policyService.listAll(),
        loadAddressGroups: project => loadAddressGroupLookup(addressGroups, project),
        logger: this.logger,
      });
    } catch (error) {
      this.logger.warn(
        `Cloud Armor evaluation server failed to bind ${listenerBind}:${listenerPort}; Compute control plane is still available`,
        { error: error instanceof Error ? error.message : String(error) }
      );

      return { listenerStarted: false, listenerBind };
    }

    const boundPort = this.listenerServer.port;

    this.logger.info(`Cloud Armor evaluation server started on ${listenerBind}:${boundPort}`);

    if (boundPort != null) {
      return { listenerStarted: true, listenerPort: boundPort, listenerBind };
    }

    return { listenerStarted: true, listenerBind };
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
