/**
 * Parse Google REST discovery documents and extract API methods.
 */

import { isIamMethod } from './path-matching.ts';

export interface DiscoveryMethod {
  readonly id: string;
  readonly httpMethod: string;
  readonly path: string;
  readonly description?: string;
  readonly parameters: Record<string, { readonly pattern?: string }>;
}

export interface DiscoveryDocument {
  readonly title: string;
  readonly version: string;
  readonly methods: DiscoveryMethod[];
}

interface RawDiscoveryMethod {
  readonly httpMethod?: string;
  readonly path?: string;
  readonly description?: string;
  readonly parameters?: Record<string, { readonly pattern?: string }>;
}

interface RawDiscoveryResource {
  readonly methods?: Record<string, RawDiscoveryMethod>;
  readonly resources?: Record<string, RawDiscoveryResource>;
}

interface RawDiscoveryDocument {
  readonly title?: string;
  readonly version?: string;
  readonly resources?: Record<string, RawDiscoveryResource>;
}

export function parseDiscoveryDocument(json: string): DiscoveryDocument {
  const doc = JSON.parse(json) as RawDiscoveryDocument;
  const methods: DiscoveryMethod[] = [];

  walkResources(doc.resources ?? {}, (methodId, method) => {
    if (!method.httpMethod || !method.path) {
      return;
    }

    methods.push({
      id: methodId,
      httpMethod: method.httpMethod,
      path: method.path,
      description: method.description,
      parameters: method.parameters ?? {},
    });
  });

  // Discovery JSON key order is not stable across fetches; sort so regenerated docs
  // do not churn. Byte comparison rather than localeCompare keeps it locale-independent.
  methods.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  return {
    title: doc.title ?? 'Unknown API',
    version: doc.version ?? 'unknown',
    methods,
  };
}

export function partitionDiscoveryMethods(methods: readonly DiscoveryMethod[]): {
  readonly comparable: DiscoveryMethod[];
  readonly iamDeferred: DiscoveryMethod[];
} {
  const comparable: DiscoveryMethod[] = [];
  const iamDeferred: DiscoveryMethod[] = [];

  for (const method of methods) {
    if (isIamMethod(method.id)) {
      iamDeferred.push(method);
      continue;
    }

    comparable.push(method);
  }

  return { comparable, iamDeferred };
}

function walkResources(
  resources: Record<string, RawDiscoveryResource>,
  onMethod: (methodId: string, method: RawDiscoveryMethod) => void,
  prefix = ''
): void {
  for (const [resourceName, resource] of Object.entries(resources)) {
    const resourcePrefix = prefix ? `${prefix}.${resourceName}` : resourceName;

    for (const [methodName, method] of Object.entries(resource.methods ?? {})) {
      onMethod(`${resourcePrefix}.${methodName}`, method);
    }

    if (resource.resources) {
      walkResources(resource.resources, onMethod, resourcePrefix);
    }
  }
}
