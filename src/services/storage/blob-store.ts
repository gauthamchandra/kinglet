/**
 * Blob Store - filesystem-based binary object data storage for GCS emulation
 */

import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { crc32cBase64 } from '@/shared/utils/crc32c.ts';

export interface BlobStoreResult {
  blobPath: string;
  md5Hash: string;
  crc32c: string;
  size: number;
}

export class BlobStore {
  private basePath: string;
  private trackWrittenPaths: boolean;
  private writtenPaths = new Set<string>();

  constructor(basePath: string, options?: { trackWrittenPaths?: boolean }) {
    this.basePath = basePath;
    this.trackWrittenPaths = options?.trackWrittenPaths ?? true;
    mkdirSync(this.basePath, { recursive: true });
  }

  async store(
    bucket: string,
    _objectName: string,
    _generation: string,
    data: Uint8Array
  ): Promise<BlobStoreResult> {
    const dir = join(this.basePath, bucket);

    mkdirSync(dir, { recursive: true });

    // generation can match across processes. The file name does not use it.
    const blobPath = join(dir, crypto.randomUUID());

    await Bun.write(blobPath, data);

    if (this.trackWrittenPaths) {
      this.writtenPaths.add(blobPath);
    }

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
      this.writtenPaths.delete(blobPath);
      return false;
    }

    rmSync(blobPath);
    this.writtenPaths.delete(blobPath);
    return true;
  }

  computeHashes(data: Uint8Array): { md5Hash: string; crc32c: string } {
    const md5Hash = new Bun.CryptoHasher('md5').update(data).digest('base64');

    return { md5Hash, crc32c: crc32cBase64(data) };
  }

  cleanup(): void {
    for (const blobPath of this.writtenPaths) {
      try {
        rmSync(blobPath, { force: true });
        this.writtenPaths.delete(blobPath);
      } catch {
        // Keep the path so a later cleanup can retry.
      }
    }
  }

  getBasePath(): string {
    return this.basePath;
  }
}
