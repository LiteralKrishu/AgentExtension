class WorkerQueue {
  constructor(concurrency = 2) {
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 3) throw new Error('Worker concurrency must be between one and three.');
    this.concurrency = concurrency; this.active = new Set(); this.waiting = []; this.closed = false;
  }
  acquire(id, signal, start) {
    signal.throwIfAborted();
    if (this.closed) return Promise.reject(new Error('Worker queue is closed.'));
    return new Promise((resolve, reject) => {
      const entry = { id, signal, begin: () => {
        signal.removeEventListener('abort', cancel);
        if (signal.aborted) { reject(signal.reason); return; }
        this.active.add(id);
        try { start(); resolve(); } catch (error) { this.active.delete(id); reject(error); }
      }, reject };
      const cancel = () => {
        this.waiting = this.waiting.filter(item => item !== entry);
        signal.removeEventListener('abort', cancel);
        reject(signal.reason ?? new Error('Queued worker cancelled.'));
      };
      entry.cancel = cancel;
      if (this.active.size < this.concurrency) entry.begin();
      else { this.waiting.push(entry); signal.addEventListener('abort', cancel, { once: true }); if (signal.aborted) cancel(); }
    });
  }
  release(id) {
    this.active.delete(id);
    while (!this.closed && this.active.size < this.concurrency && this.waiting.length) this.waiting.shift().begin();
  }
  close() {
    this.closed = true;
    for (const entry of this.waiting.splice(0)) {
      entry.signal.removeEventListener('abort', entry.cancel);
      entry.reject(new Error('Worker queue is closed.'));
    }
  }
}
module.exports = { WorkerQueue };
