/**
 * Parse Google REST discovery documents and extract API methods.
 */

import { findMatchingRoute, isIamMethod } from './path-matching.ts';

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
  // do not churn.
  methods.sort((a, b) => compareMethodIds(a.id, b.id));

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

export interface ClassifiedDiscoveryMethods {
  readonly implemented: DiscoveryMethod[];
  readonly missing: DiscoveryMethod[];
  readonly iamImplemented: DiscoveryMethod[];
  readonly iamDeferred: DiscoveryMethod[];
}

/**
 * IAM methods with a matching route are implemented. They stay out of the
 * coverage percentage, which only counts `implemented` and `missing`.
 */
export function classifyDiscoveryMethods(
  methods: readonly DiscoveryMethod[],
  routes: readonly { method: string; path: string }[]
): ClassifiedDiscoveryMethods {
  const implemented: DiscoveryMethod[] = [];
  const missing: DiscoveryMethod[] = [];
  const iamImplemented: DiscoveryMethod[] = [];
  const iamDeferred: DiscoveryMethod[] = [];

  for (const method of methods) {
    const match = findMatchingRoute(method.httpMethod, method.path, method.parameters, routes);

    if (isIamMethod(method.id)) {
      if (match) {
        iamImplemented.push(method);
      } else {
        iamDeferred.push(method);
      }

      continue;
    }

    if (match) {
      implemented.push(method);
    } else {
      missing.push(method);
    }
  }

  return { implemented, missing, iamImplemented, iamDeferred };
}

/** Keep methods whose ids sit under a registry resource prefix. No prefixes means all methods. */
export function selectRegistryMethods<T extends { id: string }>(
  methods: readonly T[],
  resources: readonly string[] | undefined
): T[] {
  if (!resources) {
    return [...methods];
  }

  return methods.filter(method => resources.some(resource => method.id.startsWith(`${resource}.`)));
}

/**
 * Order by resource path first, then method name, so a resource's own methods stay
 * together instead of being split apart by an alphabetically earlier child resource.
 * A parent resource sorts before its children. Comparison is byte-wise rather than
 * localeCompare so ordering does not depend on the runner's ICU locale.
 */
function compareMethodIds(a: string, b: string): number {
  const aSegments = a.split('.');
  const bSegments = b.split('.');
  const aResource = aSegments.slice(0, -1);
  const bResource = bSegments.slice(0, -1);
  const shared = Math.min(aResource.length, bResource.length);

  for (let i = 0; i < shared; i++) {
    const aPart = aResource[i] ?? '';
    const bPart = bResource[i] ?? '';

    if (aPart !== bPart) {
      return aPart < bPart ? -1 : 1;
    }
  }

  if (aResource.length !== bResource.length) {
    return aResource.length - bResource.length;
  }

  const aMethod = aSegments[aSegments.length - 1] ?? '';
  const bMethod = bSegments[bSegments.length - 1] ?? '';

  return aMethod < bMethod ? -1 : aMethod > bMethod ? 1 : 0;
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
