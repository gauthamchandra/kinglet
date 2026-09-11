# Testing Cloud Armor policies

Kinglet stores policies on the Compute control plane (`/compute/v1/`) and evaluates
requests on a **second HTTP server** in the same process. There is no origin behind
the rules. Terraform apply writes policies into `StorageManager`. The evaluation
server reads that same store, runs the Cloud Armor CEL engine, and returns a
synthetic status plus `X-Kinglet-*` headers.

| Enforced action | HTTP status | Body |
| --- | --- | --- |
| `allow` (including the default rule) | **200** | empty — “would have reached a backend,” not an app response |
| `deny(403\|404\|429\|502)` | that status | empty |
| `throttle` / `rate_based_ban` over limit | `exceedAction` (usually `deny(429)`) | empty |
| `redirect` (header phase) | 302 | `Location` from the rule |

Read `X-Kinglet-Enforced-Action`, `X-Kinglet-Enforced-Priority`, and
`X-Kinglet-Enforced-Outcome`. Status alone is not enough (`deny(404)` is a block,
not a missing origin).

## 1. Start kinglet

**Docker** — publish both ports. The image binds the evaluation server on
`0.0.0.0:8787` (unauthenticated):

```bash
docker run -d \
  -p 8765:8765 \
  -p 8787:8787 \
  --name kinglet \
  -e SERVICES=compute \
  -e STORAGE_TYPE=memory \
  -e AUTH_MODE=bypass \
  -e MEMORYSTORE_DATA_PLANE=false \
  ghcr.io/gauthamchandra/kinglet:latest
```

**Local bun** — default bind is `127.0.0.1`:

```bash
SERVICES=compute STORAGE_TYPE=memory AUTH_MODE=bypass MEMORYSTORE_DATA_PLANE=false \
  bun run src/index.ts
```

Wait until `/health` reports the evaluation server:

```bash
curl -s http://127.0.0.1:8765/health
```

```json
{
  "status": "ok",
  "kingletCloudArmorEvaluationServer": {
    "started": true,
    "port": 8787,
    "bind": "0.0.0.0"
  }
}
```

`status: ok` only means the control plane is up. If Compute is enabled and
`kingletCloudArmorEvaluationServer.started` is `false`, apply can succeed while
evaluation is unreachable.

| Variable | Default | Meaning |
| --- | --- | --- |
| `COMPUTE_LISTENER_PORT` | `8787` | Evaluation server port |
| `COMPUTE_LISTENER_BIND` | `127.0.0.1` (`0.0.0.0` in the Docker image) | Bind address |
| `COMPUTE_ARMOR_DEFAULT_POLICY` | unset | Required when more than one policy exists |

`evaluateAddressGroup` reads project-scoped Network Security address
groups from the same store. Enable both services (`SERVICES=compute,networksecurity`)
so Terraform can create the group and the evaluation server can see it.
`SERVICES=compute` alone still accepts the CEL call; a missing group is
not a match. Organization groups (`evaluateOrganizationAddressGroup`)
stay always-false. An optional third argument is an exclusion list
(CEL list of CIDR strings, or a comma-separated string): a group hit
that is also excluded is not a match. See
[ADR-015](../adrs/015-cloud-armor-evaluate-address-group.md).

## 2. Apply your policies

The point of the emulator is to apply the same Terraform you use for Cloud Armor
against kinglet. Point the Google provider at the control plane and use a dummy
`access_token` (kinglet’s default `AUTH_MODE=bypass` does not exchange a real
token).

Keep that apply on a **local or otherwise separate Terraform state**. The `.tf`
is what you want to reuse. The remote state that tracks live GCP is a different
store: it has production resource IDs and fingerprints. If apply/destroy with
`compute_custom_endpoint` pointed at kinglet writes into that backend, Terraform
will record kinglet’s IDs as if they were GCP’s (or the reverse on the next
un-overridden apply).

```hcl
provider "google" {
  project                 = var.project_id
  compute_custom_endpoint = "${var.kinglet_endpoint}/compute/v1/"
  access_token            = "dummy"
}
```

[`terraform/compute.tf`](../../terraform/compute.tf) is an 18-rule example
(path, IP, method, User-Agent, query, Host, RE2, preview, redirect, throttle,
`deny(404)` / `deny(502)`, default allow). Your own `google_compute_security_policy`
module is the usual input.

Backend services, URL maps, forwarding rules, reCAPTCHA, and Adaptive Protection
are not implemented yet — those Compute calls 404. A root that also creates them
may fail mid-apply. `-target` still follows implicit dependencies, so it may not
skip them. A policies-only workspace is one way through until those APIs exist.

```bash
terraform apply \
  -var=kinglet_endpoint=http://127.0.0.1:8765 \
  -state=/tmp/kinglet-armor.tfstate
```

## 3. Sample test suite

Always send `X-Kinglet-Origin-IP` (from Docker, the TCP peer is a bridge/NAT
address) and `Host` (otherwise `Host` is `127.0.0.1:8787`). Use
`redirect: 'manual'`. Assert **action and priority**, not status alone. Run
rate-limit cases sequentially and give each bucket its own IP.

Rules on `origin.asn` / `origin.region_code` need
`X-Kinglet-Origin-ASN` and `X-Kinglet-Origin-Region-Code`. Kinglet does not
yet look those up from the peer — that is a known gap versus GCP (see
[ADR-014](../adrs/014-cloud-armor-asn-region-headers.md#deferred-work)).
TEST-NET addresses would miss a real feed anyway.

Rules on `origin.tls_ja3_fingerprint` / `origin.tls_ja4_fingerprint` need
`X-Kinglet-Origin-JA3` (32 hex characters) and `X-Kinglet-Origin-JA4`.
`enforceOnKey: SNI` needs `X-Kinglet-Origin-SNI` (a hostname). A trailing
FQDN dot is stripped (RFC 6066 SNI has none). GCP has no `origin.sni`
CEL field — do not write one. `Host` is not SNI.

Kinglet does not terminate TLS, so fingerprints and SNI never come from
the wire. `request.scheme` stays `http`.

A bad override is 400 and does not evaluate, same as a bad Origin-IP. The
headers are stripped before CEL.

```ts
import { expect, test } from 'bun:test';

const EVAL = 'http://127.0.0.1:8787';

async function evaluate(
  path: string,
  init: { method?: string; originIp: string; headers?: Record<string, string> }
): Promise<Response> {
  return fetch(`${EVAL}${path}`, {
    method: init.method ?? 'GET',
    redirect: 'manual',
    headers: {
      Host: 'app.example.com',
      ...init.headers,
      'X-Kinglet-Origin-IP': init.originIp,
    },
  });
}

test('path prefix deny', async () => {
  const res = await evaluate('/admin', { originIp: '203.0.113.10' });

  expect(res.status).toBe(403);
  expect(res.headers.get('x-kinglet-enforced-action')).toBe('deny(403)');
  expect(res.headers.get('x-kinglet-enforced-priority')).toBe('100');
});

test('default allow', async () => {
  const res = await evaluate('/public', { originIp: '203.0.113.10' });

  expect(res.status).toBe(200);
  expect(res.headers.get('x-kinglet-enforced-action')).toBe('allow');
  expect(res.headers.get('x-kinglet-enforced-priority')).toBe('2147483647');
});

test('deny(404) is a block, not a missing origin', async () => {
  const res = await evaluate('/hidden', { originIp: '203.0.113.10' });

  expect(res.status).toBe(404);
  expect(res.headers.get('x-kinglet-enforced-action')).toBe('deny(404)');
  expect(res.headers.get('x-kinglet-enforced-priority')).toBe('200');
});

test('redirect', async () => {
  const res = await evaluate('/login-old', { originIp: '203.0.113.10' });

  expect(res.status).toBe(302);
  expect(res.headers.get('x-kinglet-enforced-action')).toBe('redirect');
  expect(res.headers.get('location')).toBe('https://example.com/login');
});

test('method + path', async () => {
  const res = await evaluate('/api/items', { method: 'PUT', originIp: '203.0.113.10' });

  expect(res.status).toBe(403);
  expect(res.headers.get('x-kinglet-enforced-priority')).toBe('400');
});

test('blocked source range', async () => {
  const res = await evaluate('/public', { originIp: '198.51.100.20' });

  expect(res.status).toBe(403);
  expect(res.headers.get('x-kinglet-enforced-priority')).toBe('500');
});

test('office allow vs catch-all /internal deny', async () => {
  const office = await evaluate('/internal', { originIp: '192.0.2.10' });
  const other = await evaluate('/internal', { originIp: '203.0.113.10' });

  expect(office.headers.get('x-kinglet-enforced-action')).toBe('allow');
  expect(office.headers.get('x-kinglet-enforced-priority')).toBe('600');
  expect(other.headers.get('x-kinglet-enforced-action')).toBe('deny(403)');
  expect(other.headers.get('x-kinglet-enforced-priority')).toBe('700');
});

test('User-Agent, query, Host, RE2', async () => {
  const bot = await evaluate('/public', {
    originIp: '203.0.113.10',
    headers: { 'User-Agent': 'BadBot/1.0' },
  });
  const debug = await evaluate('/public?debug=1', { originIp: '203.0.113.10' });
  const evil = await evaluate('/public', {
    originIp: '203.0.113.10',
    headers: { Host: 'evil.example.com' },
  });
  const secret = await evaluate('/secret/token', { originIp: '203.0.113.10' });

  expect(bot.headers.get('x-kinglet-enforced-priority')).toBe('800');
  expect(debug.headers.get('x-kinglet-enforced-priority')).toBe('900');
  expect(evil.headers.get('x-kinglet-enforced-priority')).toBe('1000');
  expect(secret.headers.get('x-kinglet-enforced-priority')).toBe('1100');
});

test('preview does not enforce', async () => {
  const res = await evaluate('/preview-me', { originIp: '203.0.113.10' });

  expect(res.status).toBe(200);
  expect(res.headers.get('x-kinglet-enforced-action')).toBe('allow');
  expect(res.headers.get('x-kinglet-preview-action')).toBe('deny(403)');
});

test('throttle is sequential and per IP', async () => {
  const first = await evaluate('/limited', { originIp: '203.0.113.40' });
  const second = await evaluate('/limited', { originIp: '203.0.113.40' });

  expect(first.status).toBe(200);
  expect(first.headers.get('x-kinglet-enforced-action')).toBe('allow');
  expect(second.status).toBe(429);
  expect(second.headers.get('x-kinglet-enforced-action')).toBe('deny(429)');
});

test('deny(502)', async () => {
  const res = await evaluate('/upstream-down', { originIp: '203.0.113.10' });

  expect(res.status).toBe(502);
  expect(res.headers.get('x-kinglet-enforced-priority')).toBe('1400');
});

test('ASN and region deny', async () => {
  const res = await evaluate('/public', {
    originIp: '203.0.113.10',
    headers: {
      'X-Kinglet-Origin-ASN': '15169',
      'X-Kinglet-Origin-Region-Code': 'US',
    },
  });

  expect(res.status).toBe(403);
  expect(res.headers.get('x-kinglet-enforced-priority')).toBe('1500');
});

test('JA3 fingerprint deny', async () => {
  const res = await evaluate('/public', {
    originIp: '203.0.113.10',
    headers: { 'X-Kinglet-Origin-JA3': 'e7d705a3286e19ea42f587a344ee6862' },
  });

  expect(res.status).toBe(403);
  expect(res.headers.get('x-kinglet-enforced-priority')).toBe('1600');
});

test('SNI throttle is sequential and per SNI', async () => {
  const first = await evaluate('/sni-limited', {
    originIp: '203.0.113.50',
    headers: { 'X-Kinglet-Origin-SNI': 'cdn.example.com' },
  });
  const second = await evaluate('/sni-limited', {
    originIp: '203.0.113.50',
    headers: { 'X-Kinglet-Origin-SNI': 'cdn.example.com' },
  });
  const other = await evaluate('/sni-limited', {
    originIp: '203.0.113.51',
    headers: { 'X-Kinglet-Origin-SNI': 'other.example.com' },
  });

  expect(first.status).toBe(200);
  expect(second.status).toBe(429);
  expect(other.status).toBe(200);
  expect(second.headers.get('x-kinglet-enforced-priority')).toBe('1700');
});
```

The in-repo harness runs the same requests after apply (`terraform/armor-evaluation.ts`).

## What this does not certify

| You might think you tested | What actually ran |
| --- | --- |
| WAF / `evaluatePreconfiguredWaf` | Writes succeed; the function is **false**; default allow often wins |
| `evaluateOrganizationAddressGroup`, threat intel, Adaptive Protection, reCAPTCHA | Same: apply may echo fields; the match never happens |
| Address groups without Network Security enabled | `evaluateAddressGroup` is **false** (empty table). Enable `networksecurity` and create the group in the policy’s project |
| Policy attached to a backend / URL map | The evaluation server picks one policy (`COMPUTE_ARMOR_DEFAULT_POLICY` or the sole policy). In GCP, no attachment means no Armor |
| HTTPS, JA3, SNI, geo | `request.scheme` is `http`. JA3/JA4/SNI are whatever you send on `X-Kinglet-Origin-JA3` / `JA4` / `SNI`, not a TLS handshake. `Host` is not SNI. ASN / region are **not** looked up from the peer (deferred; [ADR-014](../adrs/014-cloud-armor-asn-region-headers.md#deferred-work)) |
| CDN / proxy topology | `origin.ip` is the load-balancer peer. Set `X-Kinglet-Origin-IP` to **egress**, not the end user, when the rule is `SRC_IPS_V1` |
| GCP rate-limit flakiness | Local counters are exact and single-process |

A case that depends on an unsupported builtin should skip or fail, not pass as allow.
