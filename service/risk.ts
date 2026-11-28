// On-chain facts about a Base address that an agent should know before sending funds to it or buying its token.
// Everything here is read from a public RPC node; nothing is scored or guessed.
import { createPublicClient, getAddress, http, isAddress, parseAbi, toFunctionSelector, zeroAddress, type Hex } from "viem";
import { base } from "viem/chains";

export interface ChainReader {
  getCode(address: Hex): Promise<Hex | undefined>;
  getStorageAt(address: Hex, slot: Hex): Promise<Hex | undefined>;
  getTransactionCount(address: Hex): Promise<number>;
  getBalance(address: Hex): Promise<bigint>;
  /** Resolves to undefined when the contract has no such function or it reverts. */
  read(address: Hex, signature: string): Promise<unknown>;
}

// EIP-1967 slots: keccak256("eip1967.proxy.implementation") - 1 and keccak256("eip1967.proxy.admin") - 1.
const IMPLEMENTATION_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const ADMIN_SLOT = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";
// EIP-1967 beacon slot: keccak256("eip1967.proxy.beacon") - 1. The beacon contract names the implementation.
const BEACON_SLOT = "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50";
// The older ZeppelinOS slots, still used by USDC: keccak256("org.zeppelinos.proxy.implementation") and "...admin".
const LEGACY_IMPLEMENTATION_SLOT = "0x7050c9e0f4ca769c69bd3a8ef740bc37934f8e2c036e5a723fd8ee048ed3f8c3";
const LEGACY_ADMIN_SLOT = "0x10d6a54a4754c8869d6886b5f5d7fbfa5b4522237ea5c60d11bc4e7a1ff9390b";
// EIP-1167 minimal proxy: fixed bytecode with the implementation address embedded.
const MINIMAL_PROXY = /^0x363d3d373d3d3d363d73([0-9a-f]{40})5af43d82803e903d91602b57fd5bf3$/i;

// Functions that let someone other than the holder change balances or block transfers.
const POWERS: Record<string, string[]> = {
  mint: ["function mint(address,uint256)", "function mint(uint256)"],
  pause: ["function pause()"],
  blocklist: ["function blacklist(address)", "function addBlackList(address)", "function blockAddress(address)"],
};

const slotAddress = (word: Hex | undefined): Hex | null => {
  if (!word || /^0x0*$/.test(word)) return null;
  return getAddress(`0x${word.slice(-40)}`);
};

const hasSelector = (code: string, signature: string) => code.includes(toFunctionSelector(signature).slice(2));

export type Inspection =
  | { ok: false; error: "malformed_address" }
  | { ok: true; report: Record<string, unknown> };

export async function inspect(input: string, chain: ChainReader): Promise<Inspection> {
  if (!isAddress(input, { strict: false })) return { ok: false, error: "malformed_address" };
  const address = getAddress(input);
  const [code, nonce, balance] = await Promise.all([
    chain.getCode(address),
    chain.getTransactionCount(address),
    chain.getBalance(address),
  ]);
  const flags: string[] = [];
  const common = { address, chain: "base", ethBalanceWei: balance.toString() };

  if (!code || code === "0x") {
    if (nonce === 0) flags.push("never_sent_a_transaction");
    return { ok: true, report: { ...common, kind: "wallet", transactionsSent: nonce, flags } };
  }
  // EIP-7702: a wallet that has delegated its code to a contract.
  if (code.startsWith("0xef0100")) {
    return {
      ok: true,
      report: { ...common, kind: "delegated_wallet", delegatesTo: getAddress(`0x${code.slice(8, 48)}`), transactionsSent: nonce, flags: ["wallet_runs_delegated_code"] },
    };
  }

  const [implWord, adminWord, legacyImplWord, legacyAdminWord, beaconWord] = await Promise.all(
    [IMPLEMENTATION_SLOT, ADMIN_SLOT, LEGACY_IMPLEMENTATION_SLOT, LEGACY_ADMIN_SLOT, BEACON_SLOT].map((slot) => chain.getStorageAt(address, slot as Hex)),
  );
  const minimal = MINIMAL_PROXY.exec(code);
  const beacon = slotAddress(beaconWord);
  const viaBeacon = beacon ? await chain.read(beacon, "function implementation() view returns (address)") : undefined;
  const implementation =
    slotAddress(implWord) ??
    slotAddress(legacyImplWord) ??
    (typeof viaBeacon === "string" && viaBeacon !== zeroAddress ? getAddress(viaBeacon) : null) ??
    (minimal ? getAddress(`0x${minimal[1]}`) : null);
  const proxyAdmin = slotAddress(adminWord) ?? slotAddress(legacyAdminWord);
  // A proxy forwards to its implementation, so the powers live in that bytecode.
  const logic = implementation ? ((await chain.getCode(implementation)) ?? "0x") : code;
  const [owner, name, symbol, decimals, totalSupply, paused] = await Promise.all(
    ["owner() returns (address)", "name() returns (string)", "symbol() returns (string)", "decimals() returns (uint8)", "totalSupply() returns (uint256)", "paused() returns (bool)"].map(
      (s) => chain.read(address, `function ${s.replace(" returns", " view returns")}`),
    ),
  );
  const isToken = typeof decimals === "number" && typeof totalSupply === "bigint";
  // Only tokens are scanned: a factory embeds its child token's code, selectors included, without being able to mint anything itself.
  const powers = isToken
    ? Object.entries(POWERS)
        .filter(([, signatures]) => signatures.some((s) => hasSelector(logic, s)))
        .map(([power]) => power)
    : [];

  if (implementation) flags.push(minimal ? "minimal_proxy" : "upgradeable_proxy");
  if (typeof owner === "string" && owner !== zeroAddress) flags.push("has_owner");
  if (owner === zeroAddress) flags.push("ownership_renounced");
  for (const p of powers) flags.push(`can_${p}`);
  if (paused === true) flags.push("currently_paused");

  return {
    ok: true,
    report: {
      ...common,
      kind: isToken ? "token" : "contract",
      codeBytes: (code.length - 2) / 2,
      proxy: implementation ? { implementation, admin: proxyAdmin, beacon } : null,
      owner: typeof owner === "string" ? owner : null,
      token: isToken ? { name: name ?? null, symbol: symbol ?? null, decimals, totalSupply: (totalSupply as bigint).toString() } : null,
      flags,
      note: "Flags are facts read from chain, not a verdict. Powers are detected from function selectors in the bytecode and can miss custom names.",
    },
  };
}

export function createBaseReader(rpcUrl = process.env.BASE_RPC_URL ?? "https://mainnet.base.org"): ChainReader {
  const client = createPublicClient({ chain: base, transport: http(rpcUrl, { timeout: 8000, retryCount: 1 }) });
  return {
    getCode: (address) => client.getCode({ address }),
    getStorageAt: (address, slot) => client.getStorageAt({ address, slot }),
    getTransactionCount: (address) => client.getTransactionCount({ address }),
    getBalance: (address) => client.getBalance({ address }),
    async read(address, signature) {
      const abi = parseAbi([signature]);
      const functionName = signature.slice("function ".length, signature.indexOf("("));
      try {
        return await client.readContract({ address, abi, functionName } as never);
      } catch (error) {
        // A revert or missing function is an answer; a transport failure is not.
        if (error instanceof Error && /revert|returned no data|not a contract|decode/i.test(error.message)) return undefined;
        throw error;
      }
    },
  };
}
