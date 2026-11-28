// Before an agent pays an x402 seller: does the endpoint answer with a usable payment demand,
// is it asking for real USDC, and what is the address that would receive the money?
// One unpaid request is sent to the seller; nothing is paid on the caller's behalf.
import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { isIP } from "node:net";
import { inspect, type ChainReader } from "./risk.js";

// Circle's USDC contracts, by CAIP-2 network. A demand for any other asset is flagged, not judged.
const USDC: Record<string, string> = {
  "eip155:8453": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  "eip155:1": "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  "eip155:137": "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
  "eip155:42161": "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
  "eip155:10": "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85",
  "eip155:43114": "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E",
  "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
};
// The same networks under the names x402 v1 used.
const V1_NETWORKS: Record<string, string> = {
  base: "eip155:8453",
  ethereum: "eip155:1",
  polygon: "eip155:137",
  arbitrum: "eip155:42161",
  optimism: "eip155:10",
  avalanche: "eip155:43114",
  solana: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
};

const PRIVATE_V4 = /^(0\.|10\.|127\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|22[4-9]\.|2[3-5]\d\.)/;
const isPrivate = (ip: string) =>
  isIP(ip) === 4 ? PRIVATE_V4.test(ip) : /^(::1?$|f[cd]|fe[89ab]|ff)/i.test(ip) || (/^::ffff:/i.test(ip) && PRIVATE_V4.test(ip.slice(7)));

const DEADLINE_MS = 8000;
// A host may publish several addresses; one dead address is not a dead seller.
const MAX_ADDRESSES = 3;

export interface Probe {
  /** Resolves a hostname to the addresses a request would reach. */
  resolve(host: string): Promise<string[]>;
  /** One unpaid GET to `url`, connecting to `address` and nowhere else; redirects not followed. */
  get(url: string, address: string): Promise<{ status: number; header(name: string): string | null; text(): Promise<string>; close(): void }>;
}

export const liveProbe: Probe = {
  resolve: async (host) => (isIP(host) ? [host] : (await lookup(host, { all: true })).map((a) => a.address)),
  get: (url, address) =>
    new Promise((resolve, reject) => {
      const req = request(
        url,
        {
          method: "GET",
          headers: { accept: "application/json" },
          timeout: DEADLINE_MS,
          // Connect to the address that was checked, so a second DNS answer cannot redirect the request to a private one.
          lookup: (_host, options, callback) => {
            const family = isIP(address);
            if (options.all) (callback as unknown as (e: null, a: { address: string; family: number }[]) => void)(null, [{ address, family }]);
            else callback(null, address, family);
          },
        },
        (res) => {
          const header = (name: string) => {
            const value = res.headers[name.toLowerCase()];
            return Array.isArray(value) ? (value[0] ?? null) : (value ?? null);
          };
          // A payment demand is small; refuse to buffer more.
          const text = () =>
            new Promise<string>((done, fail) => {
              const chunks: Buffer[] = [];
              let size = 0;
              res.on("data", (chunk: Buffer) => {
                chunks.push(chunk);
                size += chunk.length;
                if (size >= 65536) res.destroy();
              });
              res.on("close", () => done(Buffer.concat(chunks).toString("utf8").slice(0, 65536)));
              res.on("error", fail);
              res.resume();
            });
          resolve({ status: res.statusCode ?? 0, header, text, close: () => (clearTimeout(deadline), void req.destroy()) });
        },
      );
      // The socket timeout restarts on every chunk, so a slow stream needs a deadline for the whole exchange.
      const deadline = setTimeout(() => req.destroy(new Error("deadline")), DEADLINE_MS);
      req.on("timeout", () => req.destroy(new Error("timeout")));
      req.on("close", () => clearTimeout(deadline));
      req.on("error", reject);
      req.end();
    }),
};

const MAX_OPTIONS = 10;
type Accept = { scheme?: unknown; network?: unknown; asset?: unknown; payTo?: unknown; amount?: unknown; maxAmountRequired?: unknown };
export type Preflight = { ok: false; error: "malformed_url" | "url_not_allowed" } | { ok: true; report: Record<string, unknown> };

function readDemand(source: string): { x402Version?: unknown; accepts: unknown[] } | null {
  try {
    const parsed = JSON.parse(source);
    if (parsed && typeof parsed === "object" && Array.isArray(parsed.accepts)) return parsed;
  } catch {
    // Not JSON.
  }
  return null;
}

export async function preflight(input: string, probe: Probe, base: ChainReader): Promise<Preflight> {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return { ok: false, error: "malformed_url" };
  }
  if (url.protocol !== "https:" || url.username || url.password) return { ok: false, error: "url_not_allowed" };
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = await probe.resolve(host).catch(() => [] as string[]);
  // Refuse anything that could reach a private network from this server.
  if (addresses.some(isPrivate)) return { ok: false, error: "url_not_allowed" };

  const flags: string[] = [];
  const report = { url: url.href, flags } as Record<string, unknown> & { flags: string[] };
  if (addresses.length === 0) {
    flags.push("host_does_not_resolve");
    return { ok: true, report: { ...report, reachable: false } };
  }
  const started = Date.now();
  let response: Awaited<ReturnType<Probe["get"]>> | undefined;
  for (const address of addresses.slice(0, MAX_ADDRESSES)) {
    try {
      response = await probe.get(url.href, address);
      break;
    } catch {
      // Try the next address.
    }
  }
  if (!response) {
    flags.push("no_response");
    return { ok: true, report: { ...report, reachable: false } };
  }
  try {
    return await readResponse(response, report, started, base);
  } finally {
    // Release the socket whether or not the body was read.
    response.close();
  }
}

async function readResponse(
  response: Awaited<ReturnType<Probe["get"]>>,
  report: Record<string, unknown> & { flags: string[] },
  started: number,
  base: ChainReader,
): Promise<Preflight> {
  const flags = report.flags;
  report.reachable = true;
  report.status = response.status;
  report.responseMs = Date.now() - started;
  if (response.status !== 402) {
    flags.push(response.status >= 500 ? "server_error" : response.status < 300 ? "answers_without_payment" : "no_payment_demand");
    return { ok: true, report };
  }
  // The header is the v2 form and is enough when present; the body is only read for v1 sellers, and a body that fails is unreadable, not an outage.
  const header = response.header("payment-required");
  const demand = (header ? readDemand(Buffer.from(header, "base64").toString("utf8")) : null) ?? readDemand(await response.text().catch(() => ""));
  if (!demand) {
    flags.push("payment_demand_unreadable");
    return { ok: true, report };
  }
  report.x402Version = demand.x402Version ?? null;
  const options = [];
  const accepts = demand.accepts.filter((a): a is Accept => typeof a === "object" && a !== null);
  if (accepts.length < demand.accepts.length) flags.push("malformed_option_skipped");
  // Each Base option costs chain reads, so the list is capped and the cap is reported.
  if (accepts.length > MAX_OPTIONS) flags.push("options_truncated");
  report.optionsTotal = accepts.length;
  for (const accept of accepts.slice(0, MAX_OPTIONS)) {
    const optionFlags: string[] = [];
    const named = String(accept.network ?? "");
    const network = V1_NETWORKS[named] ?? named;
    const asset = String(accept.asset ?? "");
    const payTo = String(accept.payTo ?? "");
    const atomic = String(accept.amount ?? accept.maxAmountRequired ?? "");
    const expected = USDC[network];
    const isUsdc = expected !== undefined && (network.startsWith("eip155:") ? expected.toLowerCase() === asset.toLowerCase() : expected === asset);
    if (!expected) optionFlags.push("network_not_recognised");
    else if (!isUsdc) optionFlags.push("asset_is_not_circle_usdc");
    if (!/^\d+$/.test(atomic)) optionFlags.push("amount_unreadable");
    // USDC has 6 decimals on every network listed above.
    const priceUsd = isUsdc && /^\d+$/.test(atomic) ? Number(atomic) / 1e6 : null;
    if (priceUsd !== null && priceUsd > 1) optionFlags.push("costs_more_than_one_dollar");
    let recipient: Record<string, unknown> | null = null;
    if (network === "eip155:8453") {
      const inspected = await inspect(payTo, base);
      if (!inspected.ok) optionFlags.push("pay_to_malformed");
      else {
        const { kind, transactionsSent, flags: recipientFlags, proxy, owner } = inspected.report as Record<string, unknown>;
        recipient = { kind, transactionsSent, proxy, owner, flags: recipientFlags };
      }
    }
    options.push({ scheme: accept.scheme ?? null, network, asset, isCircleUsdc: isUsdc, amountAtomic: atomic, priceUsd, payTo, recipient, flags: optionFlags });
  }
  if (options.length === 0) flags.push("no_payment_options");
  report.options = options;
  report.note = "Flags are facts from one unpaid request and from chain, not a verdict on the seller. Recipient details are read for Base only.";
  return { ok: true, report };
}
