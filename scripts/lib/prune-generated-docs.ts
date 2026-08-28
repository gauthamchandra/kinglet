import { join } from 'node:path';

/**
 * Remove generated markdown files that no longer correspond to a registry service.
 */
export async function pruneGeneratedMarkdown(
  directory: string,
  activeServiceNames: ReadonlySet<string>,
  options: { readonly keepIndex?: boolean } = {}
): Promise<string[]> {
  const removed: string[] = [];
  const glob = new Bun.Glob('*.md');

  for await (const file of glob.scan(directory)) {
    if (options.keepIndex && file === 'index.md') {
      continue;
    }

    const serviceName = file.replace(/\.md$/, '');

    if (!activeServiceNames.has(serviceName)) {
      const filePath = join(directory, file);

      await Bun.file(filePath).delete();
      removed.push(filePath);
    }
  }

  return removed;
}
