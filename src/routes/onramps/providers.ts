import { FastifyInstance } from "fastify";
import { loadOnrampsJson } from "../../services/OnRampsStore";
import { fillTemplate } from "../../utils/onrampLinks";
import { sanitizeExternalUrl } from "../../utils/url";

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
        // Only template if a template exists; otherwise fallback to coverage/regulator URLs.
        const templated = fillTemplate(p.deeplink_template as any, { address, amount, fiat });
        const candidates = [
          templated,
          p.coverage_url,
          ...(p.regulator_links ?? [])
        ];

        let safeLink: string | null = null;
        let hadCandidate = false;

        for (const candidate of candidates) {
          if (!candidate) continue;
          hadCandidate = true;
          const sanitized = sanitizeExternalUrl(candidate);
          if (sanitized) {
            safeLink = sanitized;
            break;
          }
        }

        return {
          ...p,
          deeplink: safeLink,
          deeplink_available: Boolean(safeLink),
          link_blocked: hadCandidate && !safeLink ? true : undefined
        };
      });

    return {
      country: entry.iso2,
      providers: filled,
      fallback_providers: entry.fallback_providers ?? json.globals.fallback_providers ?? []
    };
  });
}
