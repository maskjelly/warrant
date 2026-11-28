// The same paid checks as MCP tools, for agents that find tools through MCP rather than HTTP.
// Listing tools is free; a tool call is paid with x402 and settled only when the tool returns a result.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { x402ResourceServer } from "@x402/core/server";
import { createPaymentWrapper } from "@x402/mcp";
import { z } from "zod";

type Answer = { status: number; body: unknown };
export interface McpChecks {
  resourceServer: x402ResourceServer;
  accept: { scheme: string; price: string; network: `${string}:${string}`; payTo: string };
  price: string;
  checkBadge(badge: string, network: string | undefined): Promise<Answer>;
  inspectAddress(address: string): Promise<Answer>;
}

export function createMcpHandler(checks: McpChecks) {
  let ready: Promise<ReturnType<typeof createPaymentWrapper>> | undefined;
  const wrapper = () =>
    (ready ??= (async () => {
      await checks.resourceServer.initialize();
      const accepts = await checks.resourceServer.buildPaymentRequirements(checks.accept);
      return createPaymentWrapper(checks.resourceServer, { accepts });
    })().catch((error) => {
      ready = undefined;
      throw error;
    }));

  // An error result is not settled, so the caller pays only for an answer.
  const reply = ({ status, body }: Answer) => ({
    content: [{ type: "text" as const, text: JSON.stringify(body) }],
    isError: status !== 200,
  });

  return async (request: Request): Promise<Response> => {
    const paid = await wrapper();
    const server = new McpServer({ name: "warrant-checks", version: "0.1.0" });
    server.tool(
      "check_concordium_agent",
      `Is there an accountable human behind this Concordium agent? Returns whether its Verified by Concordium badge is valid and the owner account. Costs ${checks.price} in USDC on Base.`,
      {
        badge: z.string().describe("The agent's CIS-8004 token address in the Concordium Agent Registry."),
        network: z.enum(["mainnet", "testnet"]).optional().describe("Concordium network. Defaults to mainnet."),
      },
      paid(async (args) => reply(await checks.checkBadge(String(args.badge), args.network as string | undefined))),
    );
    server.tool(
      "inspect_base_address",
      `Facts about a Base address before you pay it or buy its token: wallet or contract, upgradeable proxy, owner, and whether it can mint, pause or blocklist. Costs ${checks.price} in USDC on Base.`,
      { address: z.string().describe("A 0x address on Base mainnet: a wallet, a contract or a token.") },
      paid(async (args) => reply(await checks.inspectAddress(String(args.address)))),
    );
    // Stateless: one server and transport per request, so it runs on serverless hosts.
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    return transport.handleRequest(request);
  };
}
