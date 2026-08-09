function canonicalKey(value) {
  const key = String(value);
  return process.platform === "win32" ? key.toLocaleLowerCase() : key;
}

export class FileMutationQueue {
  constructor() {
    this.entries = new Map();
    this.sharedCount = 0;
    this.exclusiveLocked = false;
    this.workspaceWaiters = [];
  }

  drainWorkspaceWaiters() {
    if (this.exclusiveLocked || this.sharedCount > 0 || this.workspaceWaiters.length === 0) return;
    if (this.workspaceWaiters[0].mode === "exclusive") {
      this.exclusiveLocked = true;
      this.workspaceWaiters.shift().resolve();
      return;
    }
    while (this.workspaceWaiters[0]?.mode === "shared") {
      this.sharedCount += 1;
      this.workspaceWaiters.shift().resolve();
    }
  }

  async acquireWorkspaceShared() {
    if (!this.exclusiveLocked && this.workspaceWaiters.length === 0) {
      this.sharedCount += 1;
    } else {
      await new Promise((resolve) => this.workspaceWaiters.push({ mode: "shared", resolve }));
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.sharedCount -= 1;
      this.drainWorkspaceWaiters();
    };
  }

  async acquireWorkspaceExclusive() {
    if (!this.exclusiveLocked && this.sharedCount === 0 && this.workspaceWaiters.length === 0) {
      this.exclusiveLocked = true;
    } else {
      await new Promise((resolve) => this.workspaceWaiters.push({ mode: "exclusive", resolve }));
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.exclusiveLocked = false;
      this.drainWorkspaceWaiters();
    };
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
    const releaseWorkspace = await this.acquireWorkspaceShared();
    const release = await this.acquire(key);
    try {
      return await operation();
    } finally {
      release();
      releaseWorkspace();
    }
  }

  async runMany(keys, operation) {
    const releaseWorkspace = await this.acquireWorkspaceShared();
    const uniqueKeys = [...new Set(keys.map(canonicalKey))].sort();
    const releases = [];
    try {
      for (const key of uniqueKeys) releases.push(await this.acquire(key));
      return await operation();
    } finally {
      for (const release of releases.reverse()) release();
      releaseWorkspace();
    }
  }

  async runExclusive(operation) {
    const release = await this.acquireWorkspaceExclusive();
    try {
      return await operation();
    } finally {
      release();
    }
  }

  get activeKeys() {
    return this.entries.size;
  }
}
