// A paid API for agents on Base: "is there an accountable human behind this Concordium agent?"
// Payment is x402 in USDC, settled by a public facilitator straight to PAY_TO. No keys live here.
import { serve } from "@hono/node-server";
import { facilitator } from "@payai/facilitator";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { paymentMiddleware, x402ResourceServer } from "@x402/hono";
import { Hono } from "hono";
import { createRegistry } from "../src/registry";

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
    paid: { route: "GET /v1/agent/:badge?network=mainnet|testnet", price, network, protocol: "x402" },
    source: "https://github.com/maskjelly/warrant",
  }),
);

// Hono answers HEAD with the GET handler minus the body; refuse it so nobody pays for an empty reply.
app.use("/v1/agent/*", async (c, next) => {
  if (c.req.raw.method === "HEAD") return c.body(null, 405, { Allow: "GET" });
  await next();
});

app.use(
  paymentMiddleware(
    {
      "GET /v1/agent/*": {
        accepts: [{ scheme: "exact", price, network, payTo }],
        description: "Check a Concordium agent badge: valid or not, and the accountable owner account.",
        mimeType: "application/json",
      },
    },
    new x402ResourceServer(new HTTPFacilitatorClient(facilitator)).register(network, new ExactEvmScheme()),
  ),
);

app.get("/v1/agent/:badge", async (c) => {
  const which = c.req.query("network") === "testnet" ? "testnet" : "mainnet";
  const verdict = await registries[which].verify(c.req.param("badge"));
  // A registry outage is not a verdict. Error responses are not settled, so the caller is not charged.
  const outage = !verdict.valid && verdict.issues.some((i) => /^registry_http_(429|5\d\d)$/.test(i));
  if (outage) return c.json({ error: "registry_unavailable", detail: "No verdict; you were not charged. Retry later." }, 503);
  return c.json(
    verdict.valid
      ? { badge: verdict.agent.tokenAddress, network: which, accountable: true, owner: verdict.agent.ownerAccount, agentWallet: verdict.agent.agentWallet, agentCard: verdict.agent.agentUri }
      : { badge: c.req.param("badge"), network: which, accountable: false, issues: verdict.issues },
  );
});

const port = Number(process.env.PORT ?? 4022);
serve({ fetch: app.fetch, port });
console.log(`Agent check listening on http://localhost:${port} (${network}, ${price} to ${payTo})`);
