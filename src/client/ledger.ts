import type { Amount } from "../ap2/types.js";

/**
 * Tracks spend per open payment mandate so the agent can enforce `payment.budget` and
 * `payment.agent_recurrence`. Keyed by the open mandate's root digest.
 * Persist it (DB / KV) for long-lived agents; concurrent payments should reserve before paying.
 */
export interface SpendLedger {
  spent(mandateKey: string, currency: string): Promise<number>;
  occurrences(mandateKey: string): Promise<number>;
  record(mandateKey: string, amount: Amount): Promise<void>;
}

export class InMemorySpendLedger implements SpendLedger {
  private readonly entries = new Map<string, Amount[]>();

  async spent(key: string, currency: string) {
    return (this.entries.get(key) ?? []).filter((a) => a.currency === currency).reduce((s, a) => s + a.amount, 0);
  }

  async occurrences(key: string) {
    return (this.entries.get(key) ?? []).length;
  }

  async record(key: string, amount: Amount) {
    this.entries.set(key, [...(this.entries.get(key) ?? []), amount]);
  }
}
