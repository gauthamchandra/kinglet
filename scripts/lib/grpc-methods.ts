/**
 * gRPC methods a service actually registers.
 *
 * `index.ts` calls `getGrpcServices()` or `getGrpcService()` and passes each
 * definition to the gRPC server. The implementation object's keys are the
 * RPCs. A unary handler that answers UNIMPLEMENTED for an empty request is a
 * stub, not an implementation.
 */

import * as grpc from '@grpc/grpc-js';
import type { GrpcServiceDefinition } from '@/core/gateway/grpc-server.ts';
import { parseServiceRpcs, protoHttpPathToRoutePath } from './proto-rpc.ts';

export interface RegisteredGrpcMethod {
  readonly service: string;
  readonly rpc: string;
  /** REST paths from `google.api.http`. Empty when the RPC has no REST binding. */
  readonly routes: readonly { method: string; path: string }[];
}

interface GrpcSource {
  getGrpcServices?: () => GrpcServiceDefinition[];
  getGrpcService?: () => GrpcServiceDefinition;
}

export async function registeredGrpcMethods(service: object): Promise<RegisteredGrpcMethod[]> {
  const source = service as GrpcSource;
  const definitions: GrpcServiceDefinition[] = [];

  if (typeof source.getGrpcServices === 'function') {
    definitions.push(...source.getGrpcServices());
  } else if (typeof source.getGrpcService === 'function') {
    definitions.push(source.getGrpcService());
  }

  const methods: RegisteredGrpcMethod[] = [];

  for (const definition of definitions) {
    const sourceText = await Bun.file(definition.protoPath).text();
    const rpcs = parseServiceRpcs(sourceText, definition.serviceName);
    const implementation = definition.implementation as Record<string, unknown>;

    if (rpcs.length === 0) {
      throw new Error(
        `No RPCs parsed for ${definition.packageName}.${definition.serviceName} in ${definition.protoPath}`
      );
    }

    for (const rpc of rpcs) {
      const handler = implementation[rpc.name];

      if (typeof handler !== 'function') {
        continue;
      }

      if (await handlerAnswersUnimplemented(handler as GrpcHandler)) {
        continue;
      }

      methods.push({
        service: definition.serviceName,
        rpc: rpc.name,
        routes: rpc.bindings.map(binding => ({
          method: binding.method,
          path: protoHttpPathToRoutePath(binding.path),
        })),
      });
    }
  }

  return methods;
}

type GrpcHandler = (
  call: { request: Record<string, never> },
  callback: (err: unknown) => void
) => unknown;

/** True when the handler is the unary UNIMPLEMENTED stub the server still registers. */
export async function handlerAnswersUnimplemented(handler: GrpcHandler): Promise<boolean> {
  if (handler.length !== 2) {
    return false;
  }

  return new Promise(resolve => {
    let settled = false;
    const timer = setTimeout(() => finish(false), 100);

    const finish = (value: boolean) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timer);
      resolve(value);
    };

    try {
      const result = handler({ request: {} }, err => {
        finish(isUnimplemented(err));
      });

      if (isPromise(result)) {
        result.then(
          () => finish(false),
          () => finish(false)
        );
      }
    } catch {
      finish(false);
    }
  });
}

function isUnimplemented(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: number }).code === grpc.status.UNIMPLEMENTED
  );
}

function isPromise(value: unknown): value is Promise<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    'then' in value &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}
