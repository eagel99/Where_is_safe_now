export class PollingSource {
  constructor({ name, intervalMs, bus, logger, role = 'recovery' }) {
    this.name = name;
    this.intervalMs = intervalMs;
    this.bus = bus;
    this.logger = logger;
    this.role = role;
    this.stopped = true;
    this.timer = null;
    this.inFlight = false;
  }

  start() {
    this.stopped = false;
    this.bus.setSourceStatus(this.name, {
      state: 'polling',
      role: this.role,
      intervalMs: this.intervalMs,
      startedAt: new Date().toISOString(),
    });
    void this.run();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
  }

  schedule() {
    if (this.stopped) return;
    this.timer = setTimeout(() => void this.run(), this.intervalMs);
    this.timer.unref?.();
  }

  async run() {
    if (this.inFlight || this.stopped) return this.schedule();
    this.inFlight = true;
    const started = Date.now();
    try {
      const count = await this.poll();
      this.bus.setSourceStatus(this.name, {
        state: 'polling',
        role: this.role,
        lastSuccessAt: new Date().toISOString(),
        latencyMs: Date.now() - started,
        lastRecordCount: Number(count) || 0,
        lastError: null,
      });
    } catch (error) {
      this.bus.setSourceStatus(this.name, {
        state: 'error',
        role: this.role,
        latencyMs: Date.now() - started,
        lastError: error.message,
      });
      this.logger.error({ source: this.name, err: error.message }, 'Alert source poll failed');
    } finally {
      this.inFlight = false;
      this.schedule();
    }
  }
}
