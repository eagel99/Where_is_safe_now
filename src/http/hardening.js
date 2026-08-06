// HTTP protections carried over from the v1 server. Express with helmet gives
// us headers, but neither rate limiting nor a bound on concurrent SSE streams,
// and both endpoints here are unauthenticated and long-lived.

/**
 * X-Forwarded-For is a request header any client can set, so it is only
 * trustworthy when a reverse proxy we control overwrites it. Reading it
 * unconditionally lets anyone rotate the header to bypass the rate limit and
 * grow the bookkeeping map without bound.
 */
export function clientIp(req, trustProxy) {
  if (trustProxy) {
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded.trim()) return forwarded.split(',')[0].trim();
  }
  return req.socket?.remoteAddress;
}

export class RateLimiter {
  constructor({ windowMs, max }) {
    this.windowMs = windowMs;
    this.max = max;
    this.hits = new Map(); // ip → { count, resetTime }
    this.sweeper = setInterval(() => this.sweep(), windowMs);
    this.sweeper.unref?.();
  }

  isLimited(ip) {
    const now = Date.now();
    let entry = this.hits.get(ip);
    if (!entry || now > entry.resetTime) {
      entry = { count: 0, resetTime: now + this.windowMs };
      this.hits.set(ip, entry);
    }
    entry.count += 1;
    return entry.count > this.max;
  }

  sweep() {
    const now = Date.now();
    for (const [ip, entry] of this.hits) {
      if (now > entry.resetTime) this.hits.delete(ip);
    }
  }

  reset() {
    this.hits.clear();
  }

  stop() {
    clearInterval(this.sweeper);
  }
}

/** Bounds concurrent event-stream connections so they cannot exhaust memory. */
export class SseRegistry {
  constructor(max) {
    this.max = max;
    this.open = 0;
  }

  acquire() {
    if (this.open >= this.max) return false;
    this.open += 1;
    return true;
  }

  release() {
    if (this.open > 0) this.open -= 1;
  }
}
