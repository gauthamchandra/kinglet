/**
 * Blob Store - filesystem-based binary object data storage for GCS emulation
 */

import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface BlobStoreResult {
  blobPath: string;
  md5Hash: string;
  crc32c: string;
  size: number;
}

// ── CRC32C Implementation ──
// GCS requires CRC32C (Castagnoli, polynomial 0x82F63B78), NOT standard CRC32.
// zlib.crc32() uses the IEEE polynomial (0xEDB88320) and would produce incorrect
// checksums, so we use a hand-rolled lookup table here.

const CRC32C_TABLE = new Uint32Array(256);

(function initCrc32cTable() {
  for (let i = 0; i < 256; i++) {
    let crc = i;

    for (let j = 0; j < 8; j++) {
      crc = crc & 1 ? (crc >>> 1) ^ 0x82f63b78 : crc >>> 1;
    }

    CRC32C_TABLE[i] = crc;
  }
})();

function computeCrc32c(data: Uint8Array): number {
  let crc = 0xffffffff;

  for (let i = 0; i < data.length; i++) {
    crc = (crc >>> 8) ^ (CRC32C_TABLE[(crc ^ (data[i] as number)) & 0xff] as number);
  }

  return (crc ^ 0xffffffff) >>> 0;
}

export class BlobStore {
  private basePath: string;

  constructor(basePath?: string) {
    this.basePath = basePath ?? join(tmpdir(), `gcs-blobs-${crypto.randomUUID()}`);
    mkdirSync(this.basePath, { recursive: true });
  }

  async store(
    bucket: string,
    objectName: string,
    generation: string,
    data: Uint8Array
  ): Promise<BlobStoreResult> {
    const nameHash = new Bun.CryptoHasher('sha256').update(objectName).digest('hex');
    const dir = join(this.basePath, bucket);

    mkdirSync(dir, { recursive: true });

    const blobPath = join(dir, `${nameHash}-${generation}`);

    await Bun.write(blobPath, data);

    const { md5Hash, crc32c } = this.computeHashes(data);

    return { blobPath, md5Hash, crc32c, size: data.length };
  }

  async retrieve(blobPath: string): Promise<Uint8Array | null> {
    const file = Bun.file(blobPath);

    if (!(await file.exists())) {
      return null;
    }

    return new Uint8Array(await file.arrayBuffer());
  }

  async delete(blobPath: string): Promise<boolean> {
    const file = Bun.file(blobPath);

    if (!(await file.exists())) {
      return false;
    }

    rmSync(blobPath);
    return true;
  }

  computeHashes(data: Uint8Array): { md5Hash: string; crc32c: string } {
    const md5 = new Bun.CryptoHasher('md5').update(data).digest('base64');

    const crc32cValue = computeCrc32c(data);
    const buf = new ArrayBuffer(4);
    new DataView(buf).setUint32(0, crc32cValue, false);
    const crc32cBase64 = Buffer.from(buf).toString('base64');

    return { md5Hash: md5, crc32c: crc32cBase64 };
  }

  cleanup(): void {
    if (existsSync(this.basePath)) {
      rmSync(this.basePath, { recursive: true, force: true });
    }
  }

  getBasePath(): string {
    return this.basePath;
  }
}
