import { serve } from "@hono/node-server";
import { existsSync, readFileSync } from "node:fs";
import { Hono } from "hono";
import { getConcordiumGrpcUrl, parseGrpcUrl } from "@x402/concordium";
import type { Network as Caip2 } from "@x402/core/types";
import { createAnchorer } from "./anchor";
import { AuditLog } from "./audit";
import { type WarrantEnv, warrant } from "./gateway";
import { createPolicy } from "./policy";
import { createRegistry } from "./registry";
import { createConcordiumSettler } from "./settler";

const CAIP2: Record<string, Caip2> = {
  testnet: "ccd:4221332d34e1694168c2a0c0b3fd0f27",
  mainnet: "ccd:9dd9ca4d19e9393877d2c44b70f89acb",
};
const EXPLORER: Record<string, string> = { testnet: "https://testnet.ccdscan.io", mainnet: "https://ccdscan.io" };

const env = process.env;
const network = env.WARRANT_NETWORK === "mainnet" ? "mainnet" : "testnet";
// The demo keys written by scripts/accounts.ts are a fallback for local testnet runs only.
const demo = existsSync("keys/accounts.json") ? JSON.parse(readFileSync("keys/accounts.json", "utf8")) : {};
const payTo = env.WARRANT_PAY_TO ?? demo.merchant?.address;
const sponsorAddress = env.WARRANT_SPONSOR_ADDRESS ?? demo.sponsor?.address;
const sponsorKey = env.WARRANT_SPONSOR_KEY ?? demo.sponsor?.signKey;
if (!payTo || !sponsorAddress || !sponsorKey) {
  throw new Error("Set WARRANT_PAY_TO, WARRANT_SPONSOR_ADDRESS and WARRANT_SPONSOR_KEY (or run scripts/accounts.ts on testnet).");
}
const anchorEvery = Number(env.WARRANT_ANCHOR_EVERY ?? 5);
const [host, port] = parseGrpcUrl(getConcordiumGrpcUrl(CAIP2[network]!));

const audit = new AuditLog(env.WARRANT_AUDIT_FILE ?? "data/audit.jsonl");
const anchorer = createAnchorer({ host, port, address: sponsorAddress, signKey: sponsorKey, file: "data/anchors.jsonl" });
const txUrl = (hash: string) => `${EXPLORER[network]}/?dcount=1&dentity=transaction&dhash=${hash}`;

const app = new Hono<WarrantEnv>();

app.get("/", (c) =>
  c.json({
    service: "Warrant",
    network,
    paid: "GET /v1/report",
    audit: "GET /audit",
    how: "Send your Verified by Concordium badge in the warrant-agent header, then answer the x402 challenge from the account that owns the badge.",
  }),
);

app.get(
  "/v1/report",
  warrant({
    registry: createRegistry({ network }),
    settler: createConcordiumSettler({
      network: CAIP2[network]!,
      payTo,
      amount: env.WARRANT_PRICE ?? "10000",
      asset: env.WARRANT_ASSET ?? "CCD",
      sponsorAddress,
      sponsorKey,
    }),
    audit,
    policy: createPolicy({ maxPerOwner: Number(env.WARRANT_MAX_PER_OWNER ?? 2), windowMs: Number(env.WARRANT_WINDOW_MS ?? 60_000) }),
    description: "Paid report, served only to accountable agents",
  }),
  async (c) => {
    if (audit.all().length - (anchorer.all().at(-1)?.seq ?? 0) >= anchorEvery) {
      anchorer.anchor(audit).catch((e) => console.error("anchor failed:", e));
    }
    const agent = c.get("agent");
    return c.json({
      report: "This is the resource the API owner sells.",
      servedTo: { badge: agent.tokenAddress, accountableOwner: agent.ownerAccount },
      payment: txUrl(c.get("paymentTx")),
    });
  },
);

app.get("/audit", (c) =>
  c.json({
    chain: audit.verify(),
    anchors: anchorer.all().map((a) => ({ ...a, explorer: txUrl(a.txHash) })),
    records: audit.all(),
  }),
);

const listenPort = Number(env.PORT ?? 4021);
serve({ fetch: app.fetch, port: listenPort });
console.log(`Warrant listening on http://localhost:${listenPort} (${network})`);
