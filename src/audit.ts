import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

export type Decision = "served" | "payment_required" | "denied";

export interface AuditEvent {
  decision: Decision;
  reason: string;
  method: string;
  path: string;
  badge: string | null;
  owner: string | null;
  payer: string | null;
  amount: string | null;
  asset: string | null;
  paymentTx: string | null;
}

export interface AuditRecord extends AuditEvent {
  seq: number;
  at: string;
  prev: string;
  hash: string;
}

export interface Anchor {
  seq: number;
  head: string;
  txHash: string;
  at: string;
}

export const GENESIS = "0".repeat(64);

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`)
    .join(",")}}`;
}

export function hashRecord(record: Omit<AuditRecord, "hash">): string {
  return createHash("sha256").update(canonical(record)).digest("hex");
}

export type ChainCheck = { ok: true; length: number; head: string } | { ok: false; brokenAt: number; why: string };

export function verifyChain(records: AuditRecord[]): ChainCheck {
  let prev = GENESIS;
  for (let i = 0; i < records.length; i++) {
    const { hash, ...rest } = records[i]!;
    if (rest.seq !== i + 1) return { ok: false, brokenAt: i + 1, why: "sequence gap" };
    if (rest.prev !== prev) return { ok: false, brokenAt: rest.seq, why: "previous hash does not match" };
    if (hashRecord(rest) !== hash) return { ok: false, brokenAt: rest.seq, why: "record was altered" };
    prev = hash;
  }
  return { ok: true, length: records.length, head: prev };
}

/**
 * Append-only, hash-chained request log. Each record commits to the one before it,
 * so anchoring the head hash on chain fixes the whole history up to that point.
 */
export class AuditLog {
  private records: AuditRecord[] = [];

  constructor(
    private readonly file?: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    if (file && existsSync(file)) {
      this.records = readFileSync(file, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as AuditRecord);
    } else if (file) {
      mkdirSync(dirname(file), { recursive: true });
    }
  }

  append(event: AuditEvent): AuditRecord {
    const rest = { ...event, seq: this.records.length + 1, at: this.now().toISOString(), prev: this.head() };
    const record: AuditRecord = { ...rest, hash: hashRecord(rest) };
    this.records.push(record);
    if (this.file) appendFileSync(this.file, `${JSON.stringify(record)}\n`);
    return record;
  }

  head(): string {
    return this.records.at(-1)?.hash ?? GENESIS;
  }

  all(): AuditRecord[] {
    return [...this.records];
  }

  verify(): ChainCheck {
    return verifyChain(this.records);
  }
}
