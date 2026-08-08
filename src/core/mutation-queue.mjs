function canonicalKey(value) {
  const key = String(value);
  return process.platform === "win32" ? key.toLocaleLowerCase() : key;
}

export class FileMutationQueue {
  constructor() {
    this.entries = new Map();
  }

  async acquire(rawKey) {
    const key = canonicalKey(rawKey);
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { locked: false, waiters: [] };
      this.entries.set(key, entry);
    }

    if (entry.locked) {
      await new Promise((resolve) => entry.waiters.push(resolve));
    } else {
      entry.locked = true;
    }

    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = entry.waiters.shift();
      if (next) {
        next();
        return;
      }
      entry.locked = false;
      if (this.entries.get(key) === entry) this.entries.delete(key);
    };
  }

  async run(key, operation) {
    const release = await this.acquire(key);
    try {
      return await operation();
    } finally {
      release();
    }
  }

  async runMany(keys, operation) {
    const uniqueKeys = [...new Set(keys.map(canonicalKey))].sort();
    const releases = [];
    try {
      for (const key of uniqueKeys) releases.push(await this.acquire(key));
      return await operation();
    } finally {
      for (const release of releases.reverse()) release();
    }
  }

  get activeKeys() {
    return this.entries.size;
  }
}
