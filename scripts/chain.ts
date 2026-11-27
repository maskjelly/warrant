// Shared helpers for the TESTNET setup scripts: sign-ready payloads come from the hosted
// Agent Registry MCP, and are signed here with keys that never leave keys/.
import { readFileSync } from "node:fs";
import {
  AccountAddress,
  AccountTransactionType,
  CcdAmount,
  ContractAddress,
  DataBlob,
  Energy,
  Parameter,
  ReceiveName,
  TransactionExpiry,
  buildBasicAccountSigner,
  signTransaction,
} from "@concordium/web-sdk";
import { ConcordiumGRPCNodeClient, credentials } from "@concordium/web-sdk/nodejs";

export const NETWORK = "testnet";
export const EXPLORER = "https://testnet.ccdscan.io";
export const REGISTRY_URL = "https://agent-registry-mcp.concordium.com";
export type Role = "agent" | "merchant" | "sponsor";
export const accounts: Record<Role, { address: string; signKey: string }> = JSON.parse(
  readFileSync("keys/accounts.json", "utf8"),
);
export const client = new ConcordiumGRPCNodeClient("grpc.testnet.concordium.com", 20000, credentials.createSsl());

export async function mcp<T = any>(name: string, args: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${REGISTRY_URL}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: { network: NETWORK, ...args } } }),
  });
  const text = await res.text();
  const body = JSON.parse(text.split("\n").find((l) => l.startsWith("data: "))?.slice(6) ?? text);
  if (body.error || body.result?.isError) throw new Error(`${name}: ${JSON.stringify(body.error ?? body.result.content)}`);
  return body.result.structuredContent ?? JSON.parse(body.result.content[0].text);
}

async function send(role: Role, type: AccountTransactionType, payload: unknown): Promise<string> {
  const sender = AccountAddress.fromBase58(accounts[role].address);
  const { nonce } = await client.getNextAccountNonce(sender);
  const tx = { header: { expiry: TransactionExpiry.futureMinutes(10), nonce, sender }, payload, type } as never;
  const signature = await signTransaction(tx, buildBasicAccountSigner(accounts[role].signKey));
  const hash = await client.sendAccountTransaction(tx, signature);
  const outcome = await client.waitForTransactionFinalization(hash);
  const summary = outcome.summary as any;
  if (summary?.transactionType === "failed") throw new Error(`rejected: ${JSON.stringify(summary.rejectReason)}`);
  return hash.toString();
}

/** Signs and submits a contract call built by an MCP `build_*` tool. */
export function sendBuilt(role: Role, built: any): Promise<string> {
  return send(role, AccountTransactionType.Update, {
    amount: CcdAmount.zero(),
    address: ContractAddress.create(built.contract_address.index, built.contract_address.subindex),
    receiveName: ReceiveName.fromString(built.receive_name),
    message: Parameter.fromHexString(built.parameter_hex),
    maxContractExecutionEnergy: Energy.create(built.suggested_energy ?? 30000),
  });
}

/** Writes up to 256 bytes on chain as a RegisterData transaction. */
export function registerData(role: Role, data: Uint8Array): Promise<string> {
  return send(role, AccountTransactionType.RegisterData, { data: new DataBlob(Buffer.from(data).buffer.slice(0) as ArrayBuffer) });
}
