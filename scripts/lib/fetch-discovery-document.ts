import { join } from 'node:path';

const ROOT = join(import.meta.dir, '../..');
export const DISCOVERY_CACHE_DIR = join(ROOT, '.discovery-cache');

export function isRemoteDiscoveryUrl(url: string): boolean {
  return url.startsWith('http://') || url.startsWith('https://');
}

export function discoveryCachePath(serviceName: string): string {
  return join(DISCOVERY_CACHE_DIR, `${serviceName}.json`);
}

interface FetchDiscoveryOptions {
  readonly useCache?: boolean;
}

export async function fetchDiscoveryDocument(
  serviceName: string,
  discoveryUrl: string,
  options: FetchDiscoveryOptions = {}
): Promise<string | null> {
  if (!isRemoteDiscoveryUrl(discoveryUrl)) {
    return null;
  }

  const cachePath = discoveryCachePath(serviceName);
  const cacheFile = Bun.file(cachePath);

  if (options.useCache && (await cacheFile.exists())) {
    return cacheFile.text();
  }

  const response = await fetch(discoveryUrl);

  if (!response.ok) {
    throw new Error(
      `Failed to fetch discovery document for ${serviceName}: ${response.status} ${response.statusText}`
    );
  }

  const body = await response.text();

  await Bun.write(cachePath, body);

  return body;
}
