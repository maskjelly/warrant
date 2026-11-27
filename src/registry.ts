export type Network = "testnet" | "mainnet";

export interface AgentIdentity {
  tokenAddress: string;
  tokenId: string;
  ownerAccount: string;
  agentWallet: string | null;
  agentUri: string | null;
}

export type BadgeVerdict =
  | { valid: true; agent: AgentIdentity }
  | { valid: false; issues: string[] };

export interface Registry {
  verify(tokenAddress: string): Promise<BadgeVerdict>;
}

export interface RegistryOptions {
  network: Network;
  baseUrl?: string;
  cacheTtlMs?: number;
  fetch?: typeof fetch;
  now?: () => number;
}

const DEFAULT_BASE_URL = "https://agent-registry-mcp.concordium.com";
const TOKEN_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{10,64}$/;

/**
 * Resolves a "Verified by Concordium" badge against the CIS-8004 Agent Registry.
 * A badge is valid only if the agent is Active on chain and its hosted Agent Card
 * hashes to the on-chain anchor.
 */
export function createRegistry(options: RegistryOptions): Registry {
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
  const ttl = options.cacheTtlMs ?? 60_000;
  const doFetch = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const cache = new Map<string, { at: number; verdict: BadgeVerdict }>();

  async function rpc(name: string, args: Record<string, unknown>): Promise<any> {
    const res = await doFetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: { ...args, network: options.network } },
      }),
    });
    if (!res.ok) throw new Error(`registry ${name} failed: HTTP ${res.status}`);
    const body = (await res.json()) as any;
    if (body.error) throw new Error(`registry ${name} failed: ${body.error.message}`);
    return JSON.parse(body.result.content[0].text);
  }

  async function resolve(tokenAddress: string): Promise<BadgeVerdict> {
    const res = await doFetch(
      `${baseUrl}/v1/check-badge/${encodeURIComponent(tokenAddress)}?network=${options.network}`,
    );
    if (!res.ok) return { valid: false, issues: [`registry_http_${res.status}`] };
    const check = (await res.json()) as any;
    if (check.network && check.network !== options.network) return { valid: false, issues: ["wrong_network"] };
    if (check.badge_valid !== true) {
      const issues = Array.isArray(check.issues) && check.issues.length ? check.issues.map((i: any) => (typeof i === "string" ? i : String(i?.message ?? i?.field ?? "badge_invalid"))) : ["badge_invalid"];
      return { valid: false, issues };
    }
    const agent = await rpc("agent_by_token_address", { token_address: tokenAddress });
    if (!agent || agent.status !== "Active") return { valid: false, issues: ["agent_not_active"] };
    return {
      valid: true,
      agent: {
        tokenAddress: agent.token_address,
        tokenId: String(agent.token_id),
        ownerAccount: agent.owner_account,
        agentWallet: agent.agent_wallet ?? null,
        agentUri: agent.agent_uri ?? null,
      },
    };
  }

  return {
    async verify(tokenAddress) {
      if (!TOKEN_ADDRESS.test(tokenAddress)) return { valid: false, issues: ["malformed_badge"] };
      const hit = cache.get(tokenAddress);
      if (hit && now() - hit.at < ttl) return hit.verdict;
      const verdict = await resolve(tokenAddress);
      cache.set(tokenAddress, { at: now(), verdict });
      return verdict;
    },
  };
}
