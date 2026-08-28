import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { extractRoutesForService } from './extract-service-routes.ts';
import { pruneGeneratedMarkdown } from './prune-generated-docs.ts';

describe('extractRoutesForService', () => {
  test('extracts scheduler routes including shared v1 locations', async () => {
    const routes = await extractRoutesForService('cloud-scheduler');

    expect(routes.length).toBeGreaterThan(5);
    expect(routes.some(route => route.id === 'scheduler.jobs.create')).toBe(true);
    expect(routes.some(route => route.path === '/v1/projects/:project/locations')).toBe(true);
  });

  test('returns an empty route list for planned services without routes', async () => {
    const routes = await extractRoutesForService('secret-manager');

    expect(routes).toEqual([]);
  });

  test('throws when a registry service has no route extractor', async () => {
    await expect(extractRoutesForService('unknown-service')).rejects.toThrow(
      'No route extractor registered for service "unknown-service"'
    );
  });
});

describe('pruneGeneratedMarkdown', () => {
  test('removes markdown files for services no longer in the registry', async () => {
    const directory = join(import.meta.dir, '.tmp-prune-test');
    await Bun.$`mkdir -p ${directory}`.quiet();
    await Bun.write(join(directory, 'cloud-tasks.md'), '# old');
    await Bun.write(join(directory, 'retired-service.md'), '# stale');
    await Bun.write(join(directory, 'index.md'), '# index');

    const removed = await pruneGeneratedMarkdown(directory, new Set(['cloud-tasks']), {
      keepIndex: true,
    });

    expect(removed.some(path => path.endsWith('retired-service.md'))).toBe(true);
    expect(await Bun.file(join(directory, 'cloud-tasks.md')).exists()).toBe(true);
    expect(await Bun.file(join(directory, 'index.md')).exists()).toBe(true);
    expect(await Bun.file(join(directory, 'retired-service.md')).exists()).toBe(false);

    await Bun.$`rm -rf ${directory}`.quiet();
  });
});
