/**
 * Unit tests for Protocol Buffer Type Definitions and Utilities
 */

import { test, expect, describe } from 'bun:test';
import {
  dateToTimestamp,
  timestampToDate,
  millisecondsAsDuration,
  durationToMilliseconds,
  encodeBase64,
  decodeBase64,
  createStatus,
  createFieldMask,
  GrpcStatus,
  type Timestamp,
  type Duration,
  type PubsubMessage,
  type Topic,
  type Job,
  type Secret,
} from './proto-types.ts';

describe('Protocol Buffer Types', () => {
  describe('ConversionUtils', () => {
    describe('dateToTimestamp', () => {
      test('should convert JavaScript Date to Protobuf Timestamp', () => {
        const date = new Date('2023-01-01T12:00:00.123Z');
        const timestamp = dateToTimestamp(date);

        expect(timestamp.seconds).toBe('1672574400');
        expect(timestamp.nanos).toBe(123000000);
      });

      test('should handle dates with zero milliseconds', () => {
        const date = new Date('2023-01-01T12:00:00.000Z');
        const timestamp = dateToTimestamp(date);

        expect(timestamp.seconds).toBe('1672574400');
        expect(timestamp.nanos).toBe(0);
      });

      test('should handle dates with maximum milliseconds', () => {
        const date = new Date('2023-01-01T12:00:00.999Z');
        const timestamp = dateToTimestamp(date);

        expect(timestamp.seconds).toBe('1672574400');
        expect(timestamp.nanos).toBe(999000000);
      });
    });

    describe('timestampToDate', () => {
      test('should convert Protobuf Timestamp to JavaScript Date', () => {
        const timestamp: Timestamp = {
          seconds: '1672574400',
          nanos: 123000000,
        };

        const date = timestampToDate(timestamp);

        expect(date.toISOString()).toBe('2023-01-01T12:00:00.123Z');
      });

      test('should handle timestamps with zero nanos', () => {
        const timestamp: Timestamp = {
          seconds: '1672574400',
          nanos: 0,
        };

        const date = timestampToDate(timestamp);

        expect(date.toISOString()).toBe('2023-01-01T12:00:00.000Z');
      });

      test('should round trip correctly', () => {
        const originalDate = new Date('2023-06-15T08:30:45.678Z');
        const timestamp = dateToTimestamp(originalDate);
        const convertedDate = timestampToDate(timestamp);

        expect(convertedDate.getTime()).toBe(originalDate.getTime());
      });
    });

    describe('millisecondsAsDuration', () => {
      test('should convert milliseconds to Duration', () => {
        const duration = millisecondsAsDuration(1500);

        expect(duration.seconds).toBe('1');
        expect(duration.nanos).toBe(500000000);
      });

      test('should handle zero milliseconds', () => {
        const duration = millisecondsAsDuration(0);

        expect(duration.seconds).toBe('0');
        expect(duration.nanos).toBe(0);
      });

      test('should handle large values', () => {
        const duration = millisecondsAsDuration(60000); // 1 minute

        expect(duration.seconds).toBe('60');
        expect(duration.nanos).toBe(0);
      });
    });

    describe('durationToMilliseconds', () => {
      test('should convert Duration to milliseconds', () => {
        const duration: Duration = {
          seconds: '1',
          nanos: 500000000,
        };

        const milliseconds = durationToMilliseconds(duration);

        expect(milliseconds).toBe(1500);
      });

      test('should handle zero duration', () => {
        const duration: Duration = {
          seconds: '0',
          nanos: 0,
        };

        const milliseconds = durationToMilliseconds(duration);

        expect(milliseconds).toBe(0);
      });

      test('should round trip correctly', () => {
        const originalMs = 2750;
        const duration = millisecondsAsDuration(originalMs);
        const convertedMs = durationToMilliseconds(duration);

        expect(convertedMs).toBe(originalMs);
      });
    });

    describe('Base64 encoding/decoding', () => {
      test('should encode string to base64', () => {
        const input = 'Hello, World!';
        const encoded = encodeBase64(input);

        expect(encoded).toBe('SGVsbG8sIFdvcmxkIQ==');
      });

      test('should decode base64 string', () => {
        const encoded = 'SGVsbG8sIFdvcmxkIQ==';
        const decoded = decodeBase64(encoded);

        expect(decoded).toBe('Hello, World!');
      });

      test('should round trip correctly', () => {
        const original = 'This is a test message with special characters: äöü!@#$%';
        const encoded = encodeBase64(original);
        const decoded = decodeBase64(encoded);

        expect(decoded).toBe(original);
      });

      test('should handle empty string', () => {
        const encoded = encodeBase64('');
        const decoded = decodeBase64(encoded);

        expect(encoded).toBe('');
        expect(decoded).toBe('');
      });

      test('should handle JSON data', () => {
        const jsonData = JSON.stringify({ message: 'test', count: 42 });
        const encoded = encodeBase64(jsonData);
        const decoded = decodeBase64(encoded);

        expect(JSON.parse(decoded)).toEqual({ message: 'test', count: 42 });
      });
    });

    describe('createStatus', () => {
      test('should create status without details', () => {
        const status = createStatus(200, 'OK');

        expect(status.code).toBe(200);
        expect(status.message).toBe('OK');
        expect(status.details).toEqual([]);
      });

      test('should create status with details', () => {
        const details = [
          {
            '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
            reason: 'RESOURCE_NOT_FOUND',
            domain: 'googleapis.com',
          },
        ];

        const status = createStatus(404, 'Not Found', details);

        expect(status.code).toBe(404);
        expect(status.message).toBe('Not Found');
        expect(status.details).toEqual(details);
      });
    });

    describe('createFieldMask', () => {
      test('should create empty field mask', () => {
        const fieldMask = createFieldMask();

        expect(fieldMask.paths).toEqual([]);
      });

      test('should create field mask with paths', () => {
        const paths = ['name', 'labels', 'description'];
        const fieldMask = createFieldMask(paths);

        expect(fieldMask.paths).toEqual(paths);
      });
    });
  });

  describe('GrpcStatus enum', () => {
    test('should have correct status codes', () => {
      expect(GrpcStatus.OK).toBe(0);
      expect(GrpcStatus.CANCELLED).toBe(1);
      expect(GrpcStatus.UNKNOWN).toBe(2);
      expect(GrpcStatus.INVALID_ARGUMENT).toBe(3);
      expect(GrpcStatus.DEADLINE_EXCEEDED).toBe(4);
      expect(GrpcStatus.NOT_FOUND).toBe(5);
      expect(GrpcStatus.ALREADY_EXISTS).toBe(6);
      expect(GrpcStatus.PERMISSION_DENIED).toBe(7);
      expect(GrpcStatus.RESOURCE_EXHAUSTED).toBe(8);
      expect(GrpcStatus.FAILED_PRECONDITION).toBe(9);
      expect(GrpcStatus.ABORTED).toBe(10);
      expect(GrpcStatus.OUT_OF_RANGE).toBe(11);
      expect(GrpcStatus.UNIMPLEMENTED).toBe(12);
      expect(GrpcStatus.INTERNAL).toBe(13);
      expect(GrpcStatus.UNAVAILABLE).toBe(14);
      expect(GrpcStatus.DATA_LOSS).toBe(15);
      expect(GrpcStatus.UNAUTHENTICATED).toBe(16);
    });
  });

  describe('Message Types', () => {
    test('should create valid PubsubMessage', () => {
      const message: PubsubMessage = {
        data: encodeBase64('Hello, Pub/Sub!'),
        attributes: {
          source: 'test',
          timestamp: '2023-01-01T12:00:00Z',
        },
        messageId: 'msg-123',
        orderingKey: 'order-1',
      };

      expect(message.data).toBe('SGVsbG8sIFB1Yi9TdWIh');
      expect(message.attributes?.source).toBe('test');
      expect(message.messageId).toBe('msg-123');
      expect(message.orderingKey).toBe('order-1');
    });

    test('should create valid Topic', () => {
      const topic: Topic = {
        name: 'projects/test-project/topics/my-topic',
        labels: {
          environment: 'test',
          team: 'backend',
        },
        messageRetentionDuration: '604800s', // 7 days
        satisfiesPzs: true,
      };

      expect(topic.name).toBe('projects/test-project/topics/my-topic');
      expect(topic.labels?.environment).toBe('test');
      expect(topic.messageRetentionDuration).toBe('604800s');
      expect(topic.satisfiesPzs).toBe(true);
    });

    test('should create valid Job', () => {
      const job: Job = {
        name: 'projects/test-project/locations/us-central1/jobs/my-job',
        description: 'Test job',
        schedule: '0 0 * * *', // Daily at midnight
        timeZone: 'America/New_York',
        state: 'ENABLED',
        httpTarget: {
          uri: 'https://example.com/webhook',
          httpMethod: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: encodeBase64(JSON.stringify({ message: 'scheduled job' })),
        },
        retryConfig: {
          retryCount: 3,
          maxRetryDuration: '600s',
          minBackoffDuration: '5s',
          maxBackoffDuration: '300s',
          maxDoublings: 5,
        },
      };

      expect(job.name).toBe('projects/test-project/locations/us-central1/jobs/my-job');
      expect(job.schedule).toBe('0 0 * * *');
      expect(job.state).toBe('ENABLED');
      expect(job.httpTarget?.uri).toBe('https://example.com/webhook');
      expect(job.retryConfig?.retryCount).toBe(3);
    });

    test('should create valid Secret', () => {
      const secret: Secret = {
        name: 'projects/test-project/secrets/my-secret',
        labels: {
          environment: 'production',
        },
        replication: {
          automatic: {
            customerManagedEncryption: {
              kmsKeyName:
                'projects/test-project/locations/us-central1/keyRings/my-ring/cryptoKeys/my-key',
            },
          },
        },
        ttl: '3600s', // 1 hour
        annotations: {
          'managed-by': 'terraform',
        },
      };

      expect(secret.name).toBe('projects/test-project/secrets/my-secret');
      expect(secret.labels?.environment).toBe('production');
      expect(secret.replication.automatic?.customerManagedEncryption?.kmsKeyName).toBeDefined();
      expect(secret.ttl).toBe('3600s');
    });
  });

  describe('Type Safety', () => {
    test('should enforce required fields', () => {
      // This test verifies TypeScript compilation - if it compiles, the types are working
      const topic: Topic = {
        name: 'projects/test/topics/required-name', // name is required
      };

      expect(topic.name).toBeTruthy();

      const job: Job = {
        name: 'projects/test/locations/us/jobs/required-name', // name is required
      };

      expect(job.name).toBeTruthy();
    });

    test('should allow optional fields to be undefined', () => {
      const message: PubsubMessage = {
        // All fields are optional
      };

      expect(message.data).toBeUndefined();
      expect(message.attributes).toBeUndefined();
      expect(message.messageId).toBeUndefined();
    });

    test('should enforce correct enum values where applicable', () => {
      const job: Job = {
        name: 'projects/test/locations/us/jobs/test',
        state: 'ENABLED', // Should only accept valid enum values
      };

      expect(job.state).toBe('ENABLED');

      const httpMethod = 'POST' as const; // Enforce specific HTTP methods
      const httpTarget = {
        uri: 'https://example.com',
        httpMethod,
      };

      expect(httpTarget.httpMethod).toBe('POST');
    });
  });

  describe('Complex Message Construction', () => {
    test('should create complex Subscription message', () => {
      const subscription = {
        name: 'projects/test/subscriptions/complex-sub',
        topic: 'projects/test/topics/my-topic',
        ackDeadlineSeconds: 60,
        retainAckedMessages: true,
        messageRetentionDuration: '604800s',
        labels: {
          team: 'data-platform',
          env: 'prod',
        },
        enableMessageOrdering: true,
        filter: 'attributes.source="payment-service"',
        deadLetterPolicy: {
          deadLetterTopic: 'projects/test/topics/dead-letters',
          maxDeliveryAttempts: 5,
        },
        retryPolicy: {
          minimumBackoff: '10s',
          maximumBackoff: '600s',
        },
        pushConfig: {
          pushEndpoint: 'https://api.example.com/webhook',
          attributes: {
            'x-goog-version': 'v1',
          },
          oidcToken: {
            serviceAccountEmail: 'service@test-project.iam.gserviceaccount.com',
            audience: 'https://api.example.com',
          },
        },
        enableExactlyOnceDelivery: true,
        state: 'ACTIVE' as const,
      };

      expect(subscription.name).toBeTruthy();
      expect(subscription.pushConfig?.oidcToken?.serviceAccountEmail).toBeTruthy();
      expect(subscription.deadLetterPolicy?.maxDeliveryAttempts).toBe(5);
    });
  });
});
