import { FastifyInstance } from "fastify";
import { loadOnrampsJson } from "../../services/OnRampsStore";
import { fillTemplate } from "../../utils/onrampLinks";
import { sanitizeExternalUrl } from "../../utils/url";
import { hostMatchesAllowlist, normalizeHost } from "../../utils/providerHosts";

export default async function providersRoutes(fastify: FastifyInstance) {
  fastify.get("/providers", {
    schema: {
      querystring: {
        type: "object",
        properties: {
          country: { type: "string" },
          address: { type: "string" },
          amount: { type: "string" }, // fiat number as string
          fiat:    { type: "string" }  // e.g., USD, EUR
        },
        required: ["country"]
      }
    }
  }, async (req) => {
    const { country, address, amount, fiat } = req.query as { country: string; address?: string; amount?: string; fiat?: string; };
    const json = loadOnrampsJson();

    const entry = json.countries.find(c => c.iso2.toUpperCase() === country.toUpperCase());
    if (!entry) return { country, providers: [], fallback_providers: [] };

    // Prepare response with processed deeplinks (when address/amount/fiat are supplied)
    const filled = entry.providers
      .slice()
      .sort((a, b) => a.priority - b.priority)
      .map(p => {
        const templated = fillTemplate(p.deeplink_template as any, { address, amount, fiat });
        const candidates = [
          templated,
          p.coverage_url,
          ...(p.regulator_links ?? [])
        ];

        let safeLink: string | null = null;
        let safeHost: string | null = null;
        let hadCandidate = false;
        let blockedHost: string | null = null;

        for (const candidate of candidates) {
          if (!candidate) continue;
          hadCandidate = true;
          const sanitized = sanitizeExternalUrl(candidate);
          if (!sanitized) continue;

          let hostname: string | null = null;
          try {
            hostname = normalizeHost(new URL(sanitized).hostname);
          } catch {
            hostname = null;
          }

          if (hostname && hostMatchesAllowlist(p.id, hostname)) {
            safeLink = sanitized;
            safeHost = hostname;
            break;
          }

          blockedHost = hostname ?? blockedHost;
        }

        const linkBlocked = hadCandidate && !safeLink ? true : undefined;
        const blockedReason =
          blockedHost && linkBlocked ? "hostname_mismatch" : linkBlocked ? "invalid_url" : undefined;

        return {
          ...p,
          deeplink: safeLink,
          deeplink_host: safeHost ?? undefined,
          deeplink_available: Boolean(safeLink),
          link_blocked: linkBlocked,
          link_blocked_reason: blockedReason
        };
      });

    return {
      country: entry.iso2,
      providers: filled,
      fallback_providers: entry.fallback_providers ?? json.globals.fallback_providers ?? []
    };
  });
}
