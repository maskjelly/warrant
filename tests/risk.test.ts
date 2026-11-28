import { expect, test } from "bun:test";
import { toFunctionSelector, zeroAddress } from "viem";
import { inspect, type ChainReader } from "../service/risk";

const ADDR = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const IMPL = "0x2Ce6311ddAE708829bc0784C967b7d77D19FD779";
const word = (address: string) => `0x${"0".repeat(24)}${address.slice(2).toLowerCase()}` as const;

function reader(over: Partial<ChainReader>): ChainReader {
  return {
    getCode: async () => "0x",
    getStorageAt: async () => `0x${"0".repeat(64)}`,
    getTransactionCount: async () => 0,
    getBalance: async () => 0n,
    read: async () => undefined,
    ...over,
  };
}

test("a malformed address is refused without touching the chain", async () => {
  const chain = reader({ getCode: async () => { throw new Error("should not be called"); } });
  expect(await inspect("nope", chain)).toEqual({ ok: false, error: "malformed_address" });
});

test("an address with no code is reported as a wallet", async () => {
  const result = await inspect(ADDR, reader({ getTransactionCount: async () => 7 }));
  expect(result).toMatchObject({ ok: true, report: { kind: "wallet", transactionsSent: 7, flags: [] } });
});

test("powers are read from the implementation behind a proxy, not the proxy stub", async () => {
  const logic = `0x6080${toFunctionSelector("function mint(address,uint256)").slice(2)}${toFunctionSelector("function blacklist(address)").slice(2)}`;
  const chain = reader({
    getCode: async (a) => (a === IMPL ? (logic as `0x${string}`) : "0x60806040"),
    getStorageAt: async (_, slot) => (slot.startsWith("0x7050") ? word(IMPL) : `0x${"0".repeat(64)}`),
    read: async (_, sig) => (sig.includes("decimals") ? 6 : sig.includes("totalSupply") ? 5n : sig.includes("owner") ? zeroAddress : undefined),
  });
  const result = await inspect(ADDR, chain);
  expect(result).toMatchObject({
    ok: true,
    report: { kind: "token", proxy: { implementation: IMPL }, flags: ["upgradeable_proxy", "ownership_renounced", "can_mint", "can_blocklist"] },
  });
});

test("a node failure propagates so the caller is not charged for a partial answer", async () => {
  const chain = reader({ getBalance: async () => { throw new Error("timeout"); } });
  await expect(inspect(ADDR, chain)).rejects.toThrow("timeout");
});

test("a factory that embeds token code is not reported as able to mint", async () => {
  const code = `0x6080${toFunctionSelector("function mint(address,uint256)").slice(2)}` as `0x${string}`;
  const result = await inspect(ADDR, reader({ getCode: async () => code }));
  expect(result).toMatchObject({ ok: true, report: { kind: "contract", flags: [] } });
});

test("a beacon proxy is followed to the implementation its beacon names", async () => {
  const BEACON = "0x4200000000000000000000000000000000000006";
  const chain = reader({
    getCode: async () => "0x60806040",
    getStorageAt: async (_, slot) => (slot.startsWith("0xa3f0") ? word(BEACON) : `0x${"0".repeat(64)}`),
    read: async (a, sig) => (a === BEACON && sig.includes("implementation") ? IMPL : undefined),
  });
  expect(await inspect(ADDR, chain)).toMatchObject({ ok: true, report: { proxy: { implementation: IMPL, beacon: BEACON }, flags: ["upgradeable_proxy"] } });
});

test("a token without decimals() still has its powers reported", async () => {
  const code = `0x6080${toFunctionSelector("function pause()").slice(2)}` as `0x${string}`;
  const chain = reader({ getCode: async () => code, read: async (_, sig) => (sig.includes("totalSupply") ? 100n : undefined) });
  expect(await inspect(ADDR, chain)).toMatchObject({ ok: true, report: { kind: "contract", flags: ["can_pause"] } });
});
