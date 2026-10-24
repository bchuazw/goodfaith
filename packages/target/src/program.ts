// The Lantern bug-bounty program descriptor (see docs/CONTRACTS.md).

import type { Severity } from "@goodfaith/core";

export const LANTERN_PROGRAM: {
  id: "lantern";
  name: "Lantern";
  tagline: string;
  repo: string;
  versionsInScope: string[];
  accounts: Array<{ id: string; description: string }>;
  bounties: Record<Severity, { currency: "USD"; value: string }>;
  deposit: { currency: "USD"; value: string };
  trustAfterVerified: number;
} = {
  id: "lantern",
  name: "Lantern",
  tagline: "A small self-hosted notes app.",
  repo: "lantern-notes/lantern",
  versionsInScope: ["1.4.0", "1.4.1"],
  accounts: [
    { id: "alice", description: "Alice — the researcher's own test account (a normal user)" },
    { id: "bob", description: "Bob — a second normal user, the victim in access-control tests" },
    { id: "admin", description: "Admin — the Lantern administrator" },
  ],
  bounties: {
    low: { currency: "USD", value: "50.00" },
    medium: { currency: "USD", value: "200.00" },
    high: { currency: "USD", value: "500.00" },
    critical: { currency: "USD", value: "1500.00" },
  },
  deposit: { currency: "USD", value: "20.00" },
  trustAfterVerified: 3,
};
