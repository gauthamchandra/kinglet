/**
 * End-to-End Test: Cloud KMS Workflow
 *
 * Two black-box paths against a running emulator:
 *   1. Raw HTTP fetch (full key lifecycle + every crypto operation)
 *   2. The official @google-cloud/kms client library over REST
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createPublicKey, verify as cryptoVerify } from 'node:crypto';
import { KeyManagementServiceClient } from '@google-cloud/kms';
import type { Server } from 'bun';
import { createLocationRoutes } from '@/core/gateway/location-routes.ts';
import { StorageManager } from '@/core/storage/manager.ts';
import { CloudKmsService } from '@/services/kms/index.ts';
import { Logger } from '@/shared/utils/logger.ts';
import { getAvailablePort } from '../test-utils/helpers.ts';
import { buildProductionRouter, createFakeAuth } from './e2e-helpers.ts';

let emulatorServer: Server;
let emulatorPort: number;
let service: CloudKmsService;

const b64 = (s: string): string => Buffer.from(s).toString('base64');

function url(path: string): string {
  return `http://localhost:${emulatorPort}${path}`;
}

async function postJson(path: string, body: unknown): Promise<Response> {
  return fetch(url(path), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeAll(async () => {
  emulatorPort = await getAvailablePort();

  const logger = new Logger('e2e-kms', 'error');
  const storage = new StorageManager();
  await storage.initialize({ type: 'memory' });

  service = new CloudKmsService(storage, logger);
  await service.initialize();

  // The production RequestRouter, not the simplified e2e matcher: KMS carries resource
  // ids in the URL path, so path normalization has to be part of what these tests cover.
  emulatorServer = Bun.serve({
    port: emulatorPort,
    fetch: buildProductionRouter([...createLocationRoutes(logger), ...service.getRoutes()]),
  });
});

afterAll(async () => {
  await service.stop();
  emulatorServer.stop();
});

// ── Path 1: Raw HTTP ──

describe('Cloud KMS E2E: Raw HTTP API', () => {
  const project = 'raw-project';
  const location = 'us-central1';
  const base = `/v1/projects/${project}/locations/${location}`;
  const ring = 'raw-ring';
  const ringPath = `${base}/keyRings/${ring}`;

  test('1. create key ring', async () => {
    const res = await postJson(`${base}/keyRings?keyRingId=${ring}`, {});

    expect(res.status).toBe(200);
    expect((await res.json()).name).toBe(
      `projects/${project}/locations/${location}/keyRings/${ring}`
    );
  });

  test('2. symmetric encrypt/decrypt round-trip', async () => {
    const keyPath = `${ringPath}/cryptoKeys/sym`;

    const create = await postJson(`${ringPath}/cryptoKeys?cryptoKeyId=sym`, {
      purpose: 'ENCRYPT_DECRYPT',
    });
    expect(create.status).toBe(200);
    expect((await create.json()).primary.state).toBe('ENABLED');

    const enc = await postJson(`${keyPath}:encrypt`, { plaintext: b64('raw secret') });
    expect(enc.status).toBe(200);
    const { ciphertext } = await enc.json();

    const dec = await postJson(`${keyPath}:decrypt`, { ciphertext });
    expect(dec.status).toBe(200);
    expect(Buffer.from((await dec.json()).plaintext, 'base64').toString()).toBe('raw secret');
  });

  test('3. rotation: new version, promote primary, old ciphertext still decrypts', async () => {
    const keyPath = `${ringPath}/cryptoKeys/sym`;

    const oldCipher = (
      await (await postJson(`${keyPath}:encrypt`, { plaintext: b64('v1') })).json()
    ).ciphertext;

    const v2 = await postJson(`${keyPath}/cryptoKeyVersions`, {});
    expect((await v2.json()).name.endsWith('/cryptoKeyVersions/2')).toBe(true);

    await postJson(`${keyPath}:updatePrimaryVersion`, { cryptoKeyVersionId: '2' });

    const newEnc = await (await postJson(`${keyPath}:encrypt`, { plaintext: b64('v2') })).json();
    expect(newEnc.name.endsWith('/cryptoKeyVersions/2')).toBe(true);

    const dec = await (await postJson(`${keyPath}:decrypt`, { ciphertext: oldCipher })).json();
    expect(Buffer.from(dec.plaintext, 'base64').toString()).toBe('v1');
  });

  test('4. asymmetric sign + getPublicKey verifies', async () => {
    await postJson(`${ringPath}/cryptoKeys?cryptoKeyId=ec`, {
      purpose: 'ASYMMETRIC_SIGN',
      versionTemplate: { algorithm: 'EC_SIGN_P256_SHA256' },
    });

    const versionPath = `${ringPath}/cryptoKeys/ec/cryptoKeyVersions/1`;
    const message = 'raw sign me';

    const signed = await (
      await postJson(`${versionPath}:asymmetricSign`, { data: b64(message) })
    ).json();
    const pub = await (await fetch(url(`${versionPath}/publicKey`))).json();

    const ok = cryptoVerify(
      'sha256',
      Buffer.from(message),
      { key: createPublicKey(pub.pem), dsaEncoding: 'der' },
      Buffer.from(signed.signature, 'base64')
    );

    expect(ok).toBe(true);
  });

  test('5. MAC sign + verify', async () => {
    await postJson(`${ringPath}/cryptoKeys?cryptoKeyId=mac`, {
      purpose: 'MAC',
      versionTemplate: { algorithm: 'HMAC_SHA256' },
    });

    const versionPath = `${ringPath}/cryptoKeys/mac/cryptoKeyVersions/1`;
    const signed = await (await postJson(`${versionPath}:macSign`, { data: b64('mac me') })).json();

    const verified = await (
      await postJson(`${versionPath}:macVerify`, { data: b64('mac me'), mac: signed.mac })
    ).json();

    expect(verified.success).toBe(true);
  });

  test('6. generateRandomBytes', async () => {
    const res = await postJson(`${base}:generateRandomBytes`, {
      lengthBytes: 24,
      protectionLevel: 'SOFTWARE',
    });

    expect(res.status).toBe(200);
    expect(Buffer.from((await res.json()).data, 'base64').length).toBe(24);
  });

  test('7. destroy then restore a version', async () => {
    const versionPath = `${ringPath}/cryptoKeys/mac/cryptoKeyVersions/1`;

    const destroyed = await (await postJson(`${versionPath}:destroy`, {})).json();
    expect(destroyed.state).toBe('DESTROY_SCHEDULED');

    const restored = await (await postJson(`${versionPath}:restore`, {})).json();
    expect(restored.state).toBe('DISABLED');
  });

  test('8. errors: corrupt ciphertext -> 400, missing key -> 404', async () => {
    const keyPath = `${ringPath}/cryptoKeys/sym`;

    expect((await postJson(`${keyPath}:decrypt`, { ciphertext: b64('garbage') })).status).toBe(400);
    expect((await fetch(url(`${ringPath}/cryptoKeys/ghost`))).status).toBe(404);
  });

  test('9. mixed-case resource ids stay addressable after creation', async () => {
    const mixedBase = `/v1/projects/My-Project/locations/${location}`;
    const mixedRing = `${mixedBase}/keyRings/MyRing`;
    const expectedRingName = `projects/My-Project/locations/${location}/keyRings/MyRing`;

    const created = await postJson(`${mixedBase}/keyRings?keyRingId=MyRing`, {});
    expect(created.status).toBe(200);
    expect((await created.json()).name).toBe(expectedRingName);

    const fetched = await fetch(url(mixedRing));
    expect(fetched.status).toBe(200);
    expect((await fetched.json()).name).toBe(expectedRingName);

    const key = await postJson(`${mixedRing}/cryptoKeys?cryptoKeyId=MyKey`, {
      purpose: 'ENCRYPT_DECRYPT',
    });
    expect(key.status).toBe(200);

    const enc = await postJson(`${mixedRing}/cryptoKeys/MyKey:encrypt`, {
      plaintext: b64('mixed case secret'),
    });
    expect(enc.status).toBe(200);

    const { ciphertext } = await enc.json();
    const dec = await postJson(`${mixedRing}/cryptoKeys/MyKey:decrypt`, { ciphertext });

    expect(dec.status).toBe(200);
    expect(Buffer.from((await dec.json()).plaintext, 'base64').toString()).toBe(
      'mixed case secret'
    );
  });

  test('10. lists and gets locations from the shared endpoint', async () => {
    const list = await fetch(url(`/v1/projects/${project}/locations`));
    expect(list.status).toBe(200);

    const { locations } = await list.json();
    expect(locations.map((l: { locationId: string }) => l.locationId)).toContain('global');

    const one = await fetch(url(`/v1/projects/${project}/locations/${location}`));
    expect(one.status).toBe(200);
    expect((await one.json()).locationId).toBe(location);
  });
});

// ── Path 2: Official @google-cloud/kms client ──

describe('Cloud KMS E2E: Client Library', () => {
  const project = 'client-project';
  const location = 'us-central1';
  const locationPath = `projects/${project}/locations/${location}`;

  let client: InstanceType<typeof KeyManagementServiceClient>;

  beforeAll(() => {
    client = new KeyManagementServiceClient({
      fallback: 'rest',
      apiEndpoint: 'localhost',
      port: emulatorPort,
      protocol: 'http',
      auth: createFakeAuth(project) as never,
    });
  });

  test('symmetric encrypt/decrypt round-trip via the official client', async () => {
    const [ring] = await client.createKeyRing({
      parent: locationPath,
      keyRingId: 'cl-ring',
      keyRing: {},
    });
    expect(ring.name).toContain('/keyRings/cl-ring');

    const [key] = await client.createCryptoKey({
      parent: ring.name,
      cryptoKeyId: 'cl-key',
      cryptoKey: {
        purpose: 'ENCRYPT_DECRYPT',
        versionTemplate: { algorithm: 'GOOGLE_SYMMETRIC_ENCRYPTION' },
      },
    });
    expect(key.name).toContain('/cryptoKeys/cl-key');

    const plaintext = Buffer.from('client library secret');
    const [encResp] = await client.encrypt({ name: key.name, plaintext });

    expect(encResp.ciphertext).toBeDefined();

    // EncryptResponse.name is the CryptoKeyVersion that encrypted; a field absent from
    // the proto would be dropped by the decoder and surface here as undefined.
    expect(encResp.name).toBe(`${key.name}/cryptoKeyVersions/1`);

    const [decResp] = await client.decrypt({ name: key.name, ciphertext: encResp.ciphertext });

    expect(Buffer.from(decResp.plaintext as Uint8Array).toString()).toBe('client library secret');
  });

  test('lists crypto keys via the official client', async () => {
    const [keys] = await client.listCryptoKeys({
      parent: `${locationPath}/keyRings/cl-ring`,
    });

    expect(keys.length).toBeGreaterThanOrEqual(1);
    expect(keys.some(k => k.name?.endsWith('/cryptoKeys/cl-key'))).toBe(true);
  });

  test('asymmetric sign via the official client verifies with the public key', async () => {
    const [ring] = await client.createKeyRing({
      parent: locationPath,
      keyRingId: 'cl-sign-ring',
      keyRing: {},
    });

    const [key] = await client.createCryptoKey({
      parent: ring.name,
      cryptoKeyId: 'cl-ec',
      cryptoKey: {
        purpose: 'ASYMMETRIC_SIGN',
        versionTemplate: { algorithm: 'EC_SIGN_P256_SHA256' },
      },
    });

    const versionName = `${key.name}/cryptoKeyVersions/1`;
    const message = Buffer.from('client signs this');

    const [signResp] = await client.asymmetricSign({ name: versionName, data: message });
    const [pubResp] = await client.getPublicKey({ name: versionName });

    const ok = cryptoVerify(
      'sha256',
      message,
      { key: createPublicKey(pubResp.pem as string), dsaEncoding: 'der' },
      Buffer.from(signResp.signature as Uint8Array)
    );

    expect(ok).toBe(true);
  });
});
