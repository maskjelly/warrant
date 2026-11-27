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

const steps: [string, number, () => Promise<{ status: number; body: any }>][] = [
  ["No badge", 401, () => call()],
  ["Made-up badge", 403, () => call("JyP9U6Tyagy89ZvLUR6Lx")],
  ["Valid badge, no payment", 402, () => call(OUR_BADGE)],
  ["Valid badge, paid by its owner", 200, () => call(OUR_BADGE, true)],
  ["Someone else's valid badge, paid from our account", 403, () => call(SOMEONE_ELSES_BADGE, true)],
  ["Second paid call", 200, () => call(OUR_BADGE, true)],
  ["Third call inside the owner's limit window", 429, () => call(OUR_BADGE, true)],
];

let failed = 0;
for (const [name, expected, run] of steps) {
  const { status, body } = await run();
  const ok = status === expected;
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}: HTTP ${status} ${body.error ?? ""} ${body.payment ?? ""}`);
  if (!ok) console.log("      expected", expected, JSON.stringify(body).slice(0, 400));
}

await new Promise((r) => setTimeout(r, 20_000));
const audit = (await (await fetch(`${BASE}/audit`)).json()) as any;
console.log(`\nAudit chain: ${JSON.stringify(audit.chain)}`);
for (const a of audit.anchors) console.log(`Anchored through record ${a.seq}: ${a.explorer}`);
process.exit(failed ? 1 : 0);
