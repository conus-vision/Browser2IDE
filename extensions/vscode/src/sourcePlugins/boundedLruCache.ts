export class BoundedLruCache<Key, Value> {
  private readonly entries = new Map<Key, Value>();

  public constructor(private readonly maxEntries: number) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
      throw new Error("LRU cache size must be a positive safe integer");
    }
  }

  public get(key: Key): Value | undefined {
    const value = this.entries.get(key);
    if (value === undefined) return undefined;
    this.entries.delete(key);
    this.entries.set(key, value);
    return value;
  }

  public set(key: Key, value: Value): void {
    this.entries.delete(key);
    this.entries.set(key, value);
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done) return;
      this.entries.delete(oldest.value);
    }
  }
}
