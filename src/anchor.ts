import {
  AccountAddress,
  AccountTransactionType,
  DataBlob,
  TransactionExpiry,
  buildBasicAccountSigner,
  signTransaction,
} from "@concordium/web-sdk";
import { ConcordiumGRPCNodeClient, credentials } from "@concordium/web-sdk/nodejs";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Anchor, AuditLog } from "./audit";

const TAG = "warrant/v1";

/** `warrant/v1` + sequence number (u64 BE) + head hash: 50 bytes written as RegisterData. */
export function encodeAnchor(seq: number, head: string): Uint8Array {
  const out = Buffer.alloc(TAG.length + 8 + 32);
  out.write(TAG, 0, "ascii");
  out.writeBigUInt64BE(BigInt(seq), TAG.length);
  Buffer.from(head, "hex").copy(out, TAG.length + 8);
  return out;
}

export function decodeAnchor(data: Uint8Array): { seq: number; head: string } | null {
  const buf = Buffer.from(data);
  if (buf.length !== TAG.length + 40 || buf.subarray(0, TAG.length).toString("ascii") !== TAG) return null;
  return { seq: Number(buf.readBigUInt64BE(TAG.length)), head: buf.subarray(TAG.length + 8).toString("hex") };
}

export interface AnchorerOptions {
  host: string;
  port: number;
  address: string;
  signKey: string;
  file?: string;
}

/** Writes the audit log's head hash on chain, fixing every record up to that point. */
export function createAnchorer(options: AnchorerOptions) {
  const client = new ConcordiumGRPCNodeClient(options.host, options.port, credentials.createSsl());
  const sender = AccountAddress.fromBase58(options.address);
  const signer = buildBasicAccountSigner(options.signKey);
  const anchors: Anchor[] =
    options.file && existsSync(options.file)
      ? readFileSync(options.file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Anchor)
      : [];
  if (options.file) mkdirSync(dirname(options.file), { recursive: true });
  let pending: Promise<Anchor | null> = Promise.resolve(null);

  async function submit(audit: AuditLog): Promise<Anchor | null> {
    const seq = audit.all().length;
    const head = audit.head();
    if (seq === 0 || anchors.at(-1)?.seq === seq) return anchors.at(-1) ?? null;
    const { nonce } = await client.getNextAccountNonce(sender);
    const data = encodeAnchor(seq, head);
    const tx = {
      header: { expiry: TransactionExpiry.futureMinutes(10), nonce, sender },
      type: AccountTransactionType.RegisterData,
      payload: { data: new DataBlob(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer) },
    } as never;
    const hash = await client.sendAccountTransaction(tx, await signTransaction(tx, signer));
    await client.waitForTransactionFinalization(hash);
    const anchor: Anchor = { seq, head, txHash: hash.toString(), at: new Date().toISOString() };
    anchors.push(anchor);
    if (options.file) appendFileSync(options.file, `${JSON.stringify(anchor)}\n`);
    return anchor;
  }

  return {
    /** Serialised so two anchors never race for the same account nonce. */
    anchor(audit: AuditLog): Promise<Anchor | null> {
      pending = pending.catch(() => null).then(() => submit(audit));
      return pending;
    },
    all: (): Anchor[] => [...anchors],
  };
}

export type Anchorer = ReturnType<typeof createAnchorer>;
