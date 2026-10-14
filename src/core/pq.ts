/**
 * Binary min-heap priority queue.
 *
 * Ties are broken by insertion order (FIFO), so search results are
 * deterministic regardless of float noise in equal priorities. Push and pop
 * are O(log n). We use "lazy deletion" in the searches instead of
 * decrease-key: a node may be pushed several times and stale entries are
 * skipped when popped, which keeps the heap simple and is the standard
 * textbook approach for Dijkstra/A*.
 */
export class MinHeap<T> {
  private items: T[] = [];
  private prio: number[] = [];
  private order: number[] = [];
  private counter = 0;

  get size(): number {
    return this.items.length;
  }

  isEmpty(): boolean {
    return this.items.length === 0;
  }

  push(item: T, priority: number): void {
    this.items.push(item);
    this.prio.push(priority);
    this.order.push(this.counter++);
    this.up(this.items.length - 1);
  }

  peekPriority(): number {
    return this.prio.length > 0 ? this.prio[0] : Infinity;
  }

  peek(): T | undefined {
    return this.items[0];
  }

  pop(): T | undefined {
    const n = this.items.length;
    if (n === 0) return undefined;
    const top = this.items[0];
    const last = n - 1;
    if (last > 0) {
      this.items[0] = this.items[last];
      this.prio[0] = this.prio[last];
      this.order[0] = this.order[last];
    }
    this.items.pop();
    this.prio.pop();
    this.order.pop();
    if (last > 0) this.down(0);
    return top;
  }

  /** Snapshot of queued items (unordered), for visualising the frontier. */
  toArray(): T[] {
    return this.items.slice();
  }

  clear(): void {
    this.items.length = 0;
    this.prio.length = 0;
    this.order.length = 0;
  }

  private less(a: number, b: number): boolean {
    const pa = this.prio[a], pb = this.prio[b];
    return pa < pb || (pa === pb && this.order[a] < this.order[b]);
  }

  private swap(a: number, b: number): void {
    [this.items[a], this.items[b]] = [this.items[b], this.items[a]];
    [this.prio[a], this.prio[b]] = [this.prio[b], this.prio[a]];
    [this.order[a], this.order[b]] = [this.order[b], this.order[a]];
  }

  private up(i: number): void {
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!this.less(i, p)) break;
      this.swap(i, p);
      i = p;
    }
  }

  private down(i: number): void {
    const n = this.items.length;
    for (;;) {
      const l = 2 * i + 1, r = l + 1;
      let m = i;
      if (l < n && this.less(l, m)) m = l;
      if (r < n && this.less(r, m)) m = r;
      if (m === i) break;
      this.swap(i, m);
      i = m;
    }
  }
}
