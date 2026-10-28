export class WorkQueue {
  constructor() {
    this.items = [];
    this.running = false;
    this.waiters = [];
  }

  /** @param {() => Promise<unknown>} operation @param {number} [priority] @returns {Promise<unknown>} */
  enqueue(operation, priority = 0) {
    const result = new Promise((resolve, reject) => {
      this.items.push({ operation, priority, resolve, reject });
      this.items.sort((a, b) => b.priority - a.priority);
    });
    void this.drain();
    return result;
  }

  /** @returns {Promise<void>} */
  async drain() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.items.length) {
        const item = this.items.shift();
        try {
          item.resolve(await item.operation());
        } catch (error) {
          item.reject(error);
        }
      }
    } finally {
      this.running = false;
      for (const resolve of this.waiters.splice(0)) resolve();
    }
  }

  /** @returns {Promise<void>} */
  idle() {
    if (!this.running && !this.items.length) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push(resolve));
  }
}
