/**
 * Evaluation cases for terraform/compute.tf.
 *
 * Kept next to the fixture so a reader can match request → rule without
 * inverting CEL.
 */

export interface ArmorEvaluationCase {
  readonly name: string;
  readonly method?: string;
  readonly path: string;
  readonly originIp: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly expectStatus: number;
  readonly expectAction: string;
  readonly expectPriority: string;
  readonly expectPreviewAction?: string;
  readonly expectLocation?: string;
}

const APP_HOST = { Host: 'app.example.com' } as const;

export const ARMOR_EVALUATION_CASES: readonly ArmorEvaluationCase[] = [
  {
    name: 'path prefix deny',
    path: '/admin',
    originIp: '203.0.113.10',
    headers: APP_HOST,
    expectStatus: 403,
    expectAction: 'deny(403)',
    expectPriority: '100',
  },
  {
    name: 'default allow on /public',
    path: '/public',
    originIp: '203.0.113.10',
    headers: APP_HOST,
    expectStatus: 200,
    expectAction: 'allow',
    expectPriority: '2147483647',
  },
  {
    name: 'path equality deny(404)',
    path: '/hidden',
    originIp: '203.0.113.10',
    headers: APP_HOST,
    expectStatus: 404,
    expectAction: 'deny(404)',
    expectPriority: '200',
  },
  {
    name: 'redirect retired login',
    path: '/login-old',
    originIp: '203.0.113.10',
    headers: APP_HOST,
    expectStatus: 302,
    expectAction: 'redirect',
    expectPriority: '300',
    expectLocation: 'https://example.com/login',
  },
  {
    name: 'method + path deny',
    method: 'PUT',
    path: '/api/items',
    originIp: '203.0.113.10',
    headers: APP_HOST,
    expectStatus: 403,
    expectAction: 'deny(403)',
    expectPriority: '400',
  },
  {
    name: 'blocked source range',
    path: '/public',
    originIp: '198.51.100.20',
    headers: APP_HOST,
    expectStatus: 403,
    expectAction: 'deny(403)',
    expectPriority: '500',
  },
  {
    name: 'office allow on /internal',
    path: '/internal',
    originIp: '192.0.2.10',
    headers: APP_HOST,
    expectStatus: 200,
    expectAction: 'allow',
    expectPriority: '600',
  },
  {
    name: 'non-office deny on /internal',
    path: '/internal',
    originIp: '203.0.113.10',
    headers: APP_HOST,
    expectStatus: 403,
    expectAction: 'deny(403)',
    expectPriority: '700',
  },
  {
    name: 'User-Agent deny',
    path: '/public',
    originIp: '203.0.113.10',
    headers: { ...APP_HOST, 'User-Agent': 'BadBot/1.0' },
    expectStatus: 403,
    expectAction: 'deny(403)',
    expectPriority: '800',
  },
  {
    name: 'query string deny',
    path: '/public?debug=1',
    originIp: '203.0.113.10',
    headers: APP_HOST,
    expectStatus: 403,
    expectAction: 'deny(403)',
    expectPriority: '900',
  },
  {
    name: 'unexpected Host deny',
    path: '/public',
    originIp: '203.0.113.10',
    headers: { Host: 'evil.example.com' },
    expectStatus: 403,
    expectAction: 'deny(403)',
    expectPriority: '1000',
  },
  {
    name: 'RE2 path deny',
    path: '/secret/token',
    originIp: '203.0.113.10',
    headers: APP_HOST,
    expectStatus: 403,
    expectAction: 'deny(403)',
    expectPriority: '1100',
  },
  {
    name: 'preview deny does not enforce',
    path: '/preview-me',
    originIp: '203.0.113.10',
    headers: APP_HOST,
    expectStatus: 200,
    expectAction: 'allow',
    expectPriority: '2147483647',
    expectPreviewAction: 'deny(403)',
  },
  {
    name: 'throttle first request conforms',
    path: '/limited',
    originIp: '203.0.113.40',
    headers: APP_HOST,
    expectStatus: 200,
    expectAction: 'allow',
    expectPriority: '1300',
  },
  {
    name: 'throttle second request exceeds',
    path: '/limited',
    originIp: '203.0.113.40',
    headers: APP_HOST,
    expectStatus: 429,
    expectAction: 'deny(429)',
    expectPriority: '1300',
  },
  {
    name: 'deny(502)',
    path: '/upstream-down',
    originIp: '203.0.113.10',
    headers: APP_HOST,
    expectStatus: 502,
    expectAction: 'deny(502)',
    expectPriority: '1400',
  },
  {
    name: 'ASN and region deny',
    path: '/public',
    originIp: '203.0.113.10',
    headers: {
      ...APP_HOST,
      'X-Kinglet-Origin-ASN': '15169',
      'X-Kinglet-Origin-Region-Code': 'US',
    },
    expectStatus: 403,
    expectAction: 'deny(403)',
    expectPriority: '1500',
  },
  {
    name: 'JA3 fingerprint deny',
    path: '/public',
    originIp: '203.0.113.10',
    headers: {
      ...APP_HOST,
      'X-Kinglet-Origin-JA3': 'e7d705a3286e19ea42f587a344ee6862',
    },
    expectStatus: 403,
    expectAction: 'deny(403)',
    expectPriority: '1600',
  },
  {
    name: 'SNI throttle first request conforms',
    path: '/sni-limited',
    originIp: '203.0.113.50',
    headers: {
      ...APP_HOST,
      'X-Kinglet-Origin-SNI': 'cdn.example.com',
    },
    expectStatus: 200,
    expectAction: 'allow',
    expectPriority: '1700',
  },
  {
    name: 'SNI throttle second request exceeds',
    path: '/sni-limited',
    originIp: '203.0.113.50',
    headers: {
      ...APP_HOST,
      'X-Kinglet-Origin-SNI': 'cdn.example.com',
    },
    expectStatus: 429,
    expectAction: 'deny(429)',
    expectPriority: '1700',
  },
  {
    name: 'SNI throttle other SNI does not share the bucket',
    path: '/sni-limited',
    originIp: '203.0.113.51',
    headers: {
      ...APP_HOST,
      'X-Kinglet-Origin-SNI': 'other.example.com',
    },
    expectStatus: 200,
    expectAction: 'allow',
    expectPriority: '1700',
  },
  {
    name: 'WAF opted-out signature does not match',
    path: '/public',
    originIp: '203.0.113.10',
    headers: {
      ...APP_HOST,
      'X-Kinglet-Waf-Match': 'protocolattack-v33-stable/owasp-crs-v030301-id921110-protocolattack',
    },
    expectStatus: 200,
    expectAction: 'allow',
    expectPriority: '2147483647',
  },
  {
    name: 'WAF other signature in the same set denies',
    path: '/public',
    originIp: '203.0.113.10',
    headers: {
      ...APP_HOST,
      'X-Kinglet-Waf-Match': 'protocolattack-v33-stable/owasp-crs-v030301-id921150-protocolattack',
    },
    expectStatus: 403,
    expectAction: 'deny(403)',
    expectPriority: '1800',
  },
  {
    name: 'Adaptive Protection declared hit denies',
    path: '/public',
    originIp: '203.0.113.10',
    headers: {
      ...APP_HOST,
      'X-Kinglet-Adaptive-Protection': 'true',
    },
    expectStatus: 403,
    expectAction: 'deny(403)',
    expectPriority: '1900',
  },
];

export async function runArmorEvaluationCases(
  listenerEndpoint: string,
  cases: readonly ArmorEvaluationCase[] = ARMOR_EVALUATION_CASES
): Promise<void> {
  for (const evaluationCase of cases) {
    const response = await fetch(`${listenerEndpoint}${evaluationCase.path}`, {
      method: evaluationCase.method ?? 'GET',
      redirect: 'manual',
      headers: {
        ...evaluationCase.headers,
        'X-Kinglet-Origin-IP': evaluationCase.originIp,
      },
    });

    const action = response.headers.get('x-kinglet-enforced-action');
    const priority = response.headers.get('x-kinglet-enforced-priority');

    if (response.status !== evaluationCase.expectStatus) {
      throw new Error(
        `[${evaluationCase.name}] expected status ${evaluationCase.expectStatus}, got ${response.status} (${action} @ ${priority})`
      );
    }

    if (action !== evaluationCase.expectAction) {
      throw new Error(
        `[${evaluationCase.name}] expected action ${evaluationCase.expectAction}, got ${action}`
      );
    }

    if (priority !== evaluationCase.expectPriority) {
      throw new Error(
        `[${evaluationCase.name}] expected priority ${evaluationCase.expectPriority}, got ${priority}`
      );
    }

    if (
      evaluationCase.expectPreviewAction != null &&
      response.headers.get('x-kinglet-preview-action') !== evaluationCase.expectPreviewAction
    ) {
      throw new Error(
        `[${evaluationCase.name}] expected preview action ${evaluationCase.expectPreviewAction}, got ${response.headers.get('x-kinglet-preview-action')}`
      );
    }

    if (
      evaluationCase.expectLocation != null &&
      response.headers.get('location') !== evaluationCase.expectLocation
    ) {
      throw new Error(
        `[${evaluationCase.name}] expected Location ${evaluationCase.expectLocation}, got ${response.headers.get('location')}`
      );
    }
  }
}
