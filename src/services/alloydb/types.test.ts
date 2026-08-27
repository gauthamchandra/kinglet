import { describe, expect, test } from 'bun:test';
import { ResponseUtils, StandardResponseFormatter } from '@/core/gateway/response-handlers.ts';
import { Logger } from '@/shared/utils/logger.ts';
import {
  ALLOYDB_CLUSTERS_TABLE,
  ALLOYDB_INSTANCES_TABLE,
  ALLOYDB_USERS_TABLE,
  AlloyDbError,
  buildClusterName,
  buildConnectionInfo,
  buildConnectionInfoName,
  buildInstanceName,
  buildUserName,
  ClusterState,
  ClusterType,
  clusterRecordToResponse,
  clusterRequestToRecord,
  clusterTableSchema,
  handleAlloyDbError,
  INSTANCE_TYPE_ENUM,
  InstanceState,
  InstanceType,
  instanceRecordToResponse,
  instanceRequestToRecord,
  instanceTableSchema,
  isValidClusterId,
  isValidInstanceId,
  MUTABLE_CLUSTER_FIELDS,
  MUTABLE_INSTANCE_FIELDS,
  MUTABLE_USER_FIELDS,
  normalizeEnum,
  USER_TYPE_ENUM,
  UserType,
  userRecordToResponse,
  userRequestToRecord,
  userTableSchema,
} from './types.ts';

const responseUtils = new ResponseUtils(new StandardResponseFormatter(new Logger('test', 'error')));

const CLUSTER_NAME = 'projects/p/locations/us-central1/clusters/c1';
const INSTANCE_NAME = `${CLUSTER_NAME}/instances/i1`;

function errorBody(response: { body?: unknown }): {
  error: { code: number; message: string; status: string };
} {
  return response.body as { error: { code: number; message: string; status: string } };
}

describe('resource names', () => {
  test('buildClusterName_matchesTheDiscoveryDocumentFormat', () => {
    expect(buildClusterName('p', 'us-central1', 'c1')).toBe(CLUSTER_NAME);
  });

  test('buildInstanceName_nestsUnderItsCluster', () => {
    expect(buildInstanceName('p', 'us-central1', 'c1', 'i1')).toBe(INSTANCE_NAME);
  });

  /**
   * The discovery document's `User.name` *description* says
   * `…/cluster/{cluster}/users/…` (singular), but the `name` parameter pattern
   * and every `flatPath` say `clusters` (plural). The pattern is authoritative —
   * a singular segment would 404 against the real API.
   */
  test('buildUserName_usesThePluralClustersSegmentFromTheNameParameterPattern', () => {
    expect(buildUserName('p', 'us-central1', 'c1', 'admin')).toBe(`${CLUSTER_NAME}/users/admin`);
    expect(buildUserName('p', 'us-central1', 'c1', 'admin')).not.toContain('/cluster/');
  });

  test('buildConnectionInfoName_isTheSingletonSubresourceOfAnInstance', () => {
    expect(buildConnectionInfoName('p', 'us-central1', 'c1', 'i1')).toBe(
      `${INSTANCE_NAME}/connectionInfo`
    );
  });
});

describe('resource id validation', () => {
  test.each(['c1', 'my-cluster', 'a', '0-9', 'a'.repeat(63)])('isValidClusterId_accepts_%s', id => {
    expect(isValidClusterId(id)).toBe(true);
  });

  /**
   * Uppercase must be rejected because the discovery document's regex admits
   * lowercase only — accepting an id real AlloyDB refuses would let a resource
   * work locally and fail on deploy.
   */
  test.each([
    'MyCluster',
    'c_1',
    'c.1',
    '',
    'a'.repeat(64),
    'has space',
  ])('isValidClusterId_rejects_%s', id => {
    expect(isValidClusterId(id)).toBe(false);
  });

  test.each([
    'i1',
    'my-instance',
    'a',
    'a9',
    `a${'b'.repeat(61)}c`,
  ])('isValidInstanceId_accepts_%s', id => {
    expect(isValidInstanceId(id)).toBe(true);
  });

  // Instance IDs are stricter than cluster IDs: they must start with a letter
  // and end alphanumeric. `0-9` is a legal cluster id but an illegal instance id.
  test.each([
    '0-9',
    '1abc',
    'abc-',
    'MyInstance',
    '',
    'a'.repeat(64),
  ])('isValidInstanceId_rejects_%s', id => {
    expect(isValidInstanceId(id)).toBe(false);
  });

  test('isValidInstanceId_isStricterThanIsValidClusterId', () => {
    expect(isValidClusterId('0-9')).toBe(true);
    expect(isValidInstanceId('0-9')).toBe(false);
  });
});

describe('AlloyDbError', () => {
  test('constructor_retainsCodeAndResourceName', () => {
    const error = new AlloyDbError('NOT_FOUND', 'gone', CLUSTER_NAME);

    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe('NOT_FOUND');
    expect(error.resourceName).toBe(CLUSTER_NAME);
    expect(error.message).toBe('gone');
  });

  // The HTTP code and GCP status string must be a correct pair — client
  // libraries branch on the pair, so a 400/ALREADY_EXISTS mismatch makes them
  // give up instead of surfacing a retryable conflict.
  test.each([
    ['NOT_FOUND', 404, 'NOT_FOUND'],
    ['ALREADY_EXISTS', 409, 'ALREADY_EXISTS'],
    ['INVALID_ARGUMENT', 400, 'INVALID_ARGUMENT'],
    ['FAILED_PRECONDITION', 400, 'FAILED_PRECONDITION'],
    ['ABORTED', 409, 'ABORTED'],
  ] as const)('handleAlloyDbError_maps_%s_to_%i', (code, httpStatus, statusString) => {
    const response = handleAlloyDbError(
      new AlloyDbError(code, 'boom', CLUSTER_NAME),
      'Cluster',
      responseUtils
    );

    expect(response.status).toBe(httpStatus);
    expect(errorBody(response).error.status).toBe(statusString);
    expect(errorBody(response).error.code).toBe(httpStatus);
  });

  test('handleAlloyDbError_givenAnUnknownError_returns500Internal', () => {
    const response = handleAlloyDbError(new Error('unexpected'), 'Cluster', responseUtils);

    expect(response.status).toBe(500);
    expect(errorBody(response).error.status).toBe('INTERNAL');
  });

  test('handleAlloyDbError_givenAnOverriddenResourceType_reportsTheSubResource', () => {
    const response = handleAlloyDbError(
      new AlloyDbError('ALREADY_EXISTS', 'dupe', `${CLUSTER_NAME}/users/admin`, 'User'),
      'Cluster',
      responseUtils
    );

    expect(errorBody(response).error.message).toContain('User');
  });
});

describe('mutable field sets', () => {
  // Derived from the discovery document's readOnly flags: a PATCH naming an
  // output-only field must 400 rather than silently no-op.
  test('MUTABLE_CLUSTER_FIELDS_excludesEveryOutputOnlyClusterField', () => {
    for (const readOnlyField of [
      'name',
      'uid',
      'state',
      'clusterType',
      'createTime',
      'updateTime',
      'deleteTime',
      'reconciling',
      'satisfiesPzs',
      'migrationSource',
      'backupSource',
      'encryptionInfo',
      'continuousBackupInfo',
      'primaryConfig',
      'trialMetadata',
    ]) {
      expect(MUTABLE_CLUSTER_FIELDS.has(readOnlyField)).toBe(false);
    }
  });

  test('MUTABLE_CLUSTER_FIELDS_includesTheWritableClusterFields', () => {
    for (const field of [
      'displayName',
      'labels',
      'annotations',
      'databaseVersion',
      'network',
      'networkConfig',
      'automatedBackupPolicy',
      'continuousBackupConfig',
      'initialUser',
    ]) {
      expect(MUTABLE_CLUSTER_FIELDS.has(field)).toBe(true);
    }
  });

  test('MUTABLE_INSTANCE_FIELDS_excludesEveryOutputOnlyInstanceField', () => {
    for (const readOnlyField of [
      'name',
      'uid',
      'state',
      'createTime',
      'updateTime',
      'deleteTime',
      'ipAddress',
      'publicIpAddress',
      'nodes',
      'writableNode',
      'reconciling',
      'satisfiesPzs',
      'outboundPublicIpAddresses',
      'maintenanceVersionName',
    ]) {
      expect(MUTABLE_INSTANCE_FIELDS.has(readOnlyField)).toBe(false);
    }
  });

  test('MUTABLE_INSTANCE_FIELDS_includesTheWritableInstanceFields', () => {
    for (const field of [
      'displayName',
      'labels',
      'instanceType',
      'machineConfig',
      'availabilityType',
      'databaseFlags',
      'readPoolConfig',
      'gceZone',
    ]) {
      expect(MUTABLE_INSTANCE_FIELDS.has(field)).toBe(true);
    }
  });

  test('MUTABLE_USER_FIELDS_matchesTheDiscoveryDocumentAndExcludesName', () => {
    expect([...MUTABLE_USER_FIELDS].sort()).toEqual([
      'databaseRoles',
      'keepExtraRoles',
      'password',
      'userType',
    ]);
    expect(MUTABLE_USER_FIELDS.has('name')).toBe(false);
  });
});

describe('cluster conversion', () => {
  test('clusterRequestToRecord_setsServerOwnedFieldsAndReadyState', () => {
    const record = clusterRequestToRecord(CLUSTER_NAME, {
      initialUser: { user: 'postgres', password: 'hunter2' },
      network: 'projects/p/global/networks/default',
    });

    expect(record.name).toBe(CLUSTER_NAME);
    expect(record.uid).toBeTypeOf('string');
    expect(record.uid.length).toBeGreaterThan(0);
    // LROs complete instantly in the emulator, so a cluster is never observably
    // CREATING — it is READY by the time the Operation reports done.
    expect(record.state).toBe(ClusterState.READY);
    expect(record.clusterType).toBe(ClusterType.PRIMARY);
    expect(record.createTime).toBeTypeOf('string');
    expect(record.reconciling).toBe(0);
  });

  /**
   * `Cluster.initialUser` is input-only and carries a password. Real AlloyDB
   * never returns it, and the emulator must never persist the secret either —
   * only the username, which the data plane will need to create the role.
   */
  test('clusterRequestToRecord_persistsTheInitialUsernameButNeverThePassword', () => {
    const record = clusterRequestToRecord(CLUSTER_NAME, {
      initialUser: { user: 'postgres', password: 'hunter2' },
    });

    expect(record.initialUserName).toBe('postgres');
    expect(JSON.stringify(record)).not.toContain('hunter2');
  });

  test('clusterRecordToResponse_omitsInitialUserEntirely', () => {
    const response = clusterRecordToResponse(
      clusterRequestToRecord(CLUSTER_NAME, {
        initialUser: { user: 'postgres', password: 'hunter2' },
      })
    );

    expect(response).not.toHaveProperty('initialUser');
    expect(JSON.stringify(response)).not.toContain('hunter2');
    expect(JSON.stringify(response)).not.toContain('postgres');
  });

  test('clusterRecordToResponse_roundTripsWritableFieldsTheEmulatorDoesNotModel', () => {
    const record = clusterRequestToRecord(CLUSTER_NAME, {
      initialUser: { user: 'postgres' },
      labels: { env: 'dev' },
      annotations: { team: 'payments' },
      automatedBackupPolicy: { enabled: true, location: 'us-central1' },
      databaseVersion: 'POSTGRES_16',
    });

    const response = clusterRecordToResponse(record);

    expect(response.labels).toEqual({ env: 'dev' });
    expect(response.annotations).toEqual({ team: 'payments' });
    expect(response.automatedBackupPolicy).toEqual({ enabled: true, location: 'us-central1' });
    expect(response.databaseVersion).toBe('POSTGRES_16');
  });

  test('clusterRequestToRecord_dropsOutputOnlyFieldsSuppliedByTheClient', () => {
    const record = clusterRequestToRecord(CLUSTER_NAME, {
      initialUser: { user: 'postgres' },
      name: 'projects/evil/locations/nowhere/clusters/spoofed',
      uid: 'client-supplied-uid',
      state: 'FAILED',
    });

    const response = clusterRecordToResponse(record);

    expect(response.name).toBe(CLUSTER_NAME);
    expect(response.uid).not.toBe('client-supplied-uid');
    expect(response.state).toBe(ClusterState.READY);
  });

  test('clusterRecordToResponse_reportsReconcilingAsABooleanNotSqlitesInteger', () => {
    const response = clusterRecordToResponse(
      clusterRequestToRecord(CLUSTER_NAME, { initialUser: { user: 'postgres' } })
    );

    expect(response.reconciling).toBe(false);
  });
});

describe('instance conversion', () => {
  test('instanceRequestToRecord_defaultsToPrimaryAndReadyState', () => {
    const record = instanceRequestToRecord(INSTANCE_NAME, { instanceType: 'PRIMARY' });

    expect(record.name).toBe(INSTANCE_NAME);
    expect(record.state).toBe(InstanceState.READY);
    expect(record.instanceType).toBe(InstanceType.PRIMARY);
    expect(record.uid).toBeTypeOf('string');
  });

  test('instanceRequestToRecord_retainsTheRequestedInstanceType', () => {
    const record = instanceRequestToRecord(INSTANCE_NAME, { instanceType: 'READ_POOL' });

    expect(record.instanceType).toBe(InstanceType.READ_POOL);
  });

  /**
   * There is no data plane in this release, but the response shape must still be
   * the real one so client code reads the same field it will read later. The
   * address is loopback rather than a plausible 10.x private IP so nobody
   * mistakes it for something they can connect to yet.
   */
  test('instanceRecordToResponse_reportsALoopbackIpAddressPlaceholder', () => {
    const response = instanceRecordToResponse(
      instanceRequestToRecord(INSTANCE_NAME, { instanceType: 'PRIMARY' })
    );

    expect(response.ipAddress).toBe('127.0.0.1');
  });

  test('buildConnectionInfo_reportsTheInstancesOwnUid', () => {
    const record = instanceRequestToRecord(INSTANCE_NAME, { instanceType: 'PRIMARY' });
    const connectionInfo = buildConnectionInfo(record);

    expect(connectionInfo.name).toBe(`${INSTANCE_NAME}/connectionInfo`);
    expect(connectionInfo.instanceUid).toBe(record.uid);
    expect(connectionInfo.ipAddress).toBe('127.0.0.1');
  });

  test('instanceRecordToResponse_roundTripsWritableFieldsTheEmulatorDoesNotModel', () => {
    const record = instanceRequestToRecord(INSTANCE_NAME, {
      instanceType: 'READ_POOL',
      readPoolConfig: { nodeCount: 3 },
      databaseFlags: { 'alloydb.enable_pgaudit': 'on' },
      machineConfig: { cpuCount: 4 },
    });

    const response = instanceRecordToResponse(record);

    expect(response.readPoolConfig).toEqual({ nodeCount: 3 });
    expect(response.databaseFlags).toEqual({ 'alloydb.enable_pgaudit': 'on' });
    expect(response.machineConfig).toEqual({ cpuCount: 4 });
  });
});

describe('user conversion', () => {
  test('userRequestToRecord_defaultsToBuiltInUserType', () => {
    const record = userRequestToRecord(`${CLUSTER_NAME}/users/admin`, {});

    expect(record.name).toBe(`${CLUSTER_NAME}/users/admin`);
    expect(record.userType).toBe(UserType.ALLOYDB_BUILT_IN);
  });

  test('userRequestToRecord_retainsDatabaseRoles', () => {
    const record = userRequestToRecord(`${CLUSTER_NAME}/users/admin`, {
      databaseRoles: ['pg_read_all_data'],
      userType: 'ALLOYDB_IAM_USER',
    });

    expect(record.userType).toBe(UserType.ALLOYDB_IAM_USER);
    expect(userRecordToResponse(record).databaseRoles).toEqual(['pg_read_all_data']);
  });

  // `User.password` is input-only in the discovery document.
  test('userRecordToResponse_neverExposesThePassword', () => {
    const record = userRequestToRecord(`${CLUSTER_NAME}/users/admin`, { password: 'hunter2' });

    expect(JSON.stringify(record)).not.toContain('hunter2');
    expect(userRecordToResponse(record)).not.toHaveProperty('password');
  });
});

describe('table schemas', () => {
  test.each([
    [ALLOYDB_CLUSTERS_TABLE, clusterTableSchema],
    [ALLOYDB_INSTANCES_TABLE, instanceTableSchema],
    [ALLOYDB_USERS_TABLE, userTableSchema],
  ])('%s_isUniquelyIndexedOnNameAndKeepsTimestamps', (tableName, schema) => {
    expect(schema.name).toBe(tableName);
    expect(schema.timestamps).toBe(true);
    expect(schema.columns.find(column => column.name === 'name')?.unique).toBe(true);
    expect(schema.indexes?.some(index => index.columns.includes('name') && index.unique)).toBe(
      true
    );
  });

  test('clusterTableSchema_storesUnmodeledWritableFieldsInASpecColumn', () => {
    expect(schemaColumnType(clusterTableSchema, 'spec')).toBe('json');
    expect(schemaColumnType(clusterTableSchema, 'initialUserName')).toBe('string');
  });

  function schemaColumnType(
    schema: typeof clusterTableSchema,
    columnName: string
  ): string | undefined {
    return schema.columns.find(column => column.name === columnName)?.type;
  }
});

describe('protobuf enum normalization', () => {
  /**
   * google-gax's REST fallback serializes enums as numbers, so the official
   * client sends `instanceType: 1` where curl sends `"PRIMARY"`. Real GCP accepts
   * both, so the emulator must store the name either way — otherwise the client
   * reads its own number back instead of an enum name.
   */
  test.each([
    [1, 'PRIMARY'],
    [2, 'READ_POOL'],
    [3, 'SECONDARY'],
    [0, 'INSTANCE_TYPE_UNSPECIFIED'],
  ] as const)('normalizeEnum_resolvesInstanceTypeNumber_%i_to_%s', (wireNumber, expected) => {
    expect(normalizeEnum(wireNumber, INSTANCE_TYPE_ENUM)).toBe(expected);
  });

  test('normalizeEnum_leavesAnEnumNameUntouched', () => {
    expect(normalizeEnum('READ_POOL', INSTANCE_TYPE_ENUM)).toBe('READ_POOL');
  });

  // Query strings and some serializers deliver the number as text.
  test('normalizeEnum_resolvesANumericString', () => {
    expect(normalizeEnum('2', INSTANCE_TYPE_ENUM)).toBe('READ_POOL');
  });

  /**
   * Returned untouched rather than coerced, so the caller's validation can report
   * the value the client actually sent.
   */
  test('normalizeEnum_leavesAnUnrecognizedNumberUntouchedForValidationToReject', () => {
    expect(normalizeEnum(99, INSTANCE_TYPE_ENUM)).toBe(99);
  });

  // Written out rather than with test.each: an empty-array case is spread into
  // zero arguments, which Bun reads as a done-callback test and times out.
  test('normalizeEnum_leavesAValueThatIsNotAnEnumUntouched', () => {
    const objectValue = {};
    const arrayValue: unknown[] = [];

    expect(normalizeEnum(undefined, INSTANCE_TYPE_ENUM)).toBeUndefined();
    expect(normalizeEnum(null, INSTANCE_TYPE_ENUM)).toBeNull();
    expect(normalizeEnum(objectValue, INSTANCE_TYPE_ENUM)).toBe(objectValue);
    expect(normalizeEnum(arrayValue, INSTANCE_TYPE_ENUM)).toBe(arrayValue);
    expect(normalizeEnum('NOT_A_TYPE', INSTANCE_TYPE_ENUM)).toBe('NOT_A_TYPE');
  });

  test('normalizeEnum_resolvesUserTypeNumbers', () => {
    expect(normalizeEnum(1, USER_TYPE_ENUM)).toBe('ALLOYDB_BUILT_IN');
    expect(normalizeEnum(2, USER_TYPE_ENUM)).toBe('ALLOYDB_IAM_USER');
  });

  test('instanceRequestToRecord_storesTheEnumNameWhenGivenAWireNumber', () => {
    expect(instanceRequestToRecord(INSTANCE_NAME, { instanceType: 2 }).instanceType).toBe(
      InstanceType.READ_POOL
    );
  });

  test('userRequestToRecord_storesTheEnumNameWhenGivenAWireNumber', () => {
    expect(userRequestToRecord(`${CLUSTER_NAME}/users/admin`, { userType: 2 }).userType).toBe(
      UserType.ALLOYDB_IAM_USER
    );
  });

  test('clusterRecordToResponse_reportsDatabaseVersionByNameWhenGivenAWireNumber', () => {
    const record = clusterRequestToRecord(CLUSTER_NAME, {
      initialUser: { user: 'postgres' },
      databaseVersion: 4,
    });

    expect(clusterRecordToResponse(record).databaseVersion).toBe('POSTGRES_16');
  });

  test('instanceRecordToResponse_reportsNestedTopLevelEnumsByName', () => {
    const record = instanceRequestToRecord(INSTANCE_NAME, {
      availabilityType: 2,
      activationPolicy: 1,
    });

    const response = instanceRecordToResponse(record);

    expect(response.availabilityType).toBe('REGIONAL');
    expect(response.activationPolicy).toBe('ALWAYS');
  });

  /**
   * <b>LIMITATION:</b> enums inside sub-messages are round-tripped verbatim, so a
   * numeric one stays numeric. Pinned so the boundary is explicit rather than
   * discovered later.
   */
  test('instanceRecordToResponse_roundTripsAnEnumNestedInASubMessageVerbatim', () => {
    const record = instanceRequestToRecord(INSTANCE_NAME, {
      clientConnectionConfig: { sslConfig: { sslMode: 2 } },
    });

    expect(instanceRecordToResponse(record).clientConnectionConfig).toEqual({
      sslConfig: { sslMode: 2 },
    });
  });

  test('instanceRecordToResponse_reportsDataApiAccessByNameWhenGivenAWireNumber', () => {
    const record = instanceRequestToRecord(INSTANCE_NAME, { dataApiAccess: 2 });

    expect(instanceRecordToResponse(record).dataApiAccess).toBe('ENABLED');
  });

  test('clusterRecordToResponse_reportsMaintenanceVersionSelectionPolicyByNameWhenGivenAWireNumber', () => {
    const record = clusterRequestToRecord(CLUSTER_NAME, {
      initialUser: { user: 'postgres' },
      maintenanceVersionSelectionPolicy: 1,
    });

    expect(clusterRecordToResponse(record).maintenanceVersionSelectionPolicy).toBe(
      'MAINTENANCE_VERSION_SELECTION_POLICY_LATEST'
    );
  });
});
