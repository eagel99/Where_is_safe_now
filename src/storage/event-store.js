import fs from 'node:fs/promises';
import path from 'node:path';

export class EventStore {
  constructor(dataDir, onError = null) {
    this.dataDir = dataDir;
    this.eventsFile = path.join(dataDir, 'events.jsonl');
    this.deliveriesFile = path.join(dataDir, 'deliveries.jsonl');
    this.snapshotFile = path.join(dataDir, 'snapshot.json');
    this.pendingSnapshot = null;
    this.onError = onError;
    this.writeChain = Promise.resolve();
  }

  async init() {
    await fs.mkdir(this.dataDir, { recursive: true });
  }

  async loadSnapshot() {
    try {
      return JSON.parse(await fs.readFile(this.snapshotFile, 'utf8'));
    } catch {
      return { recent: [], states: [], deliveries: [] };
    }
  }

  appendEvent(event, type = 'alert') {
    return fs.appendFile(this.eventsFile, `${JSON.stringify({ type, at: new Date().toISOString(), event })}\n`);
  }

  appendDelivery(delivery) {
    return fs.appendFile(this.deliveriesFile, `${JSON.stringify(delivery)}\n`);
  }

  saveSnapshot(snapshot) {
    clearTimeout(this.pendingSnapshot);
    this.pendingSnapshot = setTimeout(() => {
      this.writeChain = this.writeChain
        .then(async () => {
          const temporary = `${this.snapshotFile}.tmp`;
          await fs.writeFile(temporary, JSON.stringify(snapshot, null, 2));
          await fs.rename(temporary, this.snapshotFile);
        })
        .catch((error) => this.onError?.(error));
    }, 250);
    this.pendingSnapshot.unref?.();
  }
}
