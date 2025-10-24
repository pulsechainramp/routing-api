import { FastifyInstance } from "fastify";
import { loadOnrampsJson } from "../../services/onrampsStore";
import { fillTemplate, signMoonPayIfNeeded } from "../../utils/onrampLinks";

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
    const unknown = !entry || country.toUpperCase() === "ZZ";

    const envRecord = process.env as Record<string, string | undefined>;

    const build = (p: any) => {
      let url = fillTemplate(p.deeplink_template as any, { address, amount, fiat }, envRecord);
      if (!url) url = p.coverage_url ?? (p.regulator_links?.[0] ?? null);
      return { ...p, deeplink: url, deeplink_available: Boolean(url) };
    };

    if (unknown) {
      const fallbackIds = json.globals.fallback_providers ?? [];
      const catalog = json.globals.default_provider_details ?? {};
      const fallbackFilled = fallbackIds
        .map(id => catalog[id])
        .filter(Boolean)
        .map(build);

      return {
        country,
        providers: [],
        fallback_providers: fallbackIds,
        // NEW: full records for the UI to render without hard-coding
        fallback_provider_details: fallbackFilled
      };
    }

    // Known country:
    const filled = entry.providers
      .slice()
      .sort((a, b) => a.priority - b.priority)
      .map(build);

    const fallbackIds = entry.fallback_providers ?? json.globals.fallback_providers ?? [];
    const catalog = json.globals.default_provider_details ?? {};
    const fallbackFilled = fallbackIds
      .map(id => catalog[id])
      .filter(Boolean)
      .map(build);

    return {
      country: entry.iso2,
      providers: filled,
      fallback_providers: fallbackIds,
      fallback_provider_details: fallbackFilled
    };
  });
}
