/**
 * Business logic for Memorystore token auth users and auth tokens.
 *
 * <p>Reach for this to serve the token-auth control plane: CRUD over
 * {@link TokenAuthUserResponse} and {@link AuthTokenResponse} resources backed
 * by SQLite.
 *
 * <p><b>NOTE:</b> This is metadata only — token-auth is not currently enforced
 * on the data plane. Tokens minted by {@link TokenAuthService#addAuthToken} are
 * persisted but never wired into the spawned `valkey-server` (which runs with no
 * `requirepass`/ACL and `--protected-mode no`), and no proxy sits in front of
 * it. Creating a token therefore does not make the Valkey connection require
 * auth; the data plane stays unauthenticated. Real enforcement is deferred —
 * see ADR-007 "Known Limitations".
 */

import type { ResourceMutex } from '@/shared/utils/resource-mutex.ts';
import type { OperationsStore } from './operations.ts';
import type { TokenAuthRepository } from './token-auth-repository.ts';
import {
  AddAuthTokenRequestSchema,
  type AuthTokenResponse,
  authTokenRecordToResponse,
  buildAuthTokenName,
  buildInstanceName,
  extractResourceId,
  MemoryStoreError,
  type OperationResponse,
  parseAuthTokenName,
  parseTokenAuthUserName,
  type TokenAuthUserResponse,
  tokenAuthUserRecordToResponse,
} from './types.ts';

export interface ListTokenAuthUsersResponse {
  tokenAuthUsers: TokenAuthUserResponse[];
  nextPageToken?: string;
}

export interface ListAuthTokensResponse {
  authTokens: AuthTokenResponse[];
  nextPageToken?: string;
}

export class TokenAuthService {
  private repo: TokenAuthRepository;
  private operationsStore: OperationsStore;
  private instanceMutex: ResourceMutex;

  constructor(
    repo: TokenAuthRepository,
    operationsStore: OperationsStore,
    instanceMutex: ResourceMutex
  ) {
    this.repo = repo;
    this.operationsStore = operationsStore;
    this.instanceMutex = instanceMutex;
  }

  /**
   * Resource name of the instance a token user or auth token hangs off.
   *
   * <p>Token users and auth tokens live inside an instance whose deletion
   * purges them, so every mutation here serializes on the INSTANCE's name —
   * see {@link ResourceMutex}. Keying on the user's or the token's own name
   * would leave those mutations free to run inside an in-flight instance
   * delete, which is the whole thing the mutex exists to prevent.
   */
  private resolveInstanceLockKey(parsedName: {
    project: string;
    location: string;
    instance: string;
  }): string {
    return buildInstanceName(parsedName.project, parsedName.location, parsedName.instance);
  }

  async listTokenAuthUsers(
    instanceName: string,
    pageSize?: number,
    pageToken?: string
  ): Promise<ListTokenAuthUsersResponse> {
    const result = await this.repo.listTokenAuthUsers(instanceName, pageSize, pageToken);

    const response: ListTokenAuthUsersResponse = {
      tokenAuthUsers: result.tokenAuthUsers.map(tokenAuthUserRecordToResponse),
    };

    if (result.nextPageToken) response.nextPageToken = result.nextPageToken;

    return response;
  }

  async getTokenAuthUser(name: string): Promise<TokenAuthUserResponse> {
    const record = await this.getExistingTokenAuthUserOrThrow(name);

    return tokenAuthUserRecordToResponse(record);
  }

  /**
   * Delete a token auth user, honouring the documented `force` semantics.
   *
   * <p>Per the v1 discovery document: with `force` set, the user's auth
   * tokens are deleted too; without it the request only succeeds when the
   * user has none. Deleting the user while leaving its tokens behind would
   * leave a credential readable through `authTokens.get` under a parent that
   * no longer exists.
   */
  async deleteTokenAuthUser(
    name: string,
    force?: boolean,
    _requestId?: string
  ): Promise<OperationResponse> {
    return this.instanceMutex.runExclusively(
      this.resolveInstanceLockKey(parseTokenAuthUserName(name)),
      () => this.deleteTokenAuthUserExclusively(name, force)
    );
  }

  private async deleteTokenAuthUserExclusively(
    name: string,
    force?: boolean
  ): Promise<OperationResponse> {
    await this.getExistingTokenAuthUserOrThrow(name);

    const authTokenCount = await this.repo.countAuthTokensForUser(name);

    if (authTokenCount > 0 && !force) {
      throw new MemoryStoreError(
        'FAILED_PRECONDITION',
        `TokenAuthUser ${name} still has ${authTokenCount} auth token(s); retry with force=true to delete them alongside the user`,
        name
      );
    }

    await this.repo.deleteAuthTokensForUser(name);
    await this.repo.deleteTokenAuthUser(name);

    const { project, location } = parseTokenAuthUserName(name);

    return this.operationsStore.createOperation(project, location, name, 'delete', 'TokenAuthUser');
  }

  async addAuthToken(tokenAuthUserName: string, body: unknown): Promise<OperationResponse> {
    const parsed = AddAuthTokenRequestSchema.safeParse(body ?? {});

    if (!parsed.success) {
      throw new MemoryStoreError(
        'INVALID_ARGUMENT',
        `Invalid addAuthToken request: ${parsed.error.message}`
      );
    }

    // A malformed request is rejected above, before taking a turn in the queue.
    return this.instanceMutex.runExclusively(
      this.resolveInstanceLockKey(parseTokenAuthUserName(tokenAuthUserName)),
      () => this.addAuthTokenExclusively(tokenAuthUserName, parsed.data.authToken.name)
    );
  }

  private async addAuthTokenExclusively(
    tokenAuthUserName: string,
    authTokenId: string
  ): Promise<OperationResponse> {
    await this.getExistingTokenAuthUserOrThrow(tokenAuthUserName);

    const { project, location, instance, tokenAuthUser } =
      parseTokenAuthUserName(tokenAuthUserName);
    const authTokenName = buildAuthTokenName(
      project,
      location,
      instance,
      tokenAuthUser,
      extractResourceId(authTokenId)
    );

    const existing = await this.repo.getAuthTokenByName(authTokenName);

    if (existing) {
      throw new MemoryStoreError(
        'ALREADY_EXISTS',
        `AuthToken ${authTokenName} already exists`,
        authTokenName,
        'AuthToken'
      );
    }

    const created = await this.repo.createAuthToken({
      name: authTokenName,
      tokenAuthUser: tokenAuthUserName,
      token: crypto.randomUUID(),
      state: 'ACTIVE',
    });

    // The token itself is server-generated, so it reaches the caller only via
    // this operation's response — `authTokens.get` is the only other way to it.
    return this.operationsStore.createOperation(
      project,
      location,
      authTokenName,
      'addAuthToken',
      'AuthToken',
      authTokenRecordToResponse(created) as unknown as Record<string, unknown>
    );
  }

  async listAuthTokens(
    tokenAuthUserName: string,
    pageSize?: number,
    pageToken?: string
  ): Promise<ListAuthTokensResponse> {
    const result = await this.repo.listAuthTokens(tokenAuthUserName, pageSize, pageToken);

    const response: ListAuthTokensResponse = {
      authTokens: result.authTokens.map(authTokenRecordToResponse),
    };

    if (result.nextPageToken) response.nextPageToken = result.nextPageToken;

    return response;
  }

  async getAuthToken(name: string): Promise<AuthTokenResponse> {
    const record = await this.repo.getAuthTokenByName(name);

    if (!record) {
      throw new MemoryStoreError('NOT_FOUND', `AuthToken ${name} not found`, name);
    }

    return authTokenRecordToResponse(record);
  }

  async deleteAuthToken(name: string): Promise<OperationResponse> {
    const parsedName = parseAuthTokenName(name);

    return this.instanceMutex.runExclusively(this.resolveInstanceLockKey(parsedName), () =>
      this.deleteAuthTokenExclusively(name, parsedName)
    );
  }

  private async deleteAuthTokenExclusively(
    name: string,
    parsedName: { project: string; location: string }
  ): Promise<OperationResponse> {
    const existing = await this.repo.getAuthTokenByName(name);

    if (!existing) {
      throw new MemoryStoreError('NOT_FOUND', `AuthToken ${name} not found`, name);
    }

    await this.repo.deleteAuthToken(name);

    return this.operationsStore.createOperation(
      parsedName.project,
      parsedName.location,
      name,
      'delete',
      'AuthToken'
    );
  }

  private async getExistingTokenAuthUserOrThrow(name: string) {
    const record = await this.repo.getTokenAuthUserByName(name);

    if (!record) {
      throw new MemoryStoreError('NOT_FOUND', `TokenAuthUser ${name} not found`, name);
    }

    return record;
  }
}
