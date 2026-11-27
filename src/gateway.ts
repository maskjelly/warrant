import type { MiddlewareHandler } from "hono";
import {
  decodePaymentSignatureHeader,
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
} from "@x402/core/http";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import type { AuditEvent, AuditLog } from "./audit";
import type { Policy } from "./policy";
import type { AgentIdentity, Registry } from "./registry";

export const BADGE_HEADER = "warrant-agent";

/** Verifies and settles one x402 payment. Backed by the Concordium facilitator in production. */
export interface Settler {
  requirements(): Promise<PaymentRequirements>;
  verify(payload: PaymentPayload, requirements: PaymentRequirements): Promise<{ ok: boolean; reason?: string }>;
  settle(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<{ ok: boolean; txHash?: string; reason?: string }>;
}

export interface WarrantOptions {
  registry: Registry;
  settler: Settler;
  audit: AuditLog;
  policy: Policy;
  description?: string;
}

export type WarrantEnv = { Variables: { agent: AgentIdentity; paymentTx: string } };

/** The account the transfer is signed by. A separately claimed `sender` field is not trusted. */
function payerOf(payload: PaymentPayload): string | null {
  const tx = (payload.payload as { signedTransaction?: { header?: { sender?: unknown } } } | undefined)?.signedTransaction;
  const sender = tx?.header?.sender;
  return typeof sender === "string" ? sender : null;
}

/**
 * Serves a route only to an agent that (1) carries a valid Verified by Concordium badge,
 * (2) pays from an account the badge's owner controls, and (3) is inside the owner's limits.
 * Every outcome, served or refused, is written to the audit log.
 */
export function warrant(options: WarrantOptions): MiddlewareHandler<WarrantEnv> {
  const { registry, settler, audit, policy } = options;

  return async (c, next) => {
    const url = new URL(c.req.url);
    const base: AuditEvent = {
      decision: "denied",
      reason: "",
      method: c.req.method,
      path: url.pathname,
      badge: null,
      owner: null,
      payer: null,
      amount: null,
      asset: null,
      paymentTx: null,
    };
    const refuse = (status: 401 | 402 | 403 | 429 | 502, reason: string, extra: Partial<AuditEvent> = {}, detail?: unknown) => {
      const record = audit.append({ ...base, ...extra, reason });
      return c.json({ error: reason, detail, audit: { seq: record.seq, hash: record.hash } }, status);
    };

    const badge = c.req.header(BADGE_HEADER)?.trim();
    if (!badge) return refuse(401, "badge_missing", {}, `Send your Verified by Concordium badge in the ${BADGE_HEADER} header.`);
    base.badge = badge;

    let verdict;
    try {
      verdict = await registry.verify(badge);
    } catch {
      return refuse(502, "registry_unavailable");
    }
    if (!verdict.valid) return refuse(403, "badge_invalid", {}, verdict.issues);
    const agent = verdict.agent;
    base.owner = agent.ownerAccount;

    const allowed = policy.check(agent.ownerAccount);
    if (!allowed.allowed) return refuse(allowed.reason === "owner_blocked" ? 403 : 429, allowed.reason);

    const requirements = await settler.requirements();
    base.amount = requirements.amount;
    base.asset = requirements.asset;

    const signature = c.req.header("payment-signature");
    if (!signature) {
      const record = audit.append({ ...base, decision: "payment_required", reason: "payment_required" });
      const required = {
        x402Version: 2,
        error: "payment_required",
        resource: { url: c.req.url, description: options.description ?? "", mimeType: "application/json" },
        accepts: [requirements],
      };
      c.header("PAYMENT-REQUIRED", encodePaymentRequiredHeader(required as never));
      return c.json({ ...required, audit: { seq: record.seq, hash: record.hash } }, 402);
    }

    let payload: PaymentPayload;
    try {
      payload = decodePaymentSignatureHeader(signature);
    } catch {
      return refuse(402, "payment_malformed");
    }
    const payer = payerOf(payload);
    base.payer = payer;
    // The payment is the proof of control: only an account bound to the badge on chain may pay for it.
    if (!payer || (payer !== agent.ownerAccount && payer !== agent.agentWallet)) {
      return refuse(403, "payer_not_bound_to_badge", {}, "Pay from the badge owner's account or the agent wallet registered on chain.");
    }

    const verified = await settler.verify(payload, requirements);
    if (!verified.ok) return refuse(402, "payment_invalid", {}, verified.reason);
    const settled = await settler.settle(payload, requirements);
    if (!settled.ok || !settled.txHash) return refuse(402, "settlement_failed", {}, settled.reason);

    policy.record(agent.ownerAccount);
    const record = audit.append({ ...base, decision: "served", reason: "paid", paymentTx: settled.txHash });
    c.set("agent", agent);
    c.set("paymentTx", settled.txHash);
    c.header(
      "PAYMENT-RESPONSE",
      encodePaymentResponseHeader({ success: true, transaction: settled.txHash, network: requirements.network, payer } as never),
    );
    c.header("Warrant-Audit", `${record.seq}:${record.hash}`);
    await next();
  };
}
