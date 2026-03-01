/**
 * Token Bucket rate limiter for per-queue rate limiting
 */

export interface TokenBucketConfig {
  maxTokens: number; // maxBurstSize
  refillRate: number; // maxDispatchesPerSecond
  maxConcurrent: number; // maxConcurrentDispatches
}

export interface TokenBucketStats {
  tokens: number;
  concurrent: number;
  config: TokenBucketConfig;
}

export class TokenBucket {
  private tokens: number;
  private concurrent: number = 0;
  private config: TokenBucketConfig;

  constructor(config: TokenBucketConfig) {
    this.config = { ...config };
    this.tokens = config.maxTokens;
  }

  /**
   * Try to acquire a token for dispatching.
   * Returns false if no tokens available or concurrent limit reached.
   */
  acquire(): boolean {
    if (this.tokens <= 0 || this.concurrent >= this.config.maxConcurrent) {
      return false;
    }

    this.tokens--;
    this.concurrent++;

    return true;
  }

  /**
   * Release a concurrency slot after dispatch completes.
   */
  release(): void {
    if (this.concurrent > 0) {
      this.concurrent--;
    }
  }

  /**
   * Refill tokens based on refillRate (called once per tick interval).
   * Each call adds refillRate tokens, capped at maxTokens.
   */
  refill(): void {
    this.tokens = Math.min(this.tokens + this.config.refillRate, this.config.maxTokens);
  }

  /**
   * Update bucket configuration.
   */
  updateConfig(config: TokenBucketConfig): void {
    this.config = { ...config };

    // Cap tokens to new maxTokens
    if (this.tokens > this.config.maxTokens) {
      this.tokens = this.config.maxTokens;
    }
  }

  /**
   * Get current bucket stats.
   */
  getStats(): TokenBucketStats {
    return {
      tokens: this.tokens,
      concurrent: this.concurrent,
      config: { ...this.config },
    };
  }
}
