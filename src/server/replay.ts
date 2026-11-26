/**
 * Guards against paying the same checkout twice (and against concurrent settle races).
 * Implement over Redis (`SET key 1 NX EXAT exp`) or a database unique key in production.
 */
export interface ReplayStore {
  /** Atomically mark `id` as used until `exp` (unix seconds). Returns false if already claimed. */
  claim(id: string, exp: number): Promise<boolean>;
  /** Undo a claim after a failed settlement so the buyer can retry. */
  release(id: string): Promise<void>;
}

export class InMemoryReplayStore implements ReplayStore {
  private readonly used = new Map<string, number>();

  constructor(private readonly clock: () => number = () => Math.floor(Date.now() / 1000)) {}

  async claim(id: string, exp: number): Promise<boolean> {
    const now = this.clock();
    for (const [k, e] of this.used) if (e < now) this.used.delete(k);
    if (this.used.has(id)) return false;
    this.used.set(id, exp);
    return true;
  }

  async release(id: string): Promise<void> {
    this.used.delete(id);
  }
}
