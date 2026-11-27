// Builds the demo agent's Agent Card, then pins its URL and SHA-256 on chain (TESTNET).
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { EXPLORER, accounts, mcp, sendBuilt } from "./chain";

const CARD_URL = "https://raw.githubusercontent.com/maskjelly/warrant/main/agent/agent-card.json";
const owner = accounts.agent.address;
const tokenId = JSON.parse(readFileSync("keys/agent.json", "utf8")).agents.agents[0].token_id;

const built = await mcp("build_agent_card", {
  name: "Warrant demo agent",
  description:
    "Reference buyer agent for Warrant. It carries a Verified by Concordium badge and pays per request over x402 from the account that owns the badge.",
  agent_uri: CARD_URL,
  owner_account: owner,
  token_id: tokenId,
  skills: [
    {
      id: "paid-api-call",
      name: "Paid API call",
      description: "Calls a Warrant-protected API: presents its badge, answers the x402 challenge, and returns the result.",
      tags: ["x402", "payments"],
    },
  ],
  provider: { organization: "Warrant", url: "https://github.com/maskjelly/warrant" },
  documentation_url: "https://github.com/maskjelly/warrant",
});

const json: string = built.agent_card_json;
const hash = createHash("sha256").update(json).digest("hex");
console.log("sha256 ours/theirs:", hash, built.metadata_hash_hex, built.token_address);
writeFileSync("agent/agent-card.json", json);
if (process.argv.includes("--pin")) {
  const tx = await sendBuilt("agent", await mcp("build_set_agent_uri", { token_id: tokenId, agent_uri: CARD_URL, metadata_hash_hex: hash, sender: owner }));
  console.log("setAgentURI tx:", `${EXPLORER}/?dcount=1&dentity=transaction&dhash=${tx}`);
}
process.exit(0);
