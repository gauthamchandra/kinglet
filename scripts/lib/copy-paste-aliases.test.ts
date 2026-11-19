import { describe, expect, test } from 'bun:test';
import { findCopyPasteAliases } from './copy-paste-aliases.ts';

function findings(source: string): string[] {
  return findCopyPasteAliases(source, 'example.ts').map(
    finding => `${finding.line}:${finding.alias}->${finding.original}`
  );
}

describe('findCopyPasteAliases', () => {
  test('flags a numbered alias with the same property read', () => {
    const source = `
      function insert(body: { description?: string }) {
        const description = body.description as string | undefined;
        const description2 = body.description as string | undefined;
        return description2;
      }
    `;

    expect(findings(source)).toEqual(['4:description2->description']);
  });

  test('flags the same property read under a different assertion', () => {
    const source = `
      function insert(body: { description?: string }) {
        const description = body.description;
        const description2 = body.description as string | undefined;
        return description2;
      }
    `;

    expect(findings(source)).toEqual(['4:description2->description']);
  });

  test('flags a numbered alias of the original binding', () => {
    const source = `
      function insert(description: string) {
        const description2 = description;
        return description2;
      }
    `;

    expect(findings(source)).toEqual(['3:description2->description']);
  });

  test('flags an alias of a destructured binding', () => {
    const source = `
      function insert(body: { description?: string }) {
        const { description } = body;
        const description2 = description;
        return description2;
      }
    `;

    expect(findings(source)).toEqual(['4:description2->description']);
  });

  test('does not flag a second value with a different initializer', () => {
    const source = `
      async function list() {
        const page = await repo.list(1);
        const page2 = await repo.list(2, page.nextPageToken);
        return page2;
      }
    `;

    expect(findings(source)).toEqual([]);
  });

  test('does not flag a repeated call assigned to a numbered name', () => {
    const source = `
      async function pullTwice(service: { pull: () => Promise<unknown> }) {
        const pulled = await service.pull();
        const pulled2 = await service.pull();
        return [pulled, pulled2];
      }
    `;

    expect(findings(source)).toEqual([]);
  });

  test('does not flag matching object literals', () => {
    const source = `
      const config = { AUTH_ENABLED: 'false' };
      const config2 = { AUTH_ENABLED: 'false' };
    `;

    expect(findings(source)).toEqual([]);
  });

  test('does not flag a numbered name when the base binding is absent', () => {
    const source = `
      const env2 = EnvConfigSchema.parse({ AUTH_ENABLED: 'false' });
    `;

    expect(findings(source)).toEqual([]);
  });
});
