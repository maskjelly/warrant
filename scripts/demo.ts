// Runs every gateway outcome against a live Warrant server on TESTNET.
import { readFileSync } from "node:fs";
import { AccountAddress, buildBasicAccountSigner } from "@concordium/web-sdk";
import { ExactConcordiumScheme } from "@x402/concordium/exact/client";
import { decodePaymentRequiredHeader, encodePaymentSignatureHeader } from "@x402/core/http";

const BASE = process.env.WARRANT_URL ?? "http://localhost:4021";
const OUR_BADGE = process.env.WARRANT_BADGE ?? "JyP9U8ewSjxyopPwq3PKf";
const SOMEONE_ELSES_BADGE = "JyP9U6Tyagy89ZvLUR6Li";
const agent = JSON.parse(readFileSync("keys/accounts.json", "utf8")).agent;
const wallet = new ExactConcordiumScheme({
  accountAddress: AccountAddress.fromBase58(agent.address),
  signer: buildBasicAccountSigner(agent.signKey),
});

async function call(badge?: string, pay = false) {
  const headers: Record<string, string> = badge ? { "warrant-agent": badge } : {};
  let res = await fetch(`${BASE}/v1/report`, { headers });
  if (res.status === 402 && pay) {
    const required = decodePaymentRequiredHeader(res.headers.get("payment-required")!);
    const accepted = required.accepts[0]!;
    const signed = await wallet.createPaymentPayload(2, accepted);
    const payload = { ...signed, accepted, resource: required.resource };
    res = await fetch(`${BASE}/v1/report`, { headers: { ...headers, "payment-signature": encodePaymentSignatureHeader(payload as never) } });
  }
  return { status: res.status, body: (await res.json()) as any };
}

const steps: [string, number, () => Promise<{ status: number; body: any }>, string][] = [
  ["No badge", 401, () => call(), "Anonymous agents are turned away."],
  ["Made-up badge", 403, () => call("JyP9U6Tyagy89ZvLUR6Lx"), "The Agent Registry on Concordium does not know this badge."],
  ["Valid badge, no payment", 402, () => call(OUR_BADGE), "The badge checks out, so the gateway answers with an x402 price."],
  ["Valid badge, paid by its owner", 200, () => call(OUR_BADGE, true), "Payment signed by the account that owns the badge; the gateway sponsors the fee."],
  ["Someone else's valid badge, paid from our account", 403, () => call(SOMEONE_ELSES_BADGE, true), "A copied badge is useless: the payer is not bound to it on chain. Nothing is charged."],
  ["Second paid call", 200, () => call(OUR_BADGE, true), "Same owner, second request."],
  ["Third call inside the owner's limit window", 429, () => call(OUR_BADGE, true), "The limit belongs to the human owner, so more agents would not help."],
];
const pause = Number(process.env.DEMO_PAUSE ?? 0);
console.log(`Warrant demo against ${BASE} (Concordium testnet)\nAgent badge: ${OUR_BADGE}\n`);

let failed = 0;
for (const [name, expected, run, why] of steps) {
  const { status, body } = await run();
  const ok = status === expected;
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}: HTTP ${status} ${body.error ?? ""}`);
  console.log(`      ${why}`);
  if (body.payment) console.log(`      ${body.payment}`);
  if (pause) await new Promise((r) => setTimeout(r, pause));
  if (!ok) console.log("      expected", expected, JSON.stringify(body).slice(0, 400));
}

await new Promise((r) => setTimeout(r, 20_000));
const audit = (await (await fetch(`${BASE}/audit`)).json()) as any;
console.log(`\nAudit log: ${audit.records.length} records, hash chain ${audit.chain.ok ? "intact" : "BROKEN"}, head ${audit.chain.head}`);
for (const a of audit.anchors) console.log(`Anchored through record ${a.seq}: ${a.explorer}`);
process.exit(failed ? 1 : 0);
