# Warrant

A gateway that API owners put in front of a paid endpoint so it only serves AI agents with an accountable human behind them.

An agent is served when all three hold:

1. It presents a valid **Verified by Concordium** badge (CIS-8004 Agent Registry: active on chain, card hash matches).
2. It pays for the request over **x402**, and the payment comes from the account that owns the badge or the agent wallet registered on chain. Paying is the proof of control: copying someone's badge string gets you nothing.
3. The badge's **owner** is inside their limits. Limits are per accountable human, not per agent, so minting more agents buys nothing.

Every outcome, served or refused, goes into a hash-chained audit log whose head is written on Concordium, so the operator cannot quietly rewrite history.

Built for the Concordium Trusted Agents Hackathon. Runs on Concordium testnet. [Watch the 90-second demo](https://cdn.jsdelivr.net/gh/maskjelly/warrant@4eea7e866d2a460822a54056aa8de2e4f368f0aa/docs/demo.mp4).

## Request flow

```
agent                       Warrant                         Concordium
  | GET /v1/report             |                                |
  |  warrant-agent: <badge>    |-- check badge (Agent Registry)->|
  |<-- 402 PAYMENT-REQUIRED ---|                                |
  | sign transfer (no fees)    |                                |
  | GET + PAYMENT-SIGNATURE -->| payer == badge owner/wallet?   |
  |                            |-- sponsor, submit, finalize --->|
  |<-- 200 + PAYMENT-RESPONSE -|-- anchor audit head ----------->|
```

| Response | Meaning |
|---|---|
| 401 `badge_missing` | No badge header |
| 403 `badge_invalid` | Badge not registered, not active, or card hash mismatch |
| 402 `payment_required` | Badge is fine; x402 challenge returned |
| 403 `payer_not_bound_to_badge` | Payment signed by an account the badge does not name |
| 429 `owner_rate_limited` | The human behind the badge used up their allowance |
| 200 | Paid and served; headers carry the payment and audit record |

## Concordium components used

| Component | Use |
|---|---|
| Agent Registry (CIS-8004) and Verified by Concordium badge | Admission check on every request; source of the accountable owner |
| x402 on Concordium (`@x402/concordium`) | Per-request payment in CCD or a PLT stablecoin |
| Sponsored transactions | The gateway pays the fee, so an agent only needs the asset it pays in |
| On-chain data registration | Audit log head anchored as a `RegisterData` transaction |

## On testnet

| What | Link |
|---|---|
| Demo agent registration (token 1549, badge `JyP9U8ewSjxyopPwq3PKf`) | [transaction](https://testnet.ccdscan.io/?dcount=1&dentity=transaction&dhash=a3c28750370a48a542c50295068825ac041624f5ed6a3dea14c06c1929bbdef0) |
| Agent Card URL and hash pinned | [transaction](https://testnet.ccdscan.io/?dcount=1&dentity=transaction&dhash=ea128f0c1a5de420c61deb0be2587a6e5630f102b7c3d1bd7929b8537889f539) |
| Paid request served by the gateway | [transaction](https://testnet.ccdscan.io/?dcount=1&dentity=transaction&dhash=12947931933adfb34b4f9486bc39b36abcde785aa6f0ebd913efbf678fbb30da) |
| Audit head anchored (through record 9) | [transaction](https://testnet.ccdscan.io/?dcount=1&dentity=transaction&dhash=f98c29882857f9b3f5930ba5e08d0ec62bb243b10c85b1119431112cbb60a3a1) |
| First sponsored x402 payment | [transaction](https://testnet.ccdscan.io/?dcount=1&dentity=transaction&dhash=5e8f4ac562bcf4078a4695475806b1fa3ebf3520805b2bd4554c8d1c8de39d71) |

## Use it

```ts
import { Hono } from "hono";
import { warrant } from "./src/gateway";

app.get("/v1/report", warrant({ registry, settler, audit, policy }), (c) =>
  c.json({ servedTo: c.get("agent").ownerAccount }),
);
```

See `src/server.ts` for the full wiring.

## Run the demo

Needs Node 20+ and [Bun](https://bun.sh). Everything below is testnet only.

```sh
bun install
npx tsx scripts/identity.ts   # test identity from the testnet identity provider
npx tsx scripts/accounts.ts   # agent, merchant and sponsor accounts; fund them from the testnet faucet
npx tsx scripts/register.ts   # mint the agent in the Agent Registry
npx tsx scripts/card.ts --pin # build the Agent Card and pin its URL and hash (edit CARD_URL to where you host it)

WARRANT_ANCHOR_EVERY=1 bun run dev   # gateway on :4021
bun run demo                          # runs every outcome in the table above
bun test                              # unit tests, no network
```

Keys are written to `keys/`, which is git-ignored. `GET /audit` returns the records, the chain check and the anchor transactions.

| Variable | Default | Meaning |
|---|---|---|
| `WARRANT_NETWORK` | `testnet` | `testnet` or `mainnet` |
| `WARRANT_PAY_TO` | demo merchant | Account that receives payments |
| `WARRANT_SPONSOR_ADDRESS`, `WARRANT_SPONSOR_KEY` | demo sponsor | Account that pays fees and anchors the log |
| `WARRANT_PRICE`, `WARRANT_ASSET` | `10000`, `CCD` | Price in atomic units; asset may be a PLT symbol |
| `WARRANT_MAX_PER_OWNER`, `WARRANT_WINDOW_MS` | `2`, `60000` | Served requests per owner per window |
| `WARRANT_ANCHOR_EVERY` | `5` | Anchor after this many new records |

## Paid agent check (Base)

`service/server.ts` sells one lookup to agents on other chains: is there a valid Verified by Concordium badge behind this agent, and which account answers for it. It charges USDC on Base over x402 through a public facilitator, paid straight to `PAY_TO`; the server holds no keys.

```sh
PAY_TO=0xYourAddress bun run service   # GET /v1/check?badge=<token address>&network=mainnet|testnet, $0.005 per call
```

Live at `https://warrant-agent-check.vercel.app/v1/check?badge=<token address>` (deployed from `api/index.ts`); `/openapi.json` and `/.well-known/x402` describe it for x402 directories. The unpaid request returns the correct 402 challenge; a paid call has not been run end to end.

## Verifying the audit log

Each record holds the SHA-256 of the previous one. An anchor transaction carries `warrant/v1`, the record count and the head hash. To audit: recompute the chain from `GET /audit` (`verifyChain` in `src/audit.ts`), then compare the hash at each anchored position with the data in the anchor transaction. Any edit, deletion or reorder before an anchor changes that hash.

## Limits of this version

- The audit log proves records were not changed after anchoring. It does not prove the operator logged every request.
- A badge shows an accountable owner exists; it does not reveal who they are. Disclosure goes through Concordium's identity layer and its legal process.
- Rate-limit counters are in memory and the log is a local file; one gateway instance only.
- The badge check uses Concordium's hosted Agent Registry service. If it is unreachable, requests are refused, not waved through.

## Path to mainnet

1. Price in a PLT stablecoin (already supported by the payment code; set `WARRANT_ASSET`).
2. Read the registry contract directly from a node as a fallback to the hosted service.
3. Move counters and the log to shared storage, and hold the sponsor key in a managed wallet (for example Dfns) with a spending cap.
4. Ship as an npm package with Hono and Express adapters, and a hosted version where API owners pay a small share of each settled request.
