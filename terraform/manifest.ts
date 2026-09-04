/**
 * Terraform validation manifest — single source of truth for TDD cases.
 *
 * Workflow when adding a service:
 * 1. Add a case here (targets + kinglet services).
 * 2. Add or extend a fixture under terraform/*.tf.
 * 3. Run one case: `bun test terraform/terraform.test.ts -t "<id>"` (expect red).
 * 4. Implement kinglet API fidelity until the case passes (green).
 * 5. Run the full suite: `bun run test:terraform`.
 */

export interface TerraformValidationCase {
  /** Short id used as the bun:test name filter (`-t pubsub`). */
  readonly id: string;
  readonly description: string;
  /** kinglet SERVICES value — only enable what this case needs. */
  readonly services: readonly string[];
  /** terraform apply/plan/destroy -target flags (dependencies included via depends_on). */
  readonly targets: readonly string[];
}

export const TERRAFORM_VALIDATION_CASES = [
  {
    id: 'pubsub',
    description: 'Pub/Sub topic and pull subscription',
    services: ['pubsub'],
    targets: ['google_pubsub_topic.events', 'google_pubsub_subscription.events_pull'],
  },
  {
    id: 'kms',
    description: 'KMS key ring and crypto key',
    services: ['kms'],
    targets: ['google_kms_key_ring.encryption', 'google_kms_crypto_key.encryption'],
  },
  {
    id: 'workflows',
    description: 'Workflows sample pipeline',
    services: ['workflows'],
    targets: ['google_workflows_workflow.sample_pipeline'],
  },
  {
    id: 'tasks',
    description: 'Cloud Tasks queue with partial rate_limits',
    services: ['tasks'],
    targets: ['google_cloud_tasks_queue.dispatch'],
  },
  {
    id: 'scheduler-http',
    description: 'Cloud Scheduler HTTP target job',
    services: ['scheduler'],
    targets: ['google_cloud_scheduler_job.http_callback'],
  },
  {
    id: 'scheduler-pubsub',
    description: 'Cloud Scheduler Pub/Sub target job',
    services: ['pubsub', 'scheduler'],
    targets: ['google_pubsub_topic.events', 'google_cloud_scheduler_job.pubsub_publish'],
  },
  {
    id: 'armor',
    description: 'Cloud Armor security policy with path deny + default allow',
    services: ['compute'],
    targets: ['google_compute_security_policy.example'],
  },
] as const satisfies readonly TerraformValidationCase[];

export type TerraformValidationCaseId = (typeof TERRAFORM_VALIDATION_CASES)[number]['id'];
