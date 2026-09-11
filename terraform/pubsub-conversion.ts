/**
 * Pub/Sub terraform extras: publish while the convertible subscription is
 * push, switch it to pull, then assert the backlog is still readable.
 */

const PROJECT = 'kinglet-terraform-validation';
const TOPIC = 'kinglet-validation-events-topic';
const CONVERTIBLE = 'kinglet-validation-events-convertible';
const PAYLOAD = 'kinglet-terraform-push-to-pull';

export interface PubsubConversionHooks {
  readonly endpoint: string;
  apply: (delivery: 'push' | 'pull') => Promise<void>;
  plan: (delivery: 'pull') => Promise<void>;
}

export async function runPubsubPushToPullConversion(hooks: PubsubConversionHooks): Promise<void> {
  await hooks.apply('push');

  const publish = await fetch(`${hooks.endpoint}/v1/projects/${PROJECT}/topics/${TOPIC}:publish`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messages: [{ data: Buffer.from(PAYLOAD).toString('base64') }],
    }),
  });

  if (!publish.ok) {
    throw new Error(
      `publish during push-to-pull conversion failed: ${publish.status} ${await publish.text()}`
    );
  }

  await hooks.apply('pull');

  const pull = await fetch(
    `${hooks.endpoint}/v1/projects/${PROJECT}/subscriptions/${CONVERTIBLE}:pull`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ maxMessages: 10 }),
    }
  );

  if (!pull.ok) {
    throw new Error(
      `pull after push-to-pull conversion failed: ${pull.status} ${await pull.text()}`
    );
  }

  const body = (await pull.json()) as {
    receivedMessages?: Array<{ message?: { data?: string } }>;
  };
  const data = body.receivedMessages?.map(message => message.message?.data) ?? [];

  if (!data.includes(Buffer.from(PAYLOAD).toString('base64'))) {
    throw new Error(
      `push-to-pull conversion lost the published message; pulled ${JSON.stringify(body)}`
    );
  }

  await hooks.plan('pull');
}
