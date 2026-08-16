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

import type { OperationsStore } from './operations.ts';
import type { TokenAuthRepository } from './token-auth-repository.ts';
import {
  AddAuthTokenRequestSchema,
  type AuthTokenResponse,
  authTokenRecordToResponse,
  buildAuthTokenName,
  extractResourceId,
  MemoryStoreError,
  type OperationResponse,
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

  constructor(repo: TokenAuthRepository, operationsStore: OperationsStore) {
    this.repo = repo;
    this.operationsStore = operationsStore;
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

    await this.getExistingTokenAuthUserOrThrow(tokenAuthUserName);

    const { project, location, instance, tokenAuthUser } =
      parseTokenAuthUserName(tokenAuthUserName);
    const authTokenName = buildAuthTokenName(
      project,
      location,
      instance,
      tokenAuthUser,
      extractResourceId(parsed.data.authToken.name)
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

    await this.repo.createAuthToken({
      name: authTokenName,
      tokenAuthUser: tokenAuthUserName,
      token: crypto.randomUUID(),
      state: 'ACTIVE',
    });

    return this.operationsStore.createOperation(
      project,
      location,
      authTokenName,
      'addAuthToken',
      'AuthToken'
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
    const existing = await this.repo.getAuthTokenByName(name);

    if (!existing) {
      throw new MemoryStoreError('NOT_FOUND', `AuthToken ${name} not found`, name);
    }

    await this.repo.deleteAuthToken(name);

    const { project, location } = parseTokenAuthUserName(existing.tokenAuthUser);

    return this.operationsStore.createOperation(project, location, name, 'delete', 'AuthToken');
  }

  private async getExistingTokenAuthUserOrThrow(name: string) {
    const record = await this.repo.getTokenAuthUserByName(name);

    if (!record) {
      throw new MemoryStoreError('NOT_FOUND', `TokenAuthUser ${name} not found`, name);
    }

    return record;
  }
}
