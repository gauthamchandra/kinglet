/**
 * Unit tests for Memorystore data models, schemas, and helper functions
 */

import { describe, expect, test } from 'bun:test';
import { ResponseUtils, StandardResponseFormatter } from '@/core/gateway/response-handlers.ts';
import { Logger } from '@/shared/utils/logger.ts';
import {
  buildAclPolicyName,
  buildAclPolicyRevisionName,
  buildAuthTokenName,
  buildBackupCollectionName,
  buildBackupName,
  buildInstanceName,
  buildTokenAuthUserName,
  handleMemoryStoreError,
  type InstanceRecord,
  instanceRecordToResponse,
  instanceRequestToRecord,
  MemoryStoreError,
  parseAclPolicyName,
  parseAuthTokenName,
  parseBackupCollectionName,
  parseBackupName,
  parseInstanceName,
  parseTokenAuthUserName,
} from './types.ts';

function makeResponseUtils(): ResponseUtils {
  return new ResponseUtils(new StandardResponseFormatter(new Logger('test', 'error')));
}

describe('resource name helpers', () => {
  test('buildInstanceName_givenProjectLocationAndInstance_returnsGcpResourceName', () => {
    const name = buildInstanceName('my-project', 'us-central1', 'my-instance');

    expect(name).toBe('projects/my-project/locations/us-central1/instances/my-instance');
  });

  test('parseInstanceName_givenValidName_returnsComponents', () => {
    const parsed = parseInstanceName(
      'projects/my-project/locations/us-central1/instances/my-instance'
    );

    expect(parsed).toEqual({
      project: 'my-project',
      location: 'us-central1',
      instance: 'my-instance',
    });
  });

  test('parseInstanceName_givenMalformedName_throws', () => {
    expect(() => parseInstanceName('not-a-valid-name')).toThrow();
  });

  test('buildBackupCollectionName_roundTripsThroughParse', () => {
    const name = buildBackupCollectionName('p', 'us-central1', 'my-instance');

    expect(name).toBe('projects/p/locations/us-central1/backupCollections/my-instance');
    expect(parseBackupCollectionName(name)).toEqual({
      project: 'p',
      location: 'us-central1',
      backupCollection: 'my-instance',
    });
  });

  test('buildBackupName_roundTripsThroughParse', () => {
    const name = buildBackupName('p', 'us-central1', 'my-instance', '20260101120000_1234');

    expect(name).toBe(
      'projects/p/locations/us-central1/backupCollections/my-instance/backups/20260101120000_1234'
    );
    expect(parseBackupName(name)).toEqual({
      project: 'p',
      location: 'us-central1',
      backupCollection: 'my-instance',
      backup: '20260101120000_1234',
    });
  });

  test('buildAclPolicyName_roundTripsThroughParse', () => {
    const name = buildAclPolicyName('p', 'us-central1', 'my-policy');

    expect(name).toBe('projects/p/locations/us-central1/aclPolicies/my-policy');
    expect(parseAclPolicyName(name)).toEqual({
      project: 'p',
      location: 'us-central1',
      aclPolicy: 'my-policy',
    });
  });

  test('buildAclPolicyRevisionName_returnsGcpResourceName', () => {
    const name = buildAclPolicyRevisionName('p', 'us-central1', 'my-policy', '1');

    expect(name).toBe('projects/p/locations/us-central1/aclPolicies/my-policy/revisions/1');
  });

  test('buildTokenAuthUserName_roundTripsThroughParse', () => {
    const name = buildTokenAuthUserName('p', 'us-central1', 'my-instance', 'my-user');

    expect(name).toBe(
      'projects/p/locations/us-central1/instances/my-instance/tokenAuthUsers/my-user'
    );
    expect(parseTokenAuthUserName(name)).toEqual({
      project: 'p',
      location: 'us-central1',
      instance: 'my-instance',
      tokenAuthUser: 'my-user',
    });
  });

  test('buildAuthTokenName_returnsGcpResourceName', () => {
    const name = buildAuthTokenName('p', 'us-central1', 'my-instance', 'my-user', 'token-1');

    expect(name).toBe(
      'projects/p/locations/us-central1/instances/my-instance/tokenAuthUsers/my-user/authTokens/token-1'
    );
  });

  test('buildAuthTokenName_roundTripsThroughParse', () => {
    const name = buildAuthTokenName('p', 'us-central1', 'my-instance', 'my-user', 'token-1');

    expect(parseAuthTokenName(name)).toEqual({
      project: 'p',
      location: 'us-central1',
      instance: 'my-instance',
      tokenAuthUser: 'my-user',
      authToken: 'token-1',
    });
  });

  test('parseAuthTokenName_givenATokenAuthUserName_throwsInsteadOfReturningAPartialMatch', () => {
    const userName = buildTokenAuthUserName('p', 'us-central1', 'my-instance', 'my-user');

    expect(() => parseAuthTokenName(userName)).toThrow(/Invalid auth token resource name/);
  });
});

describe('MemoryStoreError', () => {
  test('handleMemoryStoreError_givenNotFoundCode_mapsTo404', () => {
    const err = new MemoryStoreError('NOT_FOUND', 'Instance not found', 'projects/p/.../i');

    const response = handleMemoryStoreError(err, 'Instance', makeResponseUtils());

    expect(response.status).toBe(404);
  });

  test('handleMemoryStoreError_givenAlreadyExistsCode_mapsTo409', () => {
    const err = new MemoryStoreError('ALREADY_EXISTS', 'Instance already exists', 'name');

    const response = handleMemoryStoreError(err, 'Instance', makeResponseUtils());

    expect(response.status).toBe(409);
  });

  test('handleMemoryStoreError_givenInvalidArgumentCode_mapsTo400', () => {
    const err = new MemoryStoreError('INVALID_ARGUMENT', 'Bad request');

    const response = handleMemoryStoreError(err, 'Instance', makeResponseUtils());

    expect(response.status).toBe(400);
  });

  test('handleMemoryStoreError_givenFailedPreconditionCode_mapsTo400', () => {
    const err = new MemoryStoreError('FAILED_PRECONDITION', 'Etag mismatch');

    const response = handleMemoryStoreError(err, 'AclPolicy', makeResponseUtils());

    expect(response.status).toBe(400);
  });

  test('handleMemoryStoreError_whenTheErrorCarriesItsOwnResourceType_reportsItInsteadOfTheHandlers', () => {
    const err = new MemoryStoreError(
      'ALREADY_EXISTS',
      'Backup already exists',
      'projects/p/locations/us-central1/backupCollections/i/backups/b',
      'Backup'
    );

    // 'Instance' is what instances.backup's handler passes, since that is the
    // route's primary resource; the conflict is a Backup.
    const response = handleMemoryStoreError(err, 'Instance', makeResponseUtils());
    const body = response.body as {
      error: { message: string; details: { resourceType: string }[] };
    };

    expect(response.status).toBe(409);
    expect(body.error.message).toStartWith('Backup projects/p/');
    expect(body.error.details[0]?.resourceType).toBe('Backup');
  });

  test('handleMemoryStoreError_givenUnexpectedError_mapsTo500', () => {
    const response = handleMemoryStoreError(new Error('boom'), 'Instance', makeResponseUtils());

    expect(response.status).toBe(500);
  });
});

describe('instance record <-> response conversion', () => {
  const baseRecord: InstanceRecord = {
    id: 'row-1',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-02T00:00:00.000Z'),
    name: 'projects/p/locations/us-central1/instances/my-instance',
    uid: 'uid-123',
    state: 'ACTIVE',
    replicaCount: 1,
    shardCount: 2,
    nodeType: 'HIGHMEM_MEDIUM',
    mode: 'STANDALONE',
    authorizationMode: 'AUTH_DISABLED',
    transitEncryptionMode: 'TRANSIT_ENCRYPTION_DISABLED',
    engineVersion: 'VALKEY_7_2',
    labels: JSON.stringify({ env: 'test' }),
    nodeConfig: JSON.stringify({ sizeGb: 1.5 }),
    stateInfo: null,
    discoveryEndpoints: JSON.stringify([{ address: '127.0.0.1', port: 7000 }]),
    pscAttachmentDetails: null,
    backupCollection: 'projects/p/locations/us-central1/backupCollections/my-instance',
    aclPolicy: null,
    aclPolicyInfo: null,
    aclPolicyInSync: 0,
    endpoints: null,
    maintenanceSchedule: null,
    migrationConfig: null,
    encryptionInfo: null,
    satisfiesPzi: 0,
    satisfiesPzs: 1,
    availableMaintenanceVersions: null,
    effectiveMaintenanceVersion: null,
    deletionProtectionEnabled: 0,
    engineConfigs: null,
    zoneDistributionConfig: null,
    persistenceConfig: null,
    automatedBackupConfig: null,
    maintenancePolicy: null,
    crossInstanceReplicationConfig: null,
  };

  test('instanceRecordToResponse_parsesJsonColumnsBackIntoObjects', () => {
    const response = instanceRecordToResponse(baseRecord);

    expect(response.nodeConfig).toEqual({ sizeGb: 1.5 });
    expect(response.discoveryEndpoints).toEqual([{ address: '127.0.0.1', port: 7000 }]);
    expect(response.labels).toEqual({ env: 'test' });
  });

  test('instanceRecordToResponse_convertsZeroOneColumnsToBooleans', () => {
    const response = instanceRecordToResponse(baseRecord);

    expect(response.satisfiesPzi).toBe(false);
    expect(response.satisfiesPzs).toBe(true);
    expect(response.aclPolicyInSync).toBe(false);
    expect(response.deletionProtectionEnabled).toBe(false);
  });

  test('instanceRecordToResponse_echoesRequestedTopologyFields', () => {
    const response = instanceRecordToResponse(baseRecord);

    expect(response.shardCount).toBe(2);
    expect(response.replicaCount).toBe(1);
  });

  test('instanceRecordToResponse_mirrorsDiscoveryEndpointsOntoTheModernPscEndpointsPath', () => {
    const response = instanceRecordToResponse(baseRecord);

    expect(response.endpoints).toEqual([
      {
        connections: [
          {
            pscAutoConnection: {
              ipAddress: '127.0.0.1',
              port: 7000,
              connectionType: 'CONNECTION_TYPE_DISCOVERY',
              pscConnectionStatus: 'ACTIVE',
            },
          },
        ],
      },
    ]);
  });

  test('instanceRecordToResponse_withoutDiscoveryEndpoints_doesNotSynthesizeEndpoints', () => {
    const response = instanceRecordToResponse({ ...baseRecord, discoveryEndpoints: null });

    expect(response.endpoints).toBeUndefined();
  });

  test('instanceRecordToResponse_withClientSuppliedEndpoints_leavesThemUntouchedInsteadOfMirroring', () => {
    const clientEndpoints = [{ connections: [{ pscConnection: { port: 9999 } }] }];
    const response = instanceRecordToResponse({
      ...baseRecord,
      endpoints: JSON.stringify(clientEndpoints),
    });

    expect(response.endpoints).toEqual(clientEndpoints);
  });

  test('instanceRequestToRecord_stripsClientSuppliedReadOnlyFields', () => {
    const record = instanceRequestToRecord(
      'projects/p/locations/us-central1/instances/my-instance',
      {
        uid: 'client-supplied-uid',
        createTime: '2020-01-01T00:00:00.000Z',
        state: 'DELETING',
        nodeConfig: { sizeGb: 999 },
        discoveryEndpoints: [{ address: '9.9.9.9', port: 1 }],
        backupCollection: 'projects/p/locations/us-central1/backupCollections/spoofed',
        replicaCount: 1,
        shardCount: 1,
      }
    );

    // Positive assertions: a mapper that simply forgets to generate a `uid`
    // (leaving it `undefined`) or forgets to set `createTime` also satisfies
    // `not.toBe('client-supplied-uid')` / a missing assertion, so both must
    // be pinned to what the mapper is actually supposed to produce.
    expect(record.uid).toMatch(
      /^[0-9a-f-]{8}-[0-9a-f-]{4}-[0-9a-f-]{4}-[0-9a-f-]{4}-[0-9a-f-]{12}$/
    );
    expect(record.state).toBe('CREATING');
    expect(record.nodeConfig).toBeNull();
    expect(record.discoveryEndpoints).toBeNull();
    expect(record.backupCollection).toBeNull();

    // createTime is a `timestamps: true` StorageManager column, not something
    // the mapper is responsible for — the client's 2020 date must not survive
    // onto the record the repository is handed.
    expect((record as Record<string, unknown>).createTime).toBeUndefined();
  });

  test('instanceRequestToRecord_keepsClientSuppliedTopologyFields', () => {
    const record = instanceRequestToRecord(
      'projects/p/locations/us-central1/instances/my-instance',
      {
        replicaCount: 3,
        shardCount: 5,
        nodeType: 'STANDARD_SMALL',
        labels: { env: 'prod' },
      }
    );

    expect(record.replicaCount).toBe(3);
    expect(record.shardCount).toBe(5);
    expect(record.nodeType).toBe('STANDARD_SMALL');
    expect(record.labels).toBe(JSON.stringify({ env: 'prod' }));
  });
});
