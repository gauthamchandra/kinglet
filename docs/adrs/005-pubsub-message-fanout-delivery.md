# ADR-005: Pub/Sub Message Fan-Out and Delivery Architecture

## Status

Accepted

## Context

Cloud Pub/Sub introduces a fundamentally different data flow compared to the
existing services (Cloud Tasks, Cloud Scheduler). In Tasks and Scheduler, there
is a simple one-to-one relationship: a task dispatches to a single HTTP endpoint,
a job executes on a schedule. Pub/Sub introduces a **fan-out model** where
publishing a single message to a topic must deliver that message independently to
every subscription attached to the topic. Each subscription maintains its own:

- Acknowledgment state (pending, acknowledged)
- Ack deadline (configurable per-subscription, extendable per-message)
- Delivery attempt counter (for dead-letter routing)
- Push or pull delivery mode

This creates new requirements for the storage and delivery layers that don't
exist in the other services.

## Decision

We will use a **two-table storage model** with **eager fan-out at publish time**.

### Storage Model

1. **`pubsub_messages`** — Immutable, topic-scoped. Stores the canonical message
   data (messageId, topicName, data, attributes, orderingKey, publishTime). One
   row per published message. Never mutated after insertion.

2. **`pubsub_delivered_messages`** — Mutable, subscription-scoped. Stores the
   delivery state for each message-subscription pair (ackId, subscriptionName,
   messageId, deliveryAttempt, ackDeadline, ackStatus). One row per subscription
   per message.

### Fan-Out Strategy

When a message is published to a topic:

1. Insert the message into `pubsub_messages`
2. Query all active (non-detached) subscriptions for the topic
3. For each subscription, insert a row into `pubsub_delivered_messages` with
   `ackStatus=PENDING` and `ackDeadline = now + subscription.ackDeadlineSeconds`
4. All inserts happen within a single transaction

### Delivery Engine

A background `DeliveryEngine` (following the `DispatchEngine` pattern from Cloud
Tasks) periodically:

- **Re-delivers expired messages**: Scans for `PENDING` rows where `ackDeadline`
  has passed, resets the deadline, and increments `deliveryAttempt`
- **Pushes to endpoints**: For subscriptions with `pushConfig`, POSTs messages to
  the configured endpoint. Auto-acks on success, retries on failure
- **Routes to dead-letter topics**: When `deliveryAttempt` exceeds
  `deadLetterPolicy.maxDeliveryAttempts`, publishes to the dead-letter topic and
  acks the original
- **Cleans up**: Removes `ACKED` delivered messages and enforces
  `messageRetentionDuration`

## Rationale

### Why eager fan-out (at publish time) instead of lazy (at pull time)

- **Matches real GCP behavior**: In production Pub/Sub, messages are immediately
  available to all subscriptions after publish
- **Simpler pull queries**: Pulling is a straightforward filter on
  `subscriptionName + ackStatus + ackDeadline` — no joins against subscriptions
  or topic membership checks
- **Per-subscription ack tracking**: Each subscription's ack state is independent
  from the start, stored in its own row

### Why two tables instead of one

- **Separation of concerns**: Message content (immutable) is decoupled from
  delivery state (mutable). Multiple subscriptions reference the same message
  without duplicating the payload
- **Efficient pull queries**: The `pubsub_delivered_messages` table is indexed by
  subscription and ack status, so pull queries don't scan the entire message
  table

## Alternatives Considered

### Single table with per-subscription ack columns

Add columns like `sub_A_ack_status`, `sub_B_ack_status` to the messages table.

**Rejected**: Does not scale to dynamic subscription counts. Schema changes
required when subscriptions are created or deleted. Cannot index efficiently for
per-subscription pull queries.

### Lazy fan-out (resolve at pull time)

Store messages only in `pubsub_messages`. At pull time, join against the
subscription's topic to find undelivered messages, tracking acks in a separate
lightweight table.

**Rejected**: Pull queries become complex multi-table joins. Ack deadline
tracking requires knowing which messages have been "seen" by which subscription,
which effectively recreates the delivered_messages table anyway.

### In-memory message queues (no persistence)

Use in-memory arrays or Maps for message delivery, bypassing the storage layer.

**Rejected**: Messages would be lost on restart, violating the hybrid storage
architecture (ADR-003) which supports persistent SQLite mode. The emulator should
behave consistently across storage backends.

## Consequences

### Positive

- Pull and ack operations are simple, single-table queries with good index
  support
- Each subscription's delivery state is fully independent — no cross-subscription
  interference
- The delivery engine can efficiently scan for expired deadlines using the
  `ackDeadline` index
- Dead-letter routing is a natural extension of the delivery attempt counter
- Works consistently across all storage backends (memory, SQLite, hybrid)

### Negative

- **Write amplification on publish**: Publishing one message to a topic with N
  subscriptions creates 1 + N rows. For topics with many subscriptions, this
  increases write volume
- **Cleanup complexity**: Deleting a message from `pubsub_messages` requires
  confirming all corresponding `pubsub_delivered_messages` rows are acked or
  expired
- **Storage growth**: High-throughput topics accumulate rows in both tables until
  the cleanup cycle runs

These trade-offs are acceptable for a local emulator where message volumes are
orders of magnitude lower than production.

## References

- [Google Cloud Pub/Sub Documentation](https://cloud.google.com/pubsub/docs)
- [ADR-003: Hybrid Storage Architecture](003-hybrid-storage-architecture.md)
- [ADR-004: Modular Service Gateway Pattern](004-modular-service-gateway.md)
