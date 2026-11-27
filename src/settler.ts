import { ExactConcordiumScheme as FacilitatorScheme } from "@x402/concordium/exact/facilitator";
import { ExactConcordiumScheme as ServerScheme } from "@x402/concordium/exact/server";
import { getConcordiumGrpcUrl, parseGrpcUrl, toConcordiumFacilitatorSigner } from "@x402/concordium";
import type { Network, PaymentRequirements } from "@x402/core/types";
import type { Settler } from "./gateway";

export interface ConcordiumSettlerOptions {
  network: Network;
  payTo: string;
  /** Price in microCCD, or atomic units of a PLT when `asset` is a token symbol. */
  amount: string;
  asset?: string;
  sponsorAddress: string;
  sponsorKey: string;
}

/**
 * An in-process x402 facilitator on Concordium: it checks the agent's sender-signed transfer,
 * co-signs it as sponsor (so the agent needs no CCD for fees), submits it and waits for finality.
 */
export function createConcordiumSettler(options: ConcordiumSettlerOptions): Settler {
  const [host, port] = parseGrpcUrl(getConcordiumGrpcUrl(options.network));
  const signer = toConcordiumFacilitatorSigner(options.sponsorAddress, options.sponsorKey, { host, port, useTls: true });
  const facilitator = new FacilitatorScheme({ signer });
  const server = new ServerScheme();
  let cached: Promise<PaymentRequirements> | undefined;

  return {
    requirements() {
      cached ??= (async () => {
        const price = await server.parsePrice({ amount: options.amount, asset: options.asset ?? "CCD" }, options.network);
        const draft = {
          scheme: "exact",
          network: options.network,
          payTo: options.payTo,
          amount: price.amount,
          asset: price.asset,
          maxTimeoutSeconds: 300,
          extra: price.extra ?? {},
        } as PaymentRequirements;
        return server.enhancePaymentRequirements(
          draft,
          { x402Version: 2, scheme: "exact", network: options.network, extra: facilitator.getExtra(options.network) },
          [],
        );
      })();
      return cached;
    },
    async verify(payload, requirements) {
      const result = await facilitator.verify(payload, requirements);
      return { ok: result.isValid, reason: result.invalidReason ?? result.invalidMessage };
    },
    async settle(payload, requirements) {
      const result = await facilitator.settle(payload, requirements);
      return { ok: result.success, txHash: result.transaction || undefined, reason: result.errorReason ?? result.errorMessage };
    },
  };
}
