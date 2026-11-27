// Creates a Concordium TESTNET identity for the demo accounts. Never use these keys on mainnet.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { generateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";
import { ConcordiumHdWallet, createIdentityRequestWithKeys } from "@concordium/web-sdk";
import { ConcordiumGRPCNodeClient, credentials } from "@concordium/web-sdk/nodejs";

const SEED_FILE = "keys/seed.txt";
const ID_FILE = "keys/identity.json";
const IP_INDEX = 0;
const IDENTITY_INDEX = 0;

const seed = existsSync(SEED_FILE) ? readFileSync(SEED_FILE, "utf8").trim() : generateMnemonic(wordlist, 256);
writeFileSync(SEED_FILE, seed, { mode: 0o600 });
const wallet = ConcordiumHdWallet.fromSeedPhrase(seed, "Testnet");

const providers = (await (await fetch("https://wallet-proxy.testnet.concordium.com/v2/ip_info")).json()) as any[];
const provider = providers.find((p) => p.ipInfo.ipIdentity === IP_INDEX);
const client = new ConcordiumGRPCNodeClient("grpc.testnet.concordium.com", 20000, credentials.createSsl());
const globalContext = await client.getCryptographicParameters();

const identityRequest = createIdentityRequestWithKeys({
  arsInfos: provider.arsInfos,
  arThreshold: Math.min(Object.keys(provider.arsInfos).length - 1, 255),
  ipInfo: provider.ipInfo,
  globalContext,
  idCredSec: wallet.getIdCredSec(IP_INDEX, IDENTITY_INDEX).toString("hex"),
  prfKey: wallet.getPrfKey(IP_INDEX, IDENTITY_INDEX).toString("hex"),
  blindingRandomness: wallet.getSignatureBlindingRandomness(IP_INDEX, IDENTITY_INDEX).toString("hex"),
});

const params = new URLSearchParams({
  scope: "identity",
  response_type: "code",
  redirect_uri: "http://localhost:4100/identity",
  state: JSON.stringify({ idObjectRequest: identityRequest }),
});
let res = await fetch(`${provider.metadata.issuanceStart}?${params}`, { redirect: "manual" });
console.log("start:", res.status, res.headers.get("location")?.slice(0, 300));
// The testnet identity provider issues test identities from a form of placeholder attributes.
const verifyUrl = res.headers.get("location")!;
const html = await (await fetch(verifyUrl)).text();
const form = new URLSearchParams();
for (const tag of html.match(/<input[^>]*>/g) ?? []) {
  const name = tag.match(/name="([^"]*)"/)?.[1];
  if (!name || name === "fail") continue;
  form.set(name, tag.match(/value="([^"]*)"/)?.[1] ?? "");
}
form.set("expiry", "2030-01");
res = await fetch(new URL("/api/submit", verifyUrl), { method: "POST", body: form, redirect: "manual" });
let location = res.headers.get("location");
while (location && !location.startsWith("http://localhost:4100")) {
  res = await fetch(new URL(location, verifyUrl), { redirect: "manual" });
  location = res.headers.get("location");
}
if (!location) throw new Error(`identity issuance did not redirect back: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
const codeUri = new URL(location.replace("#", "?")).searchParams.get("code_uri");
if (!codeUri) throw new Error(`no code_uri in ${location}`);

for (let attempt = 0; attempt < 60; attempt++) {
  const poll = (await (await fetch(codeUri)).json()) as any;
  if (poll.status === "done") {
    writeFileSync(ID_FILE, JSON.stringify({ ipIndex: IP_INDEX, identityIndex: IDENTITY_INDEX, identityObject: poll.token.identityObject.value }, null, 2), { mode: 0o600 });
    console.log("identity issued");
    process.exit(0);
  }
  if (poll.status === "error") throw new Error(`identity rejected: ${poll.detail}`);
  await new Promise((r) => setTimeout(r, 3000));
}
throw new Error("identity issuance timed out");
