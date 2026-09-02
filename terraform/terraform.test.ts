/**
 * Terraform validation tests — TDD entry point.
 *
 * Add a case to manifest.ts + fixture .tf first, then run a single case:
 *   bun test terraform/terraform.test.ts -t "tasks"
 *
 * Full suite (CI and pre-push):
 *   bun run test:terraform
 */

import { describe, expect, test } from 'bun:test';
import { runValidationCase } from './harness.ts';
import { TERRAFORM_VALIDATION_CASES } from './manifest.ts';

const CASE_TIMEOUT_MS = 180_000;

describe('Terraform validation', () => {
  for (const validationCase of TERRAFORM_VALIDATION_CASES) {
    test(
      `${validationCase.id}: ${validationCase.description}`,
      async () => {
        const result = await runValidationCase(validationCase);

        expect(result.id).toBe(validationCase.id);
      },
      CASE_TIMEOUT_MS
    );
  }

  test('manifest defines at least one case', () => {
    expect(TERRAFORM_VALIDATION_CASES.length).toBeGreaterThan(0);
  });
});
