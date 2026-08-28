/**
 * Normalize GCP REST paths for comparing discovery-document methods with kinglet routes.
 */

const IAM_METHOD_SUFFIXES = ['getIamPolicy', 'setIamPolicy', 'testIamPermissions'] as const;

export function isIamMethod(methodId: string): boolean {
  return IAM_METHOD_SUFFIXES.some(suffix => methodId.endsWith(`.${suffix}`) || methodId === suffix);
}

interface DiscoveryParameter {
  readonly pattern?: string;
}

/** Turn a discovery-document path into a comparable segment list. */
export function discoveryPathToSegments(
  path: string,
  parameters: Record<string, DiscoveryParameter> = {}
): string[] {
  let expanded = path.trim().replace(/^\/+/, '').replace(/\/+$/, '');

  for (const [paramName, param] of Object.entries(parameters)) {
    if (!param.pattern) {
      continue;
    }

    const wildcardPath = regexPatternToWildcardPath(param.pattern);

    expanded = expanded.replace(`{+${paramName}}`, wildcardPath);
  }

  expanded = expanded.replace(/\{name=([^}]+)\}/g, '$1');
  expanded = expanded.replace(/\{\+[^}]+\}/g, '*');
  expanded = expanded.replace(/\{[^}]+\}/g, '*');

  return expanded
    .split('/')
    .filter(segment => segment.length > 0)
    .flatMap(splitPathSegment);
}

export function kingletPathToSegments(path: string): string[] {
  const trimmed = path.trim().replace(/^\/+/, '').replace(/\/+$/, '');

  return trimmed
    .split('/')
    .filter(segment => segment.length > 0)
    .flatMap(splitPathSegment);
}

/** Discovery documents and kinglet routes sometimes use different URL prefixes. */
export function kingletPathVariants(path: string): string[] {
  const variants = new Set<string>([path]);

  if (path.startsWith('/upload/storage/v1/')) {
    variants.add(path.replace('/upload/storage/v1/', '/'));
    variants.add(path.replace('/upload/storage/v1/', ''));
  }

  if (path.startsWith('/storage/v1/')) {
    variants.add(path.replace('/storage/v1/', '/'));
    variants.add(path.replace('/storage/v1/', ''));
  }

  return [...variants];
}

export function pathsMatch(
  discoveryPath: string,
  discoveryParameters: Record<string, DiscoveryParameter>,
  kingletPath: string
): boolean {
  const discoverySegments = discoveryPathToSegments(discoveryPath, discoveryParameters);

  return kingletPathVariants(kingletPath).some(variant => {
    const kingletSegments = kingletPathToSegments(variant);

    if (discoverySegments.length !== kingletSegments.length) {
      return false;
    }

    return discoverySegments.every((segment, index) => {
      const other = kingletSegments[index];

      if (segment === '*' || other === '*') {
        return true;
      }

      return segment === other;
    });
  });
}

export function findMatchingRoute<T extends { method: string; path: string }>(
  discoveryMethod: string,
  discoveryPath: string,
  discoveryParameters: Record<string, DiscoveryParameter>,
  routes: readonly T[]
): T | undefined {
  return routes.find(
    route =>
      route.method.toUpperCase() === discoveryMethod.toUpperCase() &&
      pathsMatch(discoveryPath, discoveryParameters, route.path)
  );
}

function splitPathSegment(segment: string): string[] {
  const verbIndex = segment.lastIndexOf(':');

  if (verbIndex <= 0) {
    return [normalizeParamToken(segment)];
  }

  const resourcePart = segment.slice(0, verbIndex);
  const verb = segment.slice(verbIndex + 1);

  if (!looksLikeParameter(resourcePart)) {
    return [normalizeParamToken(segment)];
  }

  const resourceSegments = resourcePart
    .split('/')
    .filter(part => part.length > 0)
    .map(normalizeParamToken);

  return [...resourceSegments, verb];
}

function looksLikeParameter(part: string): boolean {
  return part.startsWith(':') || part.startsWith('{') || part === '*' || part.includes('*');
}

function normalizeParamToken(token: string): string {
  if (token.startsWith(':')) {
    return '*';
  }

  return token.replace(/\{name=[^}]+\}/g, '*').replace(/\{[^}]+\}/g, '*');
}

function regexPatternToWildcardPath(pattern: string): string {
  return pattern
    .replace(/^\^/, '')
    .replace(/\$$/, '')
    .replace(/\\\./g, '.')
    .replace(/\[\^\/\]\+/g, '*')
    .replace(/\[\^\/\]\*/g, '*')
    .replace(/[^a-zA-Z0-9/*._-]/g, '*');
}
