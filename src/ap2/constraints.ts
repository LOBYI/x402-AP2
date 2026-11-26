import type {
  Checkout,
  CheckoutConstraint,
  LineItemRequirement,
  Merchant,
  PaymentConstraint,
  PaymentMandate,
} from "./types.js";

/**
 * Merchant matching: ids must be equal, and when the constraint pins a website
 * the candidate's website must match too (prevents a server reusing a trusted merchant id).
 */
export function merchantMatches(allowed: Merchant, candidate: Merchant): boolean {
  if (allowed.id !== candidate.id) return false;
  if (allowed.website && normalizeSite(allowed.website) !== normalizeSite(candidate.website)) return false;
  return true;
}

function normalizeSite(url?: string): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

/** Bipartite matching (Kuhn's algorithm): every requirement and every line item must be paired. */
function matchLineItems(reqs: LineItemRequirement[], checkout: Checkout): boolean {
  const items = checkout.line_items;
  if (items.length !== reqs.length) return false;
  const fits = (r: LineItemRequirement, i: number) =>
    items[i]!.quantity === r.quantity && r.acceptable_items.some((a) => a.id === items[i]!.id);
  const owner: (number | undefined)[] = new Array(items.length).fill(undefined);
  const tryAssign = (r: number, seen: boolean[]): boolean => {
    for (let i = 0; i < items.length; i++) {
      if (seen[i] || !fits(reqs[r]!, i)) continue;
      seen[i] = true;
      if (owner[i] === undefined || tryAssign(owner[i]!, seen)) {
        owner[i] = r;
        return true;
      }
    }
    return false;
  };
  return reqs.every((_, r) => tryAssign(r, new Array(items.length).fill(false)));
}

/** Evaluate open checkout mandate constraints against a merchant-signed checkout. Returns violations. */
export function evaluateCheckoutConstraints(constraints: CheckoutConstraint[], checkout: Checkout): string[] {
  const v: string[] = [];
  for (const c of constraints) {
    switch (c.type) {
      case "checkout.allowed_merchants":
        if (!c.allowed.some((m) => merchantMatches(m, checkout.merchant))) {
          v.push(`checkout.allowed_merchants: merchant ${checkout.merchant.id} not allowed`);
        }
        break;
      case "checkout.line_items":
        if (!matchLineItems(c.items, checkout)) v.push("checkout.line_items: cart does not satisfy line item requirements");
        break;
      default:
        v.push(`unknown checkout constraint ${(c as { type: string }).type}`);
    }
  }
  return v;
}

export interface PaymentConstraintContext {
  now?: number;
  /** Root digest of the open checkout mandate the paired closed checkout was derived from. */
  openCheckoutDigest?: string;
  /** Amount already spent under this open payment mandate (same currency, minor units). Needed for `payment.budget`. */
  spent?: number;
  /** Number of prior uses of this open payment mandate. Needed for `payment.agent_recurrence`. */
  occurrences?: number;
}

/**
 * Evaluate open payment mandate constraints against a closed payment mandate. Returns violations.
 * `payment.budget` / `payment.agent_recurrence` are only enforced when the caller supplies
 * `spent` / `occurrences` (the party holding the spend ledger — normally the agent or credentials provider).
 */
export function evaluatePaymentConstraints(
  constraints: PaymentConstraint[],
  pm: PaymentMandate,
  ctx: PaymentConstraintContext = {},
): string[] {
  const v: string[] = [];
  const amt = pm.payment_amount;
  for (const c of constraints) {
    switch (c.type) {
      case "payment.amount_range":
        if (c.currency !== amt.currency) v.push(`payment.amount_range: currency ${amt.currency} != ${c.currency}`);
        else if (amt.amount > c.max) v.push(`payment.amount_range: ${amt.amount} > max ${c.max}`);
        else if (c.min !== undefined && amt.amount < c.min) v.push(`payment.amount_range: ${amt.amount} < min ${c.min}`);
        break;
      case "payment.allowed_payees":
        if (!c.allowed.some((m) => merchantMatches(m, pm.payee))) v.push(`payment.allowed_payees: payee ${pm.payee.id} not allowed`);
        break;
      case "payment.reference":
        if (c.conditional_transaction_id !== pm.transaction_id && c.conditional_transaction_id !== ctx.openCheckoutDigest) {
          v.push("payment.reference: payment is not bound to the referenced checkout");
        }
        break;
      case "payment.allowed_payment_instruments":
        if (!c.allowed.some((i) => i.id === pm.payment_instrument.id && i.type === pm.payment_instrument.type)) {
          v.push(`payment.allowed_payment_instruments: ${pm.payment_instrument.id} not allowed`);
        }
        break;
      case "payment.allowed_pisps": {
        const p = pm.pisp;
        const ok =
          !!p &&
          c.allowed.some(
            (a) =>
              (a.domain_name === undefined || a.domain_name === p.domain_name) &&
              (a.legal_name === undefined || a.legal_name === p.legal_name) &&
              (a.brand_name === undefined || a.brand_name === p.brand_name),
          );
        if (!ok) v.push("payment.allowed_pisps: PISP not allowed");
        break;
      }
      case "payment.budget":
        if (c.currency !== amt.currency) v.push(`payment.budget: currency ${amt.currency} != ${c.currency}`);
        else if (ctx.spent !== undefined && ctx.spent + amt.amount > c.max) {
          v.push(`payment.budget: ${ctx.spent} + ${amt.amount} exceeds budget ${c.max}`);
        }
        break;
      case "payment.agent_recurrence":
        if (c.max_occurrences !== undefined && ctx.occurrences !== undefined && ctx.occurrences >= c.max_occurrences) {
          v.push(`payment.agent_recurrence: max_occurrences ${c.max_occurrences} reached`);
        }
        break;
      case "payment.execution_date": {
        const now = (ctx.now ?? Math.floor(Date.now() / 1000)) * 1000;
        if (c.not_before && now < Date.parse(c.not_before)) v.push("payment.execution_date: before not_before");
        if (c.not_after && now > Date.parse(c.not_after)) v.push("payment.execution_date: after not_after");
        break;
      }
      default:
        v.push(`unknown payment constraint ${(c as { type: string }).type}`);
    }
  }
  return v;
}
