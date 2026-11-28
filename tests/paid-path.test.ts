// The paid path end to end against a stand-in facilitator: a real signed payment goes in,
// and we count what the service asks the facilitator to settle. No funds are involved.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const NETWORK = "eip155:8453";
const settled: unknown[] = [];
let facilitator: ReturnType<typeof Bun.serve>;
let app: { fetch(request: Request): Response | Promise<Response> };
const buyer = new x402HTTPClient(new x402Client().register(NETWORK, new ExactEvmScheme(privateKeyToAccount(generatePrivateKey()))));

beforeAll(async () => {
  facilitator = Bun.serve({
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/supported")
        return Response.json({ kinds: [{ x402Version: 2, scheme: "exact", network: NETWORK }], extensions: [], signers: {} });
      if (path === "/verify") return Response.json({ isValid: true, payer: "0x0000000000000000000000000000000000000001" });
      if (path === "/settle") {
        settled.push(await request.json());
        return Response.json({ success: true, transaction: "0xabc", network: NETWORK, payer: "0x0000000000000000000000000000000000000001" });
      }
      return new Response("not found", { status: 404 });
    },
  });
  process.env.PAY_TO = "0xb9a5d2e874A410247C03B71c2b29b6542eb77aBb";
  process.env.FACILITATOR_URL = `http://localhost:${facilitator.port}`;
  app = (await import("../service/app")).default;
});
afterAll(() => facilitator.stop(true));

async function payFor(path: string) {
  const url = `http://warrant.test${path}`;
  const challenge = await app.fetch(new Request(url));
  expect(challenge.status).toBe(402);
  const required = buyer.getPaymentRequiredResponse((name) => challenge.headers.get(name), await challenge.json().catch(() => undefined));
  const payment = await buyer.createPaymentPayload(required);
  return app.fetch(new Request(url, { headers: buyer.encodePaymentSignatureHeader(payment) }));
}

test("a malformed address is answered 400 and not settled", async () => {
  const before = settled.length;
  const response = await payFor("/v1/base/address?address=nope");
  expect(response.status).toBe(400);
  expect(settled.length).toBe(before);
});

test("a malformed badge is answered 400 and not settled", async () => {
  const before = settled.length;
  const response = await payFor("/v1/check?badge=nope");
  expect(response.status).toBe(400);
  expect(settled.length).toBe(before);
});

test("a paid address check returns the report and settles once", async () => {
  const before = settled.length;
  const response = await payFor("/v1/base/address?address=0xb9a5d2e874A410247C03B71c2b29b6542eb77aBb");
  // The report comes from the public Base node; if that is down the service must answer 503 and not settle.
  if (response.status === 503) return expect(settled.length).toBe(before);
  expect(response.status).toBe(200);
  expect(response.headers.get("payment-response")).toBeTruthy();
  expect(await response.json()).toMatchObject({ kind: "wallet", chain: "base" });
  expect(settled.length).toBe(before + 1);
});
