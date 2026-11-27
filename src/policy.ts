export interface PolicyOptions {
  /** Max served requests per verified owner inside the window, however many agents they run. */
  maxPerOwner?: number;
  windowMs?: number;
  blockedOwners?: string[];
  now?: () => number;
}

export type PolicyResult = { allowed: true } | { allowed: false; reason: "owner_blocked" | "owner_rate_limited" };

/** Limits are keyed on the accountable human, not on the agent, so spinning up more agents buys nothing. */
export function createPolicy(options: PolicyOptions = {}) {
  const max = options.maxPerOwner ?? Infinity;
  const windowMs = options.windowMs ?? 60_000;
  const blocked = new Set(options.blockedOwners ?? []);
  const now = options.now ?? Date.now;
  const served = new Map<string, number[]>();

  function recent(owner: string): number[] {
    const cutoff = now() - windowMs;
    const kept = (served.get(owner) ?? []).filter((t) => t > cutoff);
    served.set(owner, kept);
    return kept;
  }

  return {
    check(owner: string): PolicyResult {
      if (blocked.has(owner)) return { allowed: false, reason: "owner_blocked" };
      if (recent(owner).length >= max) return { allowed: false, reason: "owner_rate_limited" };
      return { allowed: true };
    },
    record(owner: string): void {
      recent(owner).push(now());
    },
  };
}

export type Policy = ReturnType<typeof createPolicy>;
