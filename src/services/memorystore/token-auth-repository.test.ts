/**
 * Unit tests for TokenAuthRepository
 */

import { beforeEach, describe, expect, test } from 'bun:test';
import { StorageManager } from '@/core/storage/manager.ts';
import { TokenAuthRepository } from './token-auth-repository.ts';
import type { AuthTokenRecord, TokenAuthUserRecord } from './types.ts';

function tokenAuthUserData(
  overrides: Partial<Omit<TokenAuthUserRecord, 'id' | 'createdAt' | 'updatedAt'>> = {}
): Omit<TokenAuthUserRecord, 'id' | 'createdAt' | 'updatedAt'> {
  return {
    name: 'projects/p/locations/us-central1/instances/i/tokenAuthUsers/u',
    instance: 'projects/p/locations/us-central1/instances/i',
    state: 'ACTIVE',
    ...overrides,
  };
}

function authTokenData(
  overrides: Partial<Omit<AuthTokenRecord, 'id' | 'createdAt' | 'updatedAt'>> = {}
): Omit<AuthTokenRecord, 'id' | 'createdAt' | 'updatedAt'> {
  return {
    name: 'projects/p/locations/us-central1/instances/i/tokenAuthUsers/u/authTokens/t',
    tokenAuthUser: 'projects/p/locations/us-central1/instances/i/tokenAuthUsers/u',
    token: 'super-secret-token',
    state: 'ACTIVE',
    ...overrides,
  };
}

describe('TokenAuthRepository', () => {
  let storage: StorageManager;
  let repo: TokenAuthRepository;

  beforeEach(async () => {
    storage = new StorageManager();
    await storage.initialize({ type: 'memory' });
    repo = new TokenAuthRepository(storage);
    await repo.initialize();
  });

  describe('token auth users', () => {
    test('createTokenAuthUser_persistsRecord_andRoundTripsIt', async () => {
      await repo.createTokenAuthUser(tokenAuthUserData());

      const persisted = await repo.getTokenAuthUserByName(
        'projects/p/locations/us-central1/instances/i/tokenAuthUsers/u'
      );

      expect(persisted).not.toBeNull();
      expect(persisted?.instance).toBe('projects/p/locations/us-central1/instances/i');
    });

    test('createTokenAuthUser_givenDuplicateName_rejectsAndLeavesTheOriginalRowIntact', async () => {
      await repo.createTokenAuthUser(tokenAuthUserData({ state: 'ACTIVE' }));

      const promise = repo.createTokenAuthUser(tokenAuthUserData({ state: 'CREATING' }));

      await expect(promise).rejects.toThrow(/name|unique|exists/i);

      const page = await repo.listTokenAuthUsers('projects/p/locations/us-central1/instances/i');

      expect(page.tokenAuthUsers).toHaveLength(1);
      expect(page.tokenAuthUsers[0]?.state).toBe('ACTIVE');
    });

    test('listTokenAuthUsers_scopesToTheInstance_andDoesNotLeakOtherInstances', async () => {
      await repo.createTokenAuthUser(tokenAuthUserData());
      await repo.createTokenAuthUser(
        tokenAuthUserData({
          name: 'projects/p/locations/us-central1/instances/other/tokenAuthUsers/u',
          instance: 'projects/p/locations/us-central1/instances/other',
        })
      );

      const result = await repo.listTokenAuthUsers('projects/p/locations/us-central1/instances/i');

      expect(result.tokenAuthUsers).toHaveLength(1);
      expect(result.tokenAuthUsers[0]?.instance).toBe(
        'projects/p/locations/us-central1/instances/i'
      );
    });

    test('listTokenAuthUsers_paginatesWithStringifiedOffsetTokens', async () => {
      await repo.createTokenAuthUser(
        tokenAuthUserData({
          name: 'projects/p/locations/us-central1/instances/i/tokenAuthUsers/a',
        })
      );
      await repo.createTokenAuthUser(
        tokenAuthUserData({
          name: 'projects/p/locations/us-central1/instances/i/tokenAuthUsers/b',
        })
      );

      const page1 = await repo.listTokenAuthUsers(
        'projects/p/locations/us-central1/instances/i',
        1
      );

      expect(page1.tokenAuthUsers).toHaveLength(1);
      expect(page1.nextPageToken).toBe('1');

      const page2 = await repo.listTokenAuthUsers(
        'projects/p/locations/us-central1/instances/i',
        1,
        page1.nextPageToken
      );

      expect(page2.tokenAuthUsers).toHaveLength(1);
      expect(page2.tokenAuthUsers[0]?.name).not.toBe(page1.tokenAuthUsers[0]?.name);
    });

    test('deleteTokenAuthUser_removesTheUser_andReturnsTrue', async () => {
      await repo.createTokenAuthUser(tokenAuthUserData());

      const deleted = await repo.deleteTokenAuthUser(
        'projects/p/locations/us-central1/instances/i/tokenAuthUsers/u'
      );

      expect(deleted).toBe(true);

      const found = await repo.getTokenAuthUserByName(
        'projects/p/locations/us-central1/instances/i/tokenAuthUsers/u'
      );

      expect(found).toBeNull();
    });

    test('deleteTokenAuthUser_givenMissingUser_returnsFalse', async () => {
      const deleted = await repo.deleteTokenAuthUser(
        'projects/p/locations/us-central1/instances/i/tokenAuthUsers/missing'
      );

      expect(deleted).toBe(false);
    });
  });

  describe('auth tokens', () => {
    beforeEach(async () => {
      await repo.createTokenAuthUser(tokenAuthUserData());
    });

    test('createAuthToken_persistsRecord_andRoundTripsIt', async () => {
      await repo.createAuthToken(authTokenData());

      const persisted = await repo.getAuthTokenByName(
        'projects/p/locations/us-central1/instances/i/tokenAuthUsers/u/authTokens/t'
      );

      expect(persisted).not.toBeNull();
      expect(persisted?.token).toBe('super-secret-token');
    });

    test('createAuthToken_givenDuplicateName_rejectsAndLeavesTheOriginalRowIntact', async () => {
      await repo.createAuthToken(authTokenData());

      const promise = repo.createAuthToken(authTokenData({ token: 'a-second-secret' }));

      await expect(promise).rejects.toThrow(/name|unique|exists/i);

      const page = await repo.listAuthTokens(
        'projects/p/locations/us-central1/instances/i/tokenAuthUsers/u'
      );

      expect(page.authTokens).toHaveLength(1);
      expect(page.authTokens[0]?.token).toBe('super-secret-token');
    });

    test('listAuthTokens_scopesToTheTokenAuthUser_andDoesNotLeakOtherUsers', async () => {
      await repo.createTokenAuthUser(
        tokenAuthUserData({
          name: 'projects/p/locations/us-central1/instances/i/tokenAuthUsers/other',
        })
      );
      await repo.createAuthToken(authTokenData());
      await repo.createAuthToken(
        authTokenData({
          name: 'projects/p/locations/us-central1/instances/i/tokenAuthUsers/other/authTokens/t',
          tokenAuthUser: 'projects/p/locations/us-central1/instances/i/tokenAuthUsers/other',
        })
      );

      const result = await repo.listAuthTokens(
        'projects/p/locations/us-central1/instances/i/tokenAuthUsers/u'
      );

      expect(result.authTokens).toHaveLength(1);
      expect(result.authTokens[0]?.tokenAuthUser).toBe(
        'projects/p/locations/us-central1/instances/i/tokenAuthUsers/u'
      );
    });

    test('listAuthTokens_paginatesWithStringifiedOffsetTokens', async () => {
      await repo.createAuthToken(
        authTokenData({
          name: 'projects/p/locations/us-central1/instances/i/tokenAuthUsers/u/authTokens/a',
        })
      );
      await repo.createAuthToken(
        authTokenData({
          name: 'projects/p/locations/us-central1/instances/i/tokenAuthUsers/u/authTokens/b',
        })
      );

      const page1 = await repo.listAuthTokens(
        'projects/p/locations/us-central1/instances/i/tokenAuthUsers/u',
        1
      );

      expect(page1.authTokens).toHaveLength(1);
      expect(page1.nextPageToken).toBe('1');

      const page2 = await repo.listAuthTokens(
        'projects/p/locations/us-central1/instances/i/tokenAuthUsers/u',
        1,
        page1.nextPageToken
      );

      expect(page2.authTokens).toHaveLength(1);
      expect(page2.authTokens[0]?.name).not.toBe(page1.authTokens[0]?.name);
    });

    test('deleteAuthToken_removesTheToken_andReturnsTrue', async () => {
      await repo.createAuthToken(authTokenData());

      const deleted = await repo.deleteAuthToken(
        'projects/p/locations/us-central1/instances/i/tokenAuthUsers/u/authTokens/t'
      );

      expect(deleted).toBe(true);

      const found = await repo.getAuthTokenByName(
        'projects/p/locations/us-central1/instances/i/tokenAuthUsers/u/authTokens/t'
      );

      expect(found).toBeNull();
    });

    test('deleteAuthToken_givenMissingToken_returnsFalse', async () => {
      const deleted = await repo.deleteAuthToken(
        'projects/p/locations/us-central1/instances/i/tokenAuthUsers/u/authTokens/missing'
      );

      expect(deleted).toBe(false);
    });
  });
});
