// A paid API for agents on Base: "is there an accountable human behind this Concordium agent?"
// Payment is x402 in USDC, settled by a public facilitator straight to PAY_TO. No keys live here.
import { facilitator } from "@payai/facilitator";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { bazaarResourceServerExtension, declareDiscoveryExtension } from "@x402/extensions/bazaar";
import { paymentMiddleware, x402ResourceServer } from "@x402/hono";
import { Hono } from "hono";
import { createRegistry } from "../src/registry.js";

const payTo = process.env.PAY_TO as `0x${string}` | undefined;
if (!payTo) throw new Error("Set PAY_TO to the EVM address that receives USDC.");
const network = (process.env.X402_NETWORK ?? "eip155:8453") as `${string}:${string}`;
const price = process.env.PRICE ?? "$0.005";
const registries = { mainnet: createRegistry({ network: "mainnet" }), testnet: createRegistry({ network: "testnet" }) };

const app = new Hono();

app.get("/", (c) =>
  c.json({
    service: "Warrant agent check",
    what: "Tells you whether a Concordium-registered agent has a valid Verified by Concordium badge and which account answers for it.",
    paid: { route: "GET /v1/check?badge=<token address>&network=mainnet|testnet", price, network, protocol: "x402" },
    openapi: "/openapi.json",
    source: "https://github.com/maskjelly/warrant",
  }),
);

const description = "Check a Concordium agent badge: valid or not, and the accountable owner account.";
const exampleBadge = "JyP9U8ewSjxyopPwq3PKf";
const inputSchema = {
  properties: {
    badge: { type: "string", description: "The agent's CIS-8004 token address in the Concordium Agent Registry." },
    network: { type: "string", enum: ["mainnet", "testnet"], description: "Concordium network. Defaults to mainnet." },
  },
  required: ["badge"],
};
const outputExample = {
  badge: exampleBadge,
  network: "testnet",
  accountable: true,
  owner: "4qo3UoDD8ztpzWed61j7ZYQ3jdMzPA8wH5LiGgZ54eV6yJ8wAp",
  agentWallet: "4qo3UoDD8ztpzWed61j7ZYQ3jdMzPA8wH5LiGgZ54eV6yJ8wAp",
  agentCard: "https://raw.githubusercontent.com/maskjelly/warrant/main/agent/agent-card.json",
};

// Discovery documents for x402 directories. Both are free to read.
app.get("/openapi.json", (c) =>
  c.json({
    openapi: "3.1.0",
    info: {
      title: "Warrant agent check",
      version: "0.1.0",
      description: "Is there an accountable human behind this Concordium agent? Pay per call with x402.",
      contact: { url: "https://github.com/maskjelly/warrant/issues" },
      "x-guidance":
        "Call GET /v1/check?badge=<token address> before trusting or paying a Concordium agent. accountable:true means the badge is valid and owner is the account that answers for the agent. A 503 means no verdict and no charge; retry later.",
    },
    servers: [{ url: new URL(c.req.url).origin }],
    paths: {
      "/v1/check": {
        get: {
          operationId: "checkAgentBadge",
          summary: description,
          parameters: [
            { name: "badge", in: "query", required: true, schema: inputSchema.properties.badge, example: exampleBadge },
            { name: "network", in: "query", required: false, schema: inputSchema.properties.network },
          ],
          "x-payment-info": {
            protocols: [{ x402: {} }],
            price: { mode: "fixed", currency: "USD", amount: price.replace(/^\$/, "") },
          },
          responses: {
            "200": { description: "The verdict.", content: { "application/json": { example: outputExample } } },
            "402": { description: "Payment required. The x402 challenge is in the Payment-Required header." },
            "503": { description: "The Concordium registry gave no answer. Not charged." },
          },
        },
      },
    },
  }),
);
app.get("/favicon.svg", (c) =>
  c.body(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="6" fill="#0b3d2e"/><path d="M8 16l6 6 10-12" fill="none" stroke="#fff" stroke-width="3.5"/></svg>',
    200,
    { "Content-Type": "image/svg+xml", "Cache-Control": "public, max-age=86400" },
  ),
);
app.get("/.well-known/x402", (c) => c.json({ version: 1, resources: [`${new URL(c.req.url).origin}/v1/check`] }));

// Hono answers HEAD with the GET handler minus the body; refuse it so nobody pays for an empty reply.
app.use("/v1/*", async (c, next) => {
  if (c.req.raw.method === "HEAD") return c.body(null, 405, { Allow: "GET" });
  await next();
});

const paid = { accepts: [{ scheme: "exact", price, network, payTo }], description, mimeType: "application/json" };
app.use(
  paymentMiddleware(
    {
      "GET /v1/check": {
        ...paid,
        extensions: declareDiscoveryExtension({
          input: { badge: exampleBadge, network: "testnet" },
          inputSchema,
          output: { example: outputExample },
        }),
      },
      "GET /v1/agent/*": paid,
    },
    new x402ResourceServer(new HTTPFacilitatorClient(facilitator))
      .register(network, new ExactEvmScheme())
      .registerExtension(bazaarResourceServerExtension),
  ),
);

async function check(badge: string, networkParam: string | undefined) {
  const which = networkParam === "testnet" ? "testnet" : "mainnet";
  const verdict = await registries[which].verify(badge);
  // A registry outage is not a verdict. Error responses are not settled, so the caller is not charged.
  const outage = !verdict.valid && verdict.issues.some((i) => /^registry_http_(429|5\d\d)$/.test(i));
  if (outage) return { status: 503 as const, body: { error: "registry_unavailable", detail: "No verdict; you were not charged. Retry later." } };
  return {
    status: 200 as const,
    body: verdict.valid
      ? { badge: verdict.agent.tokenAddress, network: which, accountable: true, owner: verdict.agent.ownerAccount, agentWallet: verdict.agent.agentWallet, agentCard: verdict.agent.agentUri }
      : { badge, network: which, accountable: false, issues: verdict.issues },
  };
}

app.get("/v1/check", async (c) => {
  const badge = c.req.query("badge");
  // Error responses are not settled, so a call without a badge is not charged.
  if (!badge) return c.json({ error: "missing_badge", detail: "Pass ?badge=<token address>. You were not charged." }, 400);
  const r = await check(badge, c.req.query("network"));
  return c.json(r.body, r.status);
});

app.get("/v1/agent/:badge", async (c) => {
  const r = await check(c.req.param("badge"), c.req.query("network"));
  return c.json(r.body, r.status);
});

export default app;
