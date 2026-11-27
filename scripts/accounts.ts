// Deploys the three TESTNET demo accounts (agent, merchant, sponsor) from the test identity.
import { readFileSync, writeFileSync } from "node:fs";
import { mnemonicToSeedSync } from "@scure/bip39";
import {
  ConcordiumHdWallet,
  TransactionExpiry,
  createCredentialPayload,
  serializeCredentialDeploymentPayload,
  getAccountAddress,
  signCredentialTransaction,
} from "@concordium/web-sdk";
import { ConcordiumGRPCNodeClient, credentials } from "@concordium/web-sdk/nodejs";

const ROLES = ["agent", "merchant", "sponsor"] as const;
const seed = readFileSync("keys/seed.txt", "utf8").trim();
const { ipIndex, identityIndex, identityObject } = JSON.parse(readFileSync("keys/identity.json", "utf8"));
const wallet = ConcordiumHdWallet.fromSeedPhrase(seed, "Testnet");
const providers = (await (await fetch("https://wallet-proxy.testnet.concordium.com/v2/ip_info")).json()) as any[];
const provider = providers.find((p) => p.ipInfo.ipIdentity === ipIndex);
const client = new ConcordiumGRPCNodeClient("grpc.testnet.concordium.com", 20000, credentials.createSsl());
const globalContext = await client.getCryptographicParameters();

const accounts: Record<string, { address: string; signKey: string }> = {};
for (const [credNumber, role] of ROLES.entries()) {
  const expiry = TransactionExpiry.fromDate(new Date(Date.now() + 360_000));
  const tx = createCredentialPayload(
    {
      ipInfo: provider.ipInfo,
      globalContext,
      arsInfos: provider.arsInfos,
      idObject: identityObject,
      revealedAttributes: [],
      seedAsHex: Buffer.from(mnemonicToSeedSync(seed)).toString("hex"),
      net: "Testnet",
      identityIndex,
      credNumber,
    } as never,
    expiry,
  );
  const signKey = wallet.getAccountSigningKey(ipIndex, identityIndex, credNumber);
  const address = getAccountAddress(tx.unsignedCdi.credId).address;
  accounts[role] = { address, signKey: signKey.toString("hex") };
  try {
    await client.getAccountInfo(getAccountAddress(tx.unsignedCdi.credId));
    console.log(role, address, "already exists");
    continue;
  } catch {}
  const signature = await signCredentialTransaction(tx, signKey.toString("hex"));
  const hash = await client.sendCredentialDeploymentTransaction(serializeCredentialDeploymentPayload([signature], tx), expiry);
  await client.waitForTransactionFinalization(hash);
  console.log(role, address, "created");
}
writeFileSync("keys/accounts.json", JSON.stringify(accounts, null, 2), { mode: 0o600 });
