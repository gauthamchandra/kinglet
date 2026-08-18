import { beforeEach, describe, expect, test } from 'bun:test';
import { constants, createPublicKey, verify as cryptoVerify, publicEncrypt } from 'node:crypto';
import type {
  RouteContext,
  RouteDefinition,
  RouteRequest,
  RouteResponse,
} from '@/core/gateway/request-router.ts';
import { StorageManager } from '@/core/storage/manager.ts';
import { crc32cString } from '@/shared/utils/crc32c.ts';
import { Logger } from '@/shared/utils/logger.ts';
import { CloudKmsService } from './index.ts';

const PROJECT = 'p';
const LOCATION = 'us-central1';
const b64 = (s: string): string => Buffer.from(s).toString('base64');
const fromB64 = (s: string): string => Buffer.from(s, 'base64').toString('utf-8');

let routes: RouteDefinition[];

beforeEach(async () => {
  const storage = new StorageManager();
  await storage.initialize({ type: 'memory' });

  const service = new CloudKmsService(storage, new Logger('test', 'error'));
  await service.initialize();

  routes = service.getRoutes();
});

interface CallOpts {
  params?: Record<string, string>;
  query?: Record<string, string>;
  body?: unknown;
}

async function call(id: string, opts: CallOpts = {}): Promise<RouteResponse> {
  const route = routes.find(r => r.id === id);

  if (!route) {
    throw new Error(`No route with id ${id}`);
  }

  const req = {
    method: route.method,
    path: '',
    query: opts.query ?? {},
    headers: {},
    params: opts.params ?? {},
    body: opts.body,
    originalRequest: new Request('http://localhost'),
  } as unknown as RouteRequest;

  const ctx = {
    routeId: route.id,
    startTime: 0,
    metadata: {},
    logger: new Logger('test', 'error'),
  } as unknown as RouteContext;

  return route.handler(req, ctx);
}

const ringParams = { project: PROJECT, location: LOCATION, keyRing: 'r' };
const keyParams = { ...ringParams, cryptoKey: 'k' };

async function setupEncryptKey(): Promise<void> {
  await call('kms.keyRings.create', {
    params: { project: PROJECT, location: LOCATION },
    query: { keyRingId: 'r' },
  });
  await call('kms.cryptoKeys.create', {
    params: ringParams,
    query: { cryptoKeyId: 'k' },
    body: { purpose: 'ENCRYPT_DECRYPT' },
  });
}

describe('route registration', () => {
  test('encrypt is a key-level POST custom verb', () => {
    const route = routes.find(r => r.id === 'kms.cryptoKeys.encrypt');

    expect(route?.method).toBe('POST');
    expect(route?.path.endsWith('/cryptoKeys/:cryptoKey:encrypt')).toBe(true);
  });

  test('asymmetricSign is a version-level custom verb', () => {
    const route = routes.find(r => r.id === 'kms.cryptoKeyVersions.asymmetricSign');

    expect(route?.path.endsWith('/cryptoKeyVersions/:version:asymmetricSign')).toBe(true);
  });

  test('generateRandomBytes is location-level', () => {
    const route = routes.find(r => r.id === 'kms.locations.generateRandomBytes');

    expect(route?.path.endsWith('/locations/:location:generateRandomBytes')).toBe(true);
  });

  test('leaves the shared v1 locations paths to the service-neutral handler', () => {
    const paths = routes.map(r => r.path);

    expect(paths).not.toContain('/v1/projects/:project/locations');
    expect(paths).not.toContain('/v1/projects/:project/locations/:location');
  });
});

describe('key ring + key creation', () => {
  test('creates a key ring and returns 200 with the resource name', async () => {
    const res = await call('kms.keyRings.create', {
      params: { project: PROJECT, location: LOCATION },
      query: { keyRingId: 'r' },
    });

    expect(res.status).toBe(200);
    expect((res.body as { name: string }).name).toBe(
      `projects/${PROJECT}/locations/${LOCATION}/keyRings/r`
    );
  });

  test('missing key ring yields 404 on crypto key creation', async () => {
    const res = await call('kms.cryptoKeys.create', {
      params: ringParams,
      query: { cryptoKeyId: 'k' },
      body: { purpose: 'ENCRYPT_DECRYPT' },
    });

    expect(res.status).toBe(404);
  });
});

describe('encrypt / decrypt over the wire', () => {
  beforeEach(setupEncryptKey);

  test('round-trips base64 plaintext and returns a decimal crc32c', async () => {
    const enc = await call('kms.cryptoKeys.encrypt', {
      params: keyParams,
      body: { plaintext: b64('wire secret') },
    });

    expect(enc.status).toBe(200);
    const encBody = enc.body as {
      ciphertext: string;
      ciphertextCrc32c: string;
    };
    expect(encBody.ciphertextCrc32c).toBe(
      crc32cString(new Uint8Array(Buffer.from(encBody.ciphertext, 'base64')))
    );

    const dec = await call('kms.cryptoKeys.decrypt', {
      params: keyParams,
      body: { ciphertext: encBody.ciphertext },
    });

    expect(dec.status).toBe(200);
    expect(fromB64((dec.body as { plaintext: string }).plaintext)).toBe('wire secret');
  });

  test('reads an empty plaintext as absent, the way proto3 does', async () => {
    const enc = await call('kms.cryptoKeys.encrypt', {
      params: keyParams,
      body: { plaintext: '' },
    });

    expect(enc.status).toBe(400);
    expect(enc.body).toMatchObject({ error: { status: 'INVALID_ARGUMENT' } });
  });

  test('reads an empty additionalAuthenticatedData as no AAD at all', async () => {
    const enc = await call('kms.cryptoKeys.encrypt', {
      params: keyParams,
      body: { plaintext: b64('no aad'), additionalAuthenticatedData: '' },
    });

    expect(enc.status).toBe(200);

    const dec = await call('kms.cryptoKeys.decrypt', {
      params: keyParams,
      body: { ciphertext: (enc.body as { ciphertext: string }).ciphertext },
    });

    expect(dec.status).toBe(200);
    expect(fromB64((dec.body as { plaintext: string }).plaintext)).toBe('no aad');
  });

  test('rejects malformed base64 instead of encrypting the characters it recognizes', async () => {
    const enc = await call('kms.cryptoKeys.encrypt', {
      params: keyParams,
      body: { plaintext: '!!! not base64 !!!' },
    });

    expect(enc.status).toBe(400);
    expect(enc.body).toMatchObject({ error: { status: 'INVALID_ARGUMENT' } });
  });

  test('accepts url-safe base64 and unpadded base64', async () => {
    const plaintext = new Uint8Array([0xfb, 0xff, 0xbf]);
    const urlSafe = Buffer.from(plaintext).toString('base64url');

    expect(urlSafe).toBe('-_-_');

    const enc = await call('kms.cryptoKeys.encrypt', {
      params: keyParams,
      body: { plaintext: urlSafe },
    });

    expect(enc.status).toBe(200);

    const dec = await call('kms.cryptoKeys.decrypt', {
      params: keyParams,
      body: { ciphertext: (enc.body as { ciphertext: string }).ciphertext },
    });

    expect(dec.status).toBe(200);
    expect(
      new Uint8Array(Buffer.from((dec.body as { plaintext: string }).plaintext, 'base64'))
    ).toEqual(plaintext);
  });

  test('returns the crypto key version that encrypted in name, per EncryptResponse', async () => {
    const enc = await call('kms.cryptoKeys.encrypt', {
      params: keyParams,
      body: { plaintext: b64('wire secret') },
    });

    expect(enc.status).toBe(200);

    const encBody = enc.body as Record<string, unknown>;

    expect(encBody.name).toBe(
      `projects/${PROJECT}/locations/${LOCATION}/keyRings/r/cryptoKeys/k/cryptoKeyVersions/1`
    );
    expect(encBody).not.toHaveProperty('keyVersion');
  });

  test('reports the promoted version in name after the primary is rotated', async () => {
    await call('kms.cryptoKeyVersions.create', { params: keyParams });
    await call('kms.cryptoKeys.updatePrimaryVersion', {
      params: keyParams,
      body: { cryptoKeyVersionId: '2' },
    });

    const enc = await call('kms.cryptoKeys.encrypt', {
      params: keyParams,
      body: { plaintext: b64('after rotation') },
    });

    expect(enc.status).toBe(200);
    expect((enc.body as { name: string }).name.endsWith('/cryptoKeyVersions/2')).toBe(true);
  });

  test('accepts a matching plaintext crc32c and reports it verified', async () => {
    const plaintext = 'checked';
    const res = await call('kms.cryptoKeys.encrypt', {
      params: keyParams,
      body: {
        plaintext: b64(plaintext),
        plaintextCrc32c: crc32cString(new Uint8Array(Buffer.from(plaintext))),
      },
    });

    expect(res.status).toBe(200);
    expect((res.body as { verifiedPlaintextCrc32c: boolean }).verifiedPlaintextCrc32c).toBe(true);
  });

  test('rejects a mismatched plaintext crc32c with 400', async () => {
    const res = await call('kms.cryptoKeys.encrypt', {
      params: keyParams,
      body: { plaintext: b64('data'), plaintextCrc32c: '1' },
    });

    expect(res.status).toBe(400);
  });

  test('missing plaintext yields 400', async () => {
    const res = await call('kms.cryptoKeys.encrypt', { params: keyParams, body: {} });

    expect(res.status).toBe(400);
  });
});

describe('random bytes', () => {
  test('generates the requested number of random bytes', async () => {
    const res = await call('kms.locations.generateRandomBytes', {
      params: { project: PROJECT, location: LOCATION },
      body: { lengthBytes: 32, protectionLevel: 'SOFTWARE' },
    });

    expect(res.status).toBe(200);
    const data = (res.body as { data: string }).data;
    expect(Buffer.from(data, 'base64').length).toBe(32);
  });

  test('rejects an out-of-range random byte length with 400', async () => {
    const res = await call('kms.locations.generateRandomBytes', {
      params: { project: PROJECT, location: LOCATION },
      body: { lengthBytes: 99999 },
    });

    expect(res.status).toBe(400);
  });
});

describe('full resource + crypto lifecycle through routes', () => {
  const kp = (cryptoKey: string): Record<string, string> => ({ ...ringParams, cryptoKey });
  const vp = (cryptoKey: string, version = '1'): Record<string, string> => ({
    ...kp(cryptoKey),
    version,
  });

  beforeEach(async () => {
    await call('kms.keyRings.create', {
      params: { project: PROJECT, location: LOCATION },
      query: { keyRingId: 'r' },
    });
  });

  test('key ring get + list', async () => {
    const get = await call('kms.keyRings.get', { params: ringParams });
    expect(get.status).toBe(200);

    const list = await call('kms.keyRings.list', {
      params: { project: PROJECT, location: LOCATION },
    });
    expect(list.status).toBe(200);
    expect((list.body as { keyRings: unknown[] }).keyRings).toHaveLength(1);
  });

  test('crypto key get + list + patch', async () => {
    await call('kms.cryptoKeys.create', {
      params: ringParams,
      query: { cryptoKeyId: 'k' },
      body: { purpose: 'ENCRYPT_DECRYPT' },
    });

    expect((await call('kms.cryptoKeys.get', { params: kp('k') })).status).toBe(200);

    const list = await call('kms.cryptoKeys.list', { params: ringParams });
    expect((list.body as { cryptoKeys: unknown[] }).cryptoKeys).toHaveLength(1);

    const patched = await call('kms.cryptoKeys.patch', {
      params: kp('k'),
      query: { updateMask: 'labels' },
      body: { labels: { team: 'crm' } },
    });
    expect((patched.body as { labels: Record<string, string> }).labels.team).toBe('crm');
  });

  test('version create + get + list + disable + updatePrimaryVersion', async () => {
    await call('kms.cryptoKeys.create', {
      params: ringParams,
      query: { cryptoKeyId: 'k' },
      body: { purpose: 'ENCRYPT_DECRYPT' },
    });

    const v2 = await call('kms.cryptoKeyVersions.create', { params: kp('k') });
    expect((v2.body as { name: string }).name.endsWith('/cryptoKeyVersions/2')).toBe(true);

    expect((await call('kms.cryptoKeyVersions.get', { params: vp('k') })).status).toBe(200);

    const list = await call('kms.cryptoKeyVersions.list', { params: kp('k') });
    expect((list.body as { cryptoKeyVersions: unknown[] }).cryptoKeyVersions).toHaveLength(2);

    const promoted = await call('kms.cryptoKeys.updatePrimaryVersion', {
      params: kp('k'),
      body: { cryptoKeyVersionId: '2' },
    });
    expect(
      (promoted.body as { primary: { name: string } }).primary.name.endsWith('/cryptoKeyVersions/2')
    ).toBe(true);

    const disabled = await call('kms.cryptoKeyVersions.patch', {
      params: vp('k'),
      query: { updateMask: 'state' },
      body: { state: 'DISABLED' },
    });
    expect((disabled.body as { state: string }).state).toBe('DISABLED');
  });

  test('version destroy + restore', async () => {
    await call('kms.cryptoKeys.create', {
      params: ringParams,
      query: { cryptoKeyId: 'k' },
      body: { purpose: 'ENCRYPT_DECRYPT' },
    });

    const destroyed = await call('kms.cryptoKeyVersions.destroy', { params: vp('k') });
    expect((destroyed.body as { state: string }).state).toBe('DESTROY_SCHEDULED');

    const restored = await call('kms.cryptoKeyVersions.restore', { params: vp('k') });
    expect((restored.body as { state: string }).state).toBe('DISABLED');
  });

  test('asymmetric sign + getPublicKey verify', async () => {
    await call('kms.cryptoKeys.create', {
      params: ringParams,
      query: { cryptoKeyId: 'ec' },
      body: { purpose: 'ASYMMETRIC_SIGN', versionTemplate: { algorithm: 'EC_SIGN_P256_SHA256' } },
    });

    const signed = await call('kms.cryptoKeyVersions.asymmetricSign', {
      params: vp('ec'),
      body: { data: b64('sign me') },
    });
    expect(signed.status).toBe(200);

    const pub = await call('kms.cryptoKeyVersions.getPublicKey', { params: vp('ec') });
    const pem = (pub.body as { pem: string }).pem;
    const signature = Buffer.from((signed.body as { signature: string }).signature, 'base64');

    const ok = cryptoVerify(
      'sha256',
      Buffer.from('sign me'),
      { key: createPublicKey(pem), dsaEncoding: 'der' },
      signature
    );
    expect(ok).toBe(true);
  });

  test('asymmetric decrypt round-trip', async () => {
    await call('kms.cryptoKeys.create', {
      params: ringParams,
      query: { cryptoKeyId: 'dec' },
      body: {
        purpose: 'ASYMMETRIC_DECRYPT',
        versionTemplate: { algorithm: 'RSA_DECRYPT_OAEP_2048_SHA256' },
      },
    });

    const pub = await call('kms.cryptoKeyVersions.getPublicKey', { params: vp('dec') });
    const pem = (pub.body as { pem: string }).pem;

    const ciphertext = publicEncrypt(
      { key: createPublicKey(pem), padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
      Buffer.from('rsa wire secret')
    ).toString('base64');

    const dec = await call('kms.cryptoKeyVersions.asymmetricDecrypt', {
      params: vp('dec'),
      body: { ciphertext },
    });
    expect(fromB64((dec.body as { plaintext: string }).plaintext)).toBe('rsa wire secret');
  });

  test('mac sign + verify', async () => {
    await call('kms.cryptoKeys.create', {
      params: ringParams,
      query: { cryptoKeyId: 'mac' },
      body: { purpose: 'MAC', versionTemplate: { algorithm: 'HMAC_SHA256' } },
    });

    const signed = await call('kms.cryptoKeyVersions.macSign', {
      params: vp('mac'),
      body: { data: b64('msg') },
    });
    const mac = (signed.body as { mac: string }).mac;

    const verified = await call('kms.cryptoKeyVersions.macVerify', {
      params: vp('mac'),
      body: { data: b64('msg'), mac },
    });
    expect((verified.body as { success: boolean }).success).toBe(true);
  });
});
