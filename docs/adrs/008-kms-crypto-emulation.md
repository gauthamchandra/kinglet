# ADR-008: Cloud KMS Crypto Emulation

## Status

Accepted

## Context

Cloud KMS differs from the services emulated so far. Scheduler, Tasks, Pub/Sub,
Storage, and Workflows are fundamentally *state machines over data*: their
behavior can be faithfully reproduced with CRUD, timers, and HTTP dispatch. KMS
is different — its entire value is performing **real cryptographic operations**
(encrypt/decrypt, sign/verify, MAC, random) keyed by managed key material. An
emulator that returned canned responses would be useless: callers verify
signatures with the returned public key, decrypt ciphertext they encrypted, and
check CRC32C integrity fields. The crypto has to actually work.

Three design problems had to be resolved:

1. **Which crypto library.** The project prefers Bun/WebCrypto APIs (see
   ADR-001). WebCrypto, however, cannot *synchronously* generate and export
   RSA/EC key pairs as PEM, and its surface for PKCS#1 v1.5, RSA-PSS with
   digest-length salt, and DER-encoded ECDSA is awkward.
2. **Ciphertext format for rotation.** Symmetric `decrypt` takes only the key
   name and ciphertext — it must locate the *specific key version* that
   encrypted the data, even after rotation has changed the primary version.
3. **How much of the (very large) KMS surface to implement** without shipping
   half-working features.

## Decision

### Use `node:crypto` for the crypto engine

The engine (`src/services/kms/crypto-engine.ts`) uses Node's `crypto` module
(fully supported by Bun) rather than WebCrypto. It is isolated, stateless, and
storage-free: algorithm name + key material in, bytes out. All transport
concerns (base64, CRC32C, JSON) stay in the handler layer.

### Self-describing symmetric ciphertext envelope

Symmetric ciphertext is an opaque, versioned envelope:

```
[0x01 format byte][key version id: uint32 BE][IV: 12B][GCM tag: 16B][ciphertext]
```

`decrypt` reads the embedded version id, loads that version's key material, and
authenticates with AES-256-GCM. This makes rotation correct by construction: old
ciphertext continues to decrypt against the version that produced it, while new
encryptions use the current primary version.

### Version ids derived from persisted versions, not a counter

A CryptoKey does not carry a "next version" counter. `cryptoKeyVersions.create`
reads the highest `versionNumber` already persisted for the key and adds one, and
allocations for a given key are queued so that read and the insert cannot
interleave with another allocation for the same key.

The obvious alternative — a `versionCounter` column bumped alongside the insert —
needs two writes to stay in step, and the storage layer cannot make them one:
the memory provider's transaction applies writes immediately and its rollback is
a no-op, so `withTransaction` would look atomic without being atomic. Deriving
the id from the versions themselves removes the second write entirely. A version
that exists *is* a number that has been handed out, including for DESTROYED
versions, whose rows remain and whose ids are therefore never reused.

### Empty `bytes` fields are read as absent

Proto3 cannot distinguish an empty `bytes` value from an omitted one — they are
byte-identical on the wire, and JSON `""` transcodes to the same empty field. So
`""` is treated as absent throughout: an optional field the caller did not set,
or a required one that is missing (`INVALID_ARGUMENT`). Malformed base64 is
rejected rather than decoded down to the characters `Buffer` happens to
recognize, which would otherwise encrypt or sign a silently truncated input.

### Real, software-backed crypto for a focused operation set

Implemented and tested end to end (including against the official
`@google-cloud/kms` client over REST):

- **Resource lifecycle**: key rings, crypto keys, crypto key versions; create /
  get / list / patch; rotation (`cryptoKeyVersions.create` +
  `updatePrimaryVersion`); enable/disable, destroy/restore.
- **Symmetric** `encrypt`/`decrypt` — AES-256-GCM, with additional
  authenticated data.
- **Asymmetric** `asymmetricSign` (EC P-256/P-384, RSA-PKCS1, RSA-PSS),
  `asymmetricDecrypt` (RSA-OAEP), and `getPublicKey` (SPKI PEM).
- **MAC** `macSign`/`macVerify` (HMAC-SHA256).
- **`generateRandomBytes`**.
- **CRC32C** integrity fields on the wire (decimal Int64 strings), verified on
  request and computed on response.

All operations are `protectionLevel: SOFTWARE`. Requests for `HSM`/`EXTERNAL` are
rejected with `INVALID_ARGUMENT` rather than silently pretending.

### Deferred to a future PR (documented, not silently missing)

- **IAM** (`getIamPolicy`/`setIamPolicy`/`testIamPermissions`) — deferred across
  *every* service in this project; the `/compatibility-audit` skill already
  treats IAM as a separate category.
- **`importJobs`** — external key wrapping/attestation; niche for local dev.
- **`rawEncrypt`/`rawDecrypt`** and post-quantum algorithms.
- **Precomputed `digest` signing for EC keys** — Node cannot portably sign a raw
  digest for ECDSA. `asymmetricSign` therefore prefers the `data` field (hashing
  internally); precomputed `digest` is supported for RSA-PKCS1 only. For EC keys,
  callers must send `data`.

## Rationale

- `node:crypto` is the only practical way to get synchronous keygen + PEM export
  + the exact signature schemes KMS uses; isolating it in one engine module keeps
  the Bun-first preference intact everywhere else.
- The versioned envelope is the minimal mechanism that makes rotation correct
  without a separate ciphertext-to-version index.
- Returning *correct* CRC32C (reusing the shared Castagnoli implementation in
  `src/shared/utils/crc32c.ts`) is what lets real client libraries that perform
  data-integrity verification interoperate with the emulator.
- Restricting to SOFTWARE and rejecting unsupported algorithms keeps the
  emulator honest: every operation it accepts, it performs correctly.

## Alternatives Considered

- **WebCrypto only** — rejected: no synchronous keygen/PEM export, clumsy for
  PKCS#1/PSS/DER-ECDSA.
- **Stub crypto (echo / fixed values)** — rejected: defeats the purpose; real
  clients verify signatures and decrypt their own ciphertext.
- **Store ciphertext→version mapping in a table** — rejected in favor of the
  self-describing envelope, which needs no extra lookup and survives restarts.
- **Implement the entire KMS surface at once** — rejected: IAM/importJobs/raw/PQ
  are large and low-value for local development; shipping a correct, well-tested
  core beats a broad but shaky surface.

## Consequences

- The emulator performs genuine cryptography; signatures verify with standard
  tooling and ciphertext round-trips through the official SDK.
- Key material is stored in the (developer-local) storage backend in plaintext
  JSON. This is acceptable for a local emulator and must never be used for real
  secrets — documented for users.
- `protectionLevel` is always SOFTWARE; HSM/EXTERNAL semantics are not emulated.
- The deferred operations (IAM, importJobs, raw, EC-digest signing, PQ) are
  tracked in TASKS.md as Cloud KMS Phase 2.
- A new runtime-adjacent dev dependency (`@google-cloud/kms`) is added for the
  e2e compatibility suite only.
