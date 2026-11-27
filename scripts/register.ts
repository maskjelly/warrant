// Mints the demo agent's CIS-8004 identity on TESTNET.
import { writeFileSync } from "node:fs";
import { EXPLORER, accounts, mcp, sendBuilt } from "./chain";

const owner = accounts.agent.address;
const before = await mcp("agents_by_owner", { owner_account: owner });
console.log("before:", JSON.stringify(before).slice(0, 400));
const hash = await sendBuilt("agent", await mcp("build_register", { sender: owner }));
console.log("register tx:", `${EXPLORER}/?dcount=1&dentity=transaction&dhash=${hash}`);
const after = await mcp("agents_by_owner", { owner_account: owner });
console.log("after:", JSON.stringify(after).slice(0, 800));
writeFileSync("keys/agent.json", JSON.stringify({ registerTx: hash, agents: after }, null, 2));
process.exit(0);
