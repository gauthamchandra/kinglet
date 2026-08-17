/**
 * Unit tests for TokenAuthService
 */

import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { OperationsStore } from './operations.ts';
import { ResourceMutex } from './resource-mutex.ts';
import type { TokenAuthRepository } from './token-auth-repository.ts';
import { TokenAuthService } from './token-auth-service.ts';
import { MemoryStoreError } from './types.ts';

function makeTokenAuthUserRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: 'row-1',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    name: 'projects/p/locations/us-central1/instances/i/tokenAuthUsers/u',
    instance: 'projects/p/locations/us-central1/instances/i',
    state: 'ACTIVE',
    ...overrides,
  };
}

function makeAuthTokenRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: 'row-1',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    name: 'projects/p/locations/us-central1/instances/i/tokenAuthUsers/u/authTokens/t',
    tokenAuthUser: 'projects/p/locations/us-central1/instances/i/tokenAuthUsers/u',
    token: 'super-secret-token',
    state: 'ACTIVE',
    ...overrides,
  };
}

describe('TokenAuthService', () => {
  let repo: TokenAuthRepository;
  let operationsStore: OperationsStore;
  let instanceMutex: ResourceMutex;
  let service: TokenAuthService;

  beforeEach(() => {
    repo = {
      getTokenAuthUserByName: mock(() => Promise.resolve(null)),
      listTokenAuthUsers: mock(() =>
        Promise.resolve({ tokenAuthUsers: [makeTokenAuthUserRecord()], nextPageToken: '1' })
      ),
      deleteTokenAuthUser: mock(() => Promise.resolve(true)),
      countAuthTokensForUser: mock(() => Promise.resolve(0)),
      deleteAuthTokensForUser: mock(() => Promise.resolve(0)),
      deleteTokenAuthUsersForInstance: mock(() => Promise.resolve([])),
      createAuthToken: mock((data: Record<string, unknown>) =>
        Promise.resolve(makeAuthTokenRecord(data))
      ),
      getAuthTokenByName: mock(() => Promise.resolve(null)),
      listAuthTokens: mock(() =>
        Promise.resolve({ authTokens: [makeAuthTokenRecord()], nextPageToken: '1' })
      ),
      deleteAuthToken: mock(() => Promise.resolve(true)),
    } as unknown as TokenAuthRepository;

    operationsStore = {
      createOperation: mock(
        (
          _p: string,
          _l: string,
          target: string,
          verb: string,
          _resourceType: string,
          response?: Record<string, unknown>
        ) =>
          Promise.resolve({
            name: 'projects/p/locations/us-central1/operations/op-1',
            metadata: {
              '@type': 'type.googleapis.com/google.cloud.memorystore.v1.OperationMetadata',
              createTime: '2026-01-01T00:00:00.000Z',
              endTime: '2026-01-01T00:00:00.000Z',
              target,
              verb,
              apiVersion: 'v1',
            },
            done: true,
            ...(response ? { response } : {}),
          })
      ),
    } as unknown as OperationsStore;

    instanceMutex = new ResourceMutex();
    service = new TokenAuthService(repo, operationsStore, instanceMutex);
  });

  test('listTokenAuthUsers_mapsRecordsToTheTokenAuthUsersEnvelopeKey', async () => {
    const result = await service.listTokenAuthUsers(
      'projects/p/locations/us-central1/instances/i',
      10,
      '0'
    );

    expect(repo.listTokenAuthUsers).toHaveBeenCalledWith(
      'projects/p/locations/us-central1/instances/i',
      10,
      '0'
    );
    expect(result.tokenAuthUsers[0]?.name).toBe(
      'projects/p/locations/us-central1/instances/i/tokenAuthUsers/u'
    );
    expect(result.nextPageToken).toBe('1');
  });

  test('getTokenAuthUser_givenExistingUser_returnsTokenAuthUserResponse', async () => {
    (repo.getTokenAuthUserByName as ReturnType<typeof mock>).mockImplementation(() =>
      Promise.resolve(makeTokenAuthUserRecord())
    );

    const result = await service.getTokenAuthUser(
      'projects/p/locations/us-central1/instances/i/tokenAuthUsers/u'
    );

    expect(result.name).toBe('projects/p/locations/us-central1/instances/i/tokenAuthUsers/u');
  });

  test('getTokenAuthUser_givenMissingUser_throwsNotFound', async () => {
    const promise = service.getTokenAuthUser(
      'projects/p/locations/us-central1/instances/i/tokenAuthUsers/missing'
    );

    await expect(promise).rejects.toBeInstanceOf(MemoryStoreError);
    await expect(promise).rejects.toHaveProperty('code', 'NOT_FOUND');
  });

  /**
   * The document makes `force` the difference between refusing and cascading.
   * Deleting the user while leaving its tokens behind left a credential
   * readable through authTokens.get under a parent that no longer existed.
   */
  test('deleteTokenAuthUser_givenRemainingAuthTokensAndNoForce_throwsFailedPreconditionWithoutDeleting', async () => {
    (repo.getTokenAuthUserByName as ReturnType<typeof mock>).mockImplementation(() =>
      Promise.resolve(makeTokenAuthUserRecord())
    );
    (repo.countAuthTokensForUser as ReturnType<typeof mock>).mockImplementation(() =>
      Promise.resolve(2)
    );

    const promise = service.deleteTokenAuthUser(
      'projects/p/locations/us-central1/instances/i/tokenAuthUsers/u'
    );

    await expect(promise).rejects.toBeInstanceOf(MemoryStoreError);
    await expect(promise).rejects.toHaveProperty('code', 'FAILED_PRECONDITION');
    expect(repo.deleteTokenAuthUser).not.toHaveBeenCalled();
    expect(repo.deleteAuthTokensForUser).not.toHaveBeenCalled();
  });

  test('deleteTokenAuthUser_givenRemainingAuthTokensAndForce_cascadesToTheAuthTokens', async () => {
    (repo.getTokenAuthUserByName as ReturnType<typeof mock>).mockImplementation(() =>
      Promise.resolve(makeTokenAuthUserRecord())
    );
    (repo.countAuthTokensForUser as ReturnType<typeof mock>).mockImplementation(() =>
      Promise.resolve(2)
    );

    const name = 'projects/p/locations/us-central1/instances/i/tokenAuthUsers/u';
    const op = await service.deleteTokenAuthUser(name, true);

    expect(repo.deleteAuthTokensForUser).toHaveBeenCalledWith(name);
    expect(repo.deleteTokenAuthUser).toHaveBeenCalledWith(name);
    expect(op.done).toBe(true);
  });

  test('deleteTokenAuthUser_givenExistingUser_removesItAndReturnsADoneOperation', async () => {
    (repo.getTokenAuthUserByName as ReturnType<typeof mock>).mockImplementation(() =>
      Promise.resolve(makeTokenAuthUserRecord())
    );

    const op = await service.deleteTokenAuthUser(
      'projects/p/locations/us-central1/instances/i/tokenAuthUsers/u',
      true
    );

    expect(repo.deleteTokenAuthUser).toHaveBeenCalledWith(
      'projects/p/locations/us-central1/instances/i/tokenAuthUsers/u'
    );
    expect(op.done).toBe(true);
    expect(op.metadata.verb).toBe('delete');
  });

  test('deleteTokenAuthUser_givenMissingUser_throwsNotFound', async () => {
    const promise = service.deleteTokenAuthUser(
      'projects/p/locations/us-central1/instances/i/tokenAuthUsers/missing'
    );

    await expect(promise).rejects.toHaveProperty('code', 'NOT_FOUND');
  });

  test('addAuthToken_persistsTheFullyQualifiedAuthTokenUnderTheTokenAuthUser_andReturnsADoneOperation', async () => {
    (repo.getTokenAuthUserByName as ReturnType<typeof mock>).mockImplementation(() =>
      Promise.resolve(makeTokenAuthUserRecord())
    );

    const op = await service.addAuthToken(
      'projects/p/locations/us-central1/instances/i/tokenAuthUsers/u',
      { authToken: { name: 't' } }
    );

    const createAuthTokenSpy = repo.createAuthToken as ReturnType<typeof mock>;
    const persisted = createAuthTokenSpy.mock.calls[0]?.[0] as Record<string, unknown>;

    expect(persisted.name).toBe(
      'projects/p/locations/us-central1/instances/i/tokenAuthUsers/u/authTokens/t'
    );
    expect(persisted.tokenAuthUser).toBe(
      'projects/p/locations/us-central1/instances/i/tokenAuthUsers/u'
    );
    expect(op.done).toBe(true);
    expect(op.metadata.verb).toBe('addAuthToken');
  });

  test('addAuthToken_returnsTheMintedTokenOnTheOperationResponse', async () => {
    (repo.getTokenAuthUserByName as ReturnType<typeof mock>).mockImplementation(() =>
      Promise.resolve(makeTokenAuthUserRecord())
    );

    const op = await service.addAuthToken(
      'projects/p/locations/us-central1/instances/i/tokenAuthUsers/u',
      { authToken: { name: 't' } }
    );

    const createAuthTokenSpy = repo.createAuthToken as ReturnType<typeof mock>;
    const persisted = createAuthTokenSpy.mock.calls[0]?.[0] as Record<string, unknown>;

    // The token is server-generated, so an operation with no response leaves the
    // create path unable to hand back the one thing the caller asked for.
    expect(op.response?.name).toBe(
      'projects/p/locations/us-central1/instances/i/tokenAuthUsers/u/authTokens/t'
    );
    expect(op.response?.token).toBe(persisted.token);
  });

  test('addAuthToken_whileTheInstancesLifecycleLockIsHeld_waitsInsteadOfWritingUnderneathIt', async () => {
    (repo.getTokenAuthUserByName as ReturnType<typeof mock>).mockImplementation(() =>
      Promise.resolve(makeTokenAuthUserRecord())
    );

    let releaseInstanceWork = () => {};
    const instanceWorkReleased = new Promise<void>(resolve => {
      releaseInstanceWork = resolve;
    });

    // Stands in for an in-flight deleteInstance: it holds the INSTANCE's key in
    // the shared mutex while purging the instance's token users and their
    // tokens. A token written during that window survives as an orphan and
    // becomes readable again once the same instance and user names are
    // recreated.
    const instanceWork = instanceMutex.runExclusively(
      'projects/p/locations/us-central1/instances/i',
      () => instanceWorkReleased
    );

    const addToken = service.addAuthToken(
      'projects/p/locations/us-central1/instances/i/tokenAuthUsers/u',
      { authToken: { name: 't' } }
    );

    await Bun.sleep(5);

    expect(repo.createAuthToken).not.toHaveBeenCalled();

    releaseInstanceWork();
    await instanceWork;
    await addToken;

    expect(repo.createAuthToken).toHaveBeenCalled();
  });

  test('deleteTokenAuthUser_whileTheInstancesLifecycleLockIsHeld_waitsInsteadOfDeletingUnderneathIt', async () => {
    (repo.getTokenAuthUserByName as ReturnType<typeof mock>).mockImplementation(() =>
      Promise.resolve(makeTokenAuthUserRecord())
    );

    let releaseInstanceWork = () => {};
    const instanceWorkReleased = new Promise<void>(resolve => {
      releaseInstanceWork = resolve;
    });

    const instanceWork = instanceMutex.runExclusively(
      'projects/p/locations/us-central1/instances/i',
      () => instanceWorkReleased
    );

    const remove = service.deleteTokenAuthUser(
      'projects/p/locations/us-central1/instances/i/tokenAuthUsers/u'
    );

    await Bun.sleep(5);

    // Removing a user mid-instance-mutation races the same way round: an
    // addAuthToken already past its parent-user check would leave its token
    // behind with no user to hang off.
    expect(repo.deleteTokenAuthUser).not.toHaveBeenCalled();

    releaseInstanceWork();
    await instanceWork;
    await remove;

    expect(repo.deleteTokenAuthUser).toHaveBeenCalled();
  });

  test('deleteAuthToken_whileTheInstancesLifecycleLockIsHeld_waitsInsteadOfDeletingUnderneathIt', async () => {
    (repo.getAuthTokenByName as ReturnType<typeof mock>).mockImplementation(() =>
      Promise.resolve(makeAuthTokenRecord())
    );

    let releaseInstanceWork = () => {};
    const instanceWorkReleased = new Promise<void>(resolve => {
      releaseInstanceWork = resolve;
    });

    const instanceWork = instanceMutex.runExclusively(
      'projects/p/locations/us-central1/instances/i',
      () => instanceWorkReleased
    );

    const remove = service.deleteAuthToken(
      'projects/p/locations/us-central1/instances/i/tokenAuthUsers/u/authTokens/t'
    );

    await Bun.sleep(5);

    // Every mutation of an instance's subtree holds the instance's key, with no
    // "deletes converge anyway" exception — an invariant with a hole in it is
    // one every future reader has to re-derive.
    expect(repo.deleteAuthToken).not.toHaveBeenCalled();

    releaseInstanceWork();
    await instanceWork;
    await remove;

    expect(repo.deleteAuthToken).toHaveBeenCalled();
  });

  test('addAuthToken_givenMissingTokenAuthUser_throwsNotFound', async () => {
    const promise = service.addAuthToken(
      'projects/p/locations/us-central1/instances/i/tokenAuthUsers/missing',
      { authToken: { name: 't' } }
    );

    await expect(promise).rejects.toHaveProperty('code', 'NOT_FOUND');
  });

  test('addAuthToken_givenAnEmptyBody_rejectsWithInvalidArgumentInsteadOfALeakedTypeError', async () => {
    const promise = service.addAuthToken(
      'projects/p/locations/us-central1/instances/i/tokenAuthUsers/u',
      {}
    );

    await expect(promise).rejects.toBeInstanceOf(MemoryStoreError);
    await expect(promise).rejects.toHaveProperty('code', 'INVALID_ARGUMENT');
    expect(repo.createAuthToken).not.toHaveBeenCalled();
  });

  test('addAuthToken_givenAnEmptyAuthTokenObject_rejectsInsteadOfPersistingAResourceNamedUndefined', async () => {
    (repo.getTokenAuthUserByName as ReturnType<typeof mock>).mockImplementation(() =>
      Promise.resolve(makeTokenAuthUserRecord())
    );

    const promise = service.addAuthToken(
      'projects/p/locations/us-central1/instances/i/tokenAuthUsers/u',
      { authToken: {} }
    );

    await expect(promise).rejects.toHaveProperty('code', 'INVALID_ARGUMENT');
    expect(repo.createAuthToken).not.toHaveBeenCalled();
  });

  test('addAuthToken_givenAnAuthTokenThatAlreadyExists_throwsAlreadyExistsInsteadOfPersistingADuplicate', async () => {
    (repo.getTokenAuthUserByName as ReturnType<typeof mock>).mockImplementation(() =>
      Promise.resolve(makeTokenAuthUserRecord())
    );
    (repo.getAuthTokenByName as ReturnType<typeof mock>).mockImplementation(() =>
      Promise.resolve(makeAuthTokenRecord())
    );

    const promise = service.addAuthToken(
      'projects/p/locations/us-central1/instances/i/tokenAuthUsers/u',
      { authToken: { name: 't' } }
    );

    await expect(promise).rejects.toBeInstanceOf(MemoryStoreError);
    await expect(promise).rejects.toHaveProperty('code', 'ALREADY_EXISTS');
    // Without this, the 409 body would report the route's resource
    // ("TokenAuthUser") rather than the AuthToken that actually conflicted.
    await expect(promise).rejects.toHaveProperty('resourceType', 'AuthToken');
    expect(repo.createAuthToken).not.toHaveBeenCalled();
  });

  test('listAuthTokens_mapsRecordsToTheAuthTokensEnvelopeKey', async () => {
    const result = await service.listAuthTokens(
      'projects/p/locations/us-central1/instances/i/tokenAuthUsers/u',
      10,
      '0'
    );

    expect(repo.listAuthTokens).toHaveBeenCalledWith(
      'projects/p/locations/us-central1/instances/i/tokenAuthUsers/u',
      10,
      '0'
    );
    expect(result.authTokens[0]?.name).toBe(
      'projects/p/locations/us-central1/instances/i/tokenAuthUsers/u/authTokens/t'
    );
    expect(result.nextPageToken).toBe('1');
  });

  test('getAuthToken_givenExistingToken_returnsAuthTokenResponse', async () => {
    (repo.getAuthTokenByName as ReturnType<typeof mock>).mockImplementation(() =>
      Promise.resolve(makeAuthTokenRecord())
    );

    const result = await service.getAuthToken(
      'projects/p/locations/us-central1/instances/i/tokenAuthUsers/u/authTokens/t'
    );

    expect(result.name).toBe(
      'projects/p/locations/us-central1/instances/i/tokenAuthUsers/u/authTokens/t'
    );
  });

  test('getAuthToken_givenMissingToken_throwsNotFound', async () => {
    const promise = service.getAuthToken(
      'projects/p/locations/us-central1/instances/i/tokenAuthUsers/u/authTokens/missing'
    );

    await expect(promise).rejects.toHaveProperty('code', 'NOT_FOUND');
  });

  test('deleteAuthToken_givenExistingToken_removesItAndReturnsADoneOperation', async () => {
    (repo.getAuthTokenByName as ReturnType<typeof mock>).mockImplementation(() =>
      Promise.resolve(makeAuthTokenRecord())
    );

    const op = await service.deleteAuthToken(
      'projects/p/locations/us-central1/instances/i/tokenAuthUsers/u/authTokens/t'
    );

    expect(repo.deleteAuthToken).toHaveBeenCalledWith(
      'projects/p/locations/us-central1/instances/i/tokenAuthUsers/u/authTokens/t'
    );
    expect(op.done).toBe(true);
    expect(op.metadata.verb).toBe('delete');
  });

  test('deleteAuthToken_givenMissingToken_throwsNotFound', async () => {
    const promise = service.deleteAuthToken(
      'projects/p/locations/us-central1/instances/i/tokenAuthUsers/u/authTokens/missing'
    );

    await expect(promise).rejects.toHaveProperty('code', 'NOT_FOUND');
  });
});
