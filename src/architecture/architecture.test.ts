/**
 * Architecture rules via ArchUnitTS, run under bun:test with `.check()`.
 *
 * ArchUnitTS has no `toPassAsync` matcher outside Jest/Vitest/Jasmine. The
 * rules themselves are framework-agnostic.
 *
 * Copy-paste leftovers (`description2 = body.description`) are a different
 * gate: `scripts/check-copy-paste-aliases.ts`. ArchUnitTS does not detect
 * clones.
 */

import { describe, expect, test } from 'bun:test';
import { projectFiles, projectSlices } from 'archunit';

const PRODUCTION = {
  except: { withName: '*.test.ts' },
} as const;

const SERVICE_DIAGRAM = `
@startuml
component [alloydb]
component [cloudsql]
component [compute]
component [kms]
component [memorystore]
component [pubsub]
component [scheduler]
component [secrets]
component [storage]
component [tasks]
component [workflows]
@enduml
`;

async function expectArch(rule: { check: () => Promise<unknown[]> }): Promise<void> {
  const violations = await rule.check();

  expect(violations).toEqual([]);
}

describe('cycles', () => {
  test('src has no import cycles', async () => {
    await expectArch(projectFiles().inFolder('src/**').should().haveNoCycles());
  });
});

describe('service layering', () => {
  test('handlers do not import repositories', async () => {
    await expectArch(
      projectFiles()
        .inFolder('src/services/**', {
          except: { inPath: 'src/services/workflows/execution/handlers.ts' },
        })
        .withName(/handlers\.ts$/)
        .shouldNot()
        .dependOnFiles()
        .inFolder('src/services/**')
        .withName(/repository\.ts$/)
    );
  });

  test('handlers do not import storage', async () => {
    await expectArch(
      projectFiles()
        .inFolder('src/services/**')
        .withName(/handlers\.ts$/)
        .shouldNot()
        .dependOnFiles()
        .inPath('src/core/storage/**')
    );
  });

  test('handlers do not import bun:sqlite', async () => {
    await expectArch(
      projectFiles()
        .inFolder('src/services/**')
        .withName(/handlers\.ts$/)
        .should()
        .adhereTo(
          file => !/\bbun:sqlite\b/.test(file.content),
          'handlers must not import bun:sqlite'
        )
    );
  });

  test('services do not import service-layer handlers', async () => {
    await expectArch(
      projectFiles()
        .inFolder('src/services/**')
        .withName(/service\.ts$/)
        .shouldNot()
        .dependOnFiles()
        .inFolder('src/services/**')
        .withName(/handlers\.ts$/)
    );
  });

  test('repositories do not import services', async () => {
    await expectArch(
      projectFiles()
        .inFolder('src/services/**')
        .withName(/repository\.ts$/)
        .shouldNot()
        .dependOnFiles()
        .inFolder('src/services/**')
        .withName(/service\.ts$/)
    );
  });

  test('repositories do not import handlers', async () => {
    await expectArch(
      projectFiles()
        .inFolder('src/services/**')
        .withName(/repository\.ts$/)
        .shouldNot()
        .dependOnFiles()
        .inFolder('src/services/**')
        .withName(/handlers\.ts$/)
    );
  });
});

describe('service isolation', () => {
  test('GCP service folders do not import each other', async () => {
    await expectArch(
      projectSlices()
        .definedBy('src/services/(**)/')
        .should()
        .ignoringUnknownNodes()
        .ignoringExternalDependencies()
        .adhereToDiagram(SERVICE_DIAGRAM)
    );
  });
});

describe('module boundaries', () => {
  test('core does not import services', async () => {
    await expectArch(
      projectFiles()
        .inPath('src/core/**/*.ts', PRODUCTION)
        .shouldNot()
        .dependOnFiles()
        .inFolder('src/services/**')
    );
  });

  test('shared does not import services', async () => {
    await expectArch(
      projectFiles()
        .inPath('src/shared/**/*.ts', PRODUCTION)
        .shouldNot()
        .dependOnFiles()
        .inFolder('src/services/**')
    );
  });

  test('config does not import services', async () => {
    await expectArch(
      projectFiles()
        .inPath('src/config/**/*.ts', PRODUCTION)
        .shouldNot()
        .dependOnFiles()
        .inFolder('src/services/**')
    );
  });
});
