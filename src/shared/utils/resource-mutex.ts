/**
 * Serializes work that targets the same resource, so two requests can never
 * interleave halfway through each other's multi-step mutation.
 *
 * <p>Reach for this when a mutation is only correct as a whole: it reads a
 * resource, decides something from what it read, and then writes — and a
 * concurrent mutation landing between the read and the write would invalidate
 * the decision. An instance create that persists its row and then mints a
 * completed Operation, and a placement check that lists a cluster's instances
 * before adding another, are both that shape.
 *
 * <p><b>IMPORTANT:</b> mutual exclusion only holds between callers sharing one
 * instance of this class, and only when they key on the same name. Callers that
 * guard a cluster-wide invariant must key on the cluster's name, not the child
 * resource's — a second mutex, or a caller keying on the wrong name, silently
 * buys no exclusion at all.
 *
 * <p><b>NOTE:</b> operations must not nest. A locked operation that awaits
 * another operation on the same key deadlocks, since the inner call waits on a
 * queue the outer call is still holding.
 */
export class ResourceMutex {
  // Tail of the queue per key. Absent means nothing is in flight for it.
  private tailByKey = new Map<string, Promise<unknown>>();

  /**
   * Run {@code operation} once every operation already queued for
   * {@code key} has settled.
   *
   * <p>The next in line is released by its predecessor's completion whether
   * that predecessor resolved or rejected — one caller's failure is its own
   * caller's problem, not a reason to wedge the resource. The key is forgotten
   * once its queue drains, so the map tracks in-flight work rather than every
   * resource name the emulator has ever seen.
   */
  async runExclusively<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.tailByKey.get(key) ?? Promise.resolve();
    const current = previous.then(operation, operation);

    this.tailByKey.set(key, current);

    try {
      return await current;
    } finally {
      if (this.tailByKey.get(key) === current) {
        this.tailByKey.delete(key);
      }
    }
  }

  /**
   * Number of keys with work still queued.
   *
   * <p>For future maintainers: this exists so tests can prove the map does not
   * grow without bound. It is not part of the locking contract.
   */
  trackedKeyCount(): number {
    return this.tailByKey.size;
  }
}
