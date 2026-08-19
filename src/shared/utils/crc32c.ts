/**
 * CRC32C (Castagnoli) checksum utility.
 *
 * GCP APIs that carry data-integrity checksums (Cloud Storage object hashes,
 * Cloud KMS encrypt/decrypt payloads) use CRC32C with the Castagnoli polynomial
 * (0x82F63B78), NOT the IEEE polynomial (0xEDB88320) used by zlib.crc32().
 * Using the wrong polynomial silently produces checksums that real GCP client
 * libraries reject, so the implementation lives here as a shared, tested unit.
 */

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

/**
 * Compute the CRC32C (Castagnoli) checksum of a byte buffer as an unsigned
 * 32-bit integer.
 */
export function crc32c(data: Uint8Array): number {
  let crc = 0xffffffff;

  for (let i = 0; i < data.length; i++) {
    crc = (crc >>> 8) ^ (CRC32C_TABLE[(crc ^ (data[i] as number)) & 0xff] as number);
  }

  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Compute the CRC32C checksum as a base-10 string.
 *
 * Cloud KMS encodes its `*Crc32c` fields as protobuf `Int64Value`, which is
 * serialized as a decimal string in the REST/JSON transport. Returning a string
 * keeps handlers aligned with what the official client libraries send and expect.
 */
export function crc32cString(data: Uint8Array): string {
  return crc32c(data).toString();
}

/**
 * Compute the CRC32C checksum as a 4-byte big-endian, base64-encoded string.
 *
 * Cloud Storage encodes object `crc32c` hashes this way (unlike KMS, which uses
 * a decimal Int64 string).
 */
export function crc32cBase64(data: Uint8Array): string {
  const value = crc32c(data);
  const buf = new ArrayBuffer(4);

  new DataView(buf).setUint32(0, value, false);

  return Buffer.from(buf).toString('base64');
}
