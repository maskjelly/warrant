import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditLog, GENESIS, verifyChain, type AuditEvent } from "../src/audit";

const event = (over: Partial<AuditEvent> = {}): AuditEvent => ({
  decision: "served", reason: "paid", method: "GET", path: "/x", badge: "b", owner: "o",
  payer: "o", amount: "1", asset: "CCD", paymentTx: "tx", ...over,
});

test("records chain from genesis and verify", () => {
  const log = new AuditLog();
  const a = log.append(event());
  const b = log.append(event({ path: "/y" }));
  expect(a.prev).toBe(GENESIS);
  expect(b.prev).toBe(a.hash);
  expect(log.verify()).toEqual({ ok: true, length: 2, head: b.hash });
});

test("editing, deleting or reordering a record is detected", () => {
  const log = new AuditLog();
  for (let i = 0; i < 4; i++) log.append(event({ path: `/${i}` }));
  const edited = log.all();
  edited[1] = { ...edited[1]!, amount: "999" };
  expect(verifyChain(edited)).toMatchObject({ ok: false, brokenAt: 2, why: "record was altered" });
  const deleted = log.all();
  deleted.splice(1, 1);
  expect(verifyChain(deleted)).toMatchObject({ ok: false, brokenAt: 2 });
  const swapped = log.all();
  [swapped[2], swapped[3]] = [swapped[3]!, swapped[2]!];
  expect(verifyChain(swapped).ok).toBe(false);
});

test("log survives a restart and keeps chaining", () => {
  const file = join(mkdtempSync(join(tmpdir(), "warrant-")), "audit.jsonl");
  const first = new AuditLog(file);
  const a = first.append(event());
  const second = new AuditLog(file);
  const b = second.append(event());
  expect(b.prev).toBe(a.hash);
  expect(new AuditLog(file).verify()).toMatchObject({ ok: true, length: 2 });
});
