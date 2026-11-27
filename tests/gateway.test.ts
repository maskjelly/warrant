import { expect, test } from "bun:test";
import { Hono } from "hono";
import { decodePaymentRequiredHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import { AuditLog } from "../src/audit";
import { BADGE_HEADER, warrant, type Settler, type WarrantEnv } from "../src/gateway";
import { createPolicy } from "../src/policy";
import type { Registry } from "../src/registry";

const OWNER = "3zDfWxwqRi25bUJ7QvNsoZopC5YbqmG1ynqRAd5SASVrFc1dBy";
const WALLET = "4fuH446nxXxeyjn5Yc4owuiYpLC1fKQEtci28Z9YLozNNFj87X";
const STRANGER = "3kBx2h5Y2veb4hZvAE2c1Zr6DYJwWbPr9xQJJBPWyFnXHF9UuN";
const GOOD = "JyP9U6Tyagy89ZvLUR6Li";
const requirements = {
  scheme: "exact", network: "ccd:4221332d34e1694168c2a0c0b3fd0f27", asset: "CCD", amount: "1000",
  payTo: STRANGER, maxTimeoutSeconds: 60, extra: {},
};

function setup(over: { maxPerOwner?: number; settleOk?: boolean } = {}) {
  const registry: Registry = {
    async verify(badge) {
      return badge === GOOD
        ? { valid: true, agent: { tokenAddress: GOOD, tokenId: "1", ownerAccount: OWNER, agentWallet: WALLET, agentUri: null } }
        : { valid: false, issues: ["on_chain_agent_not_found"] };
    },
  };
  let settled = 0;
  const settler: Settler = {
    requirements: async () => requirements as never,
    verify: async () => ({ ok: true }),
    settle: async () => (over.settleOk === false ? { ok: false, reason: "boom" } : { ok: true, txHash: `tx${++settled}` }),
  };
  const audit = new AuditLog();
  const app = new Hono<WarrantEnv>();
  app.use("/data", warrant({ registry, settler, audit, policy: createPolicy({ maxPerOwner: over.maxPerOwner }) }));
  app.get("/data", (c) => c.json({ ok: true, servedTo: c.get("agent").tokenAddress, tx: c.get("paymentTx") }));
  const pay = (sender: string, claimed = sender) =>
    encodePaymentSignatureHeader({ x402Version: 2, accepted: requirements, payload: { sender: claimed, signedTransaction: { header: { sender } } } } as never);
  const call = (headers: Record<string, string> = {}) => app.request("/data", { headers });
  return { call, pay, audit, settledCount: () => settled };
}

test("no badge is refused and logged", async () => {
  const { call, audit } = setup();
  const res = await call();
  expect(res.status).toBe(401);
  expect(audit.all()[0]).toMatchObject({ decision: "denied", reason: "badge_missing" });
});

test("an unverified agent is turned away before any payment is asked for", async () => {
  const { call, pay, audit, settledCount } = setup();
  const res = await call({ [BADGE_HEADER]: "FakeBadge1234567890", "payment-signature": pay(OWNER) });
  expect(res.status).toBe(403);
  expect((await res.json()).detail).toEqual(["on_chain_agent_not_found"]);
  expect(settledCount()).toBe(0);
  expect(audit.all()[0]).toMatchObject({ decision: "denied", reason: "badge_invalid", owner: null });
});

test("a verified agent without payment gets a standard x402 challenge", async () => {
  const { call } = setup();
  const res = await call({ [BADGE_HEADER]: GOOD });
  expect(res.status).toBe(402);
  const required = decodePaymentRequiredHeader(res.headers.get("PAYMENT-REQUIRED")!);
  expect(required.accepts[0]).toMatchObject({ amount: "1000", asset: "CCD", payTo: STRANGER });
});

test("a verified agent paying from its bound account is served and the payment is recorded", async () => {
  const { call, pay, audit } = setup();
  for (const payer of [OWNER, WALLET]) {
    const res = await call({ [BADGE_HEADER]: GOOD, "payment-signature": pay(payer) });
    expect(res.status).toBe(200);
    expect(res.headers.get("PAYMENT-RESPONSE")).toBeTruthy();
  }
  expect(audit.all().map((r) => [r.decision, r.payer, r.paymentTx])).toEqual([
    ["served", OWNER, "tx1"],
    ["served", WALLET, "tx2"],
  ]);
  expect(audit.verify().ok).toBe(true);
});

test("someone else's badge cannot be borrowed: payer must be bound to it on chain", async () => {
  const { call, pay, settledCount } = setup();
  const res = await call({ [BADGE_HEADER]: GOOD, "payment-signature": pay(STRANGER) });
  expect(res.status).toBe(403);
  expect((await res.json()).error).toBe("payer_not_bound_to_badge");
  expect(settledCount()).toBe(0);
  // Claiming the owner's address next to a transfer signed by someone else changes nothing.
  const forged = await call({ [BADGE_HEADER]: GOOD, "payment-signature": pay(STRANGER, OWNER) });
  expect(forged.status).toBe(403);
  expect(settledCount()).toBe(0);
});

test("limits follow the human owner, and a failed settlement serves nothing", async () => {
  const limited = setup({ maxPerOwner: 1 });
  const headers = { [BADGE_HEADER]: GOOD, "payment-signature": limited.pay(OWNER) };
  expect((await limited.call(headers)).status).toBe(200);
  expect((await limited.call(headers)).status).toBe(429);
  expect(limited.settledCount()).toBe(1);

  const failing = setup({ settleOk: false });
  const res = await failing.call({ [BADGE_HEADER]: GOOD, "payment-signature": failing.pay(OWNER) });
  expect(res.status).toBe(402);
  expect(failing.audit.all()[0]).toMatchObject({ decision: "denied", reason: "settlement_failed", paymentTx: null });
});
