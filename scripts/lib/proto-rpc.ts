/**
 * Read google.api.http bindings from a proto service.
 *
 * A path template such as {parent=projects/star/locations/star} is the same
 * shape the discovery document expands from a parameter pattern. Turn it into
 * a route path so the existing matcher can compare them.
 */

export interface ProtoHttpBinding {
  readonly method: string;
  readonly path: string;
}

export interface ProtoRpc {
  readonly name: string;
  readonly bindings: readonly ProtoHttpBinding[];
}

const HTTP_VERB = /\b(get|post|put|patch|delete):\s*"([^"]+)"/g;

export function parseServiceRpcs(source: string, serviceName: string): ProtoRpc[] {
  const header = new RegExp(`service\\s+${serviceName}\\s*\\{`);
  const match = header.exec(source);

  if (!match || match.index === undefined) {
    return [];
  }

  const body = sliceBlock(source, match.index + match[0].length - 1);
  const rpcs: ProtoRpc[] = [];
  const rpcHeader = /rpc\s+(\w+)\s*\(/g;
  let rpcMatch: RegExpExecArray | null = rpcHeader.exec(body);

  while (rpcMatch) {
    const name = rpcMatch[1] ?? '';
    const brace = body.indexOf('{', rpcMatch.index);

    if (brace < 0) {
      break;
    }

    const rpcBody = sliceBlock(body, brace);
    const bindings: ProtoHttpBinding[] = [];

    for (const verb of rpcBody.matchAll(HTTP_VERB)) {
      const method = verb[1];
      const path = verb[2];

      if (method && path) {
        bindings.push({ method, path });
      }
    }

    rpcs.push({ name, bindings });
    rpcHeader.lastIndex = brace + rpcBody.length + 2;
    rpcMatch = rpcHeader.exec(body);
  }

  return rpcs;
}

/** Expand a proto URL template into a route path the matcher understands. */
export function protoHttpPathToRoutePath(httpPath: string): string {
  const expanded = httpPath
    .replace(/\{[A-Za-z0-9_]+=([^}]+)\}/g, '$1')
    .replace(/\{[A-Za-z0-9_]+\}/g, '*');

  return expanded.startsWith('/') ? expanded : `/${expanded}`;
}

function sliceBlock(source: string, openBrace: number): string {
  let depth = 0;

  for (let i = openBrace; i < source.length; i++) {
    const char = source[i];

    if (char === '{') {
      depth++;
    } else if (char === '}') {
      depth--;

      if (depth === 0) {
        return source.slice(openBrace + 1, i);
      }
    }
  }

  return source.slice(openBrace + 1);
}
