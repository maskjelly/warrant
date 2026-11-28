import { expect, test } from "bun:test";
import { preflight, type Probe } from "../service/preflight";
import type { ChainReader } from "../service/risk";

const wallet: ChainReader = {
  getCode: async () => "0x",
  getStorageAt: async () => `0x${"0".repeat(64)}`,
  getTransactionCount: async () => 3,
  getBalance: async () => 0n,
  read: async () => undefined,
};
const PAY_TO = "0xb9a5d2e874A410247C03B71c2b29b6542eb77aBb";
const demand = (accept: Record<string, unknown>) => ({ x402Version: 2, accepts: [{ scheme: "exact", network: "eip155:8453", payTo: PAY_TO, amount: "5000", ...accept }] });

function probe(answer: { status: number; header?: string; body?: string } | Error, addresses = ["93.184.216.34"]): Probe & { calls: number; closed: number } {
  const p = {
    calls: 0,
    closed: 0,
    resolve: async () => addresses,
    get: async (..._args: string[]) => {
      p.calls++;
      if (answer instanceof Error) throw answer;
      return {
        close: () => void p.closed++,
        status: answer.status,
        header: () => answer.header ?? null,
        text: async () => {
          if (answer.body === undefined) throw new Error("body stalled");
          return answer.body;
        },
      };
    },
  };
  return p;
}
const header = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64");

test("non-https, credentialed and private-network URLs are refused without a request", async () => {
  for (const [url, addresses] of [
    ["http://example.com/x", ["93.184.216.34"]],
    ["https://user:pw@example.com/x", ["93.184.216.34"]],
    ["https://internal.example/x", ["10.0.0.5"]],
    ["https://metadata.example/x", ["169.254.169.254"]],
    ["https://v6.example/x", ["::1"]],
    ["https://mapped.example/x", ["::ffff:127.0.0.1"]],
  ] as const) {
    const p = probe({ status: 402 }, [...addresses]);
    expect(await preflight(url, p, wallet)).toEqual({ ok: false, error: "url_not_allowed" });
    expect(p.calls).toBe(0);
  }
  expect(await preflight("not a url", probe({ status: 402 }), wallet)).toEqual({ ok: false, error: "malformed_url" });
});

test("a demand for real USDC on Base is priced and its recipient inspected", async () => {
  const p = probe({ status: 402, header: header(demand({ asset: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" })) });
  const result = await preflight("https://seller.example/paid", p, wallet);
  expect(result).toMatchObject({
    ok: true,
    report: { reachable: true, status: 402, flags: [], options: [{ isCircleUsdc: true, priceUsd: 0.005, recipient: { kind: "wallet", transactionsSent: 3 }, flags: [] }] },
  });
});

test("a look-alike asset is flagged and given no dollar price", async () => {
  const p = probe({ status: 402, body: JSON.stringify(demand({ asset: "0x0000000000000000000000000000000000000bad" })) });
  const result = await preflight("https://seller.example/paid", p, wallet);
  expect(result).toMatchObject({ ok: true, report: { options: [{ isCircleUsdc: false, priceUsd: null, flags: ["asset_is_not_circle_usdc"] }] } });
});

test("a v1 demand with a named network and maxAmountRequired is understood", async () => {
  const body = JSON.stringify({ x402Version: 1, accepts: [{ scheme: "exact", network: "base", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", payTo: PAY_TO, maxAmountRequired: "2500000" }] });
  const result = await preflight("https://seller.example/paid", probe({ status: 402, body }), wallet);
  expect(result).toMatchObject({ ok: true, report: { options: [{ network: "eip155:8453", priceUsd: 2.5, flags: ["costs_more_than_one_dollar"] }] } });
});

test("dead, erroring and free endpoints are answers, each with its own flag", async () => {
  const flagsOf = async (p: Probe) => ((await preflight("https://seller.example/paid", p, wallet)) as unknown as { report: { flags: string[] } }).report.flags;
  expect(await flagsOf(probe(new Error("timeout")))).toEqual(["no_response"]);
  expect(await flagsOf(probe({ status: 402 }))).toEqual(["payment_demand_unreadable"]);
  expect(await flagsOf(probe({ status: 402 }, []))).toEqual(["host_does_not_resolve"]);
  expect(await flagsOf(probe({ status: 500 }))).toEqual(["server_error"]);
  expect(await flagsOf(probe({ status: 200 }))).toEqual(["answers_without_payment"]);
  expect(await flagsOf(probe({ status: 404 }))).toEqual(["no_payment_demand"]);
  expect(await flagsOf(probe({ status: 402, body: "<html>" }))).toEqual(["payment_demand_unreadable"]);
});

test("a valid header is used even when the body fails, and the request goes to the checked address", async () => {
  const p = probe({ status: 402, header: header(demand({ asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" })) });
  let connectedTo = "";
  const get = p.get;
  p.get = async (url: string, address: string) => ((connectedTo = address), get(url, address));
  expect(await preflight("https://seller.example/paid", p, wallet)).toMatchObject({ ok: true, report: { options: [{ priceUsd: 0.005 }] } });
  expect(connectedTo).toBe("93.184.216.34");
});

test("a malformed option is skipped and a long list is capped, both with a flag", async () => {
  const good = demand({ asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" }).accepts[0];
  const body = JSON.stringify({ x402Version: 2, accepts: [null, ...Array(12).fill(good)] });
  const result = await preflight("https://seller.example/paid", probe({ status: 402, body }), wallet);
  expect(result).toMatchObject({ ok: true, report: { optionsTotal: 12, flags: ["malformed_option_skipped", "options_truncated"] } });
  expect((result as unknown as { report: { options: unknown[] } }).report.options).toHaveLength(10);
});

test("a dead first address is not a dead seller, and the response is always released", async () => {
  const p = probe({ status: 402, header: header(demand({ asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" })) }, ["93.184.216.34", "93.184.216.35"]);
  const get = p.get;
  p.get = async (url: string, address: string) => {
    if (address === "93.184.216.34") throw new Error("connection refused");
    return get(url, address);
  };
  expect(await preflight("https://seller.example/paid", p, wallet)).toMatchObject({ ok: true, report: { reachable: true, flags: [] } });
  expect(p.closed).toBe(1);
});
