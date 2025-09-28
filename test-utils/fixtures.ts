/**
 * Test data fixtures
 */

/**
 * Mock GCP Discovery Document for Pub/Sub
 */
export const mockPubSubDiscoveryDocument = {
  kind: 'discovery#restDescription',
  discoveryVersion: 'v1',
  id: 'pubsub:v1',
  name: 'pubsub',
  version: 'v1',
  title: 'Cloud Pub/Sub API',
  description: 'Local emulator for Google Cloud Pub/Sub',
  baseUrl: 'http://localhost:9000/',
  basePath: '/v1/',
  rootUrl: 'http://localhost:9000/',
  servicePath: 'pubsub/v1/',
  resources: {
    projects: {
      resources: {
        topics: {
          methods: {
            create: {
              id: 'pubsub.projects.topics.create',
              path: 'v1/{+name}',
              httpMethod: 'PUT',
              parameters: {
                name: {
                  type: 'string',
                  required: true,
                  pattern: '^projects/[^/]+/topics/[^/]+$',
                  location: 'path',
                },
              },
              request: {
                $ref: 'Topic',
              },
              response: {
                $ref: 'Topic',
              },
            },
          },
        },
      },
    },
  },
  schemas: {
    Topic: {
      id: 'Topic',
      type: 'object',
      properties: {
        name: {
          type: 'string',
        },
        labels: {
          type: 'object',
          additionalProperties: {
            type: 'string',
          },
        },
      },
    },
  },
};

/**
 * Sample topic data
 */
export const sampleTopic = {
  name: 'projects/test-project/topics/test-topic',
  labels: {
    env: 'test',
    component: 'messaging',
  },
};

/**
 * Sample subscription data
 */
export const sampleSubscription = {
  name: 'projects/test-project/subscriptions/test-subscription',
  topic: 'projects/test-project/topics/test-topic',
  ackDeadlineSeconds: 600,
  enableMessageOrdering: false,
};

/**
 * Sample message data
 */
export const sampleMessage = {
  data: Buffer.from('Hello, World!').toString('base64'),
  attributes: {
    key1: 'value1',
    key2: 'value2',
  },
};

/**
 * Sample scheduler job data
 */
export const sampleSchedulerJob = {
  name: 'projects/test-project/locations/us-central1/jobs/test-job',
  description: 'Test scheduled job',
  schedule: '0 9 * * 1', // Every Monday at 9 AM
  timeZone: 'America/New_York',
  httpTarget: {
    uri: 'https://example.com/handler',
    httpMethod: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: Buffer.from('{"message": "scheduled"}').toString('base64'),
  },
};

/**
 * Sample task queue data
 */
export const sampleTaskQueue = {
  name: 'projects/test-project/locations/us-central1/queues/test-queue',
  rateLimits: {
    maxDispatchesPerSecond: 100,
    maxConcurrentDispatches: 50,
  },
  state: 'RUNNING' as const,
};

/**
 * Sample task data
 */
export const sampleTask = {
  name: 'projects/test-project/locations/us-central1/queues/test-queue/tasks/test-task',
  httpRequest: {
    url: 'https://example.com/task-handler',
    httpMethod: 'POST' as const,
    headers: {
      'Content-Type': 'application/json',
    },
    body: Buffer.from('{"taskData": "test"}').toString('base64'),
  },
  scheduleTime: new Date(Date.now() + 60000), // 1 minute from now
};

/**
 * Sample secret data
 */
export const sampleSecret = {
  name: 'projects/test-project/secrets/test-secret',
  labels: {
    env: 'test',
    type: 'config',
  },
};

/**
 * Sample secret version data
 */
export const sampleSecretVersion = {
  name: 'projects/test-project/secrets/test-secret/versions/1',
  state: 'ENABLED' as const,
};

/**
 * Sample secret payload
 */
export const sampleSecretPayload = {
  data: Buffer.from('secret-value').toString('base64'),
};
