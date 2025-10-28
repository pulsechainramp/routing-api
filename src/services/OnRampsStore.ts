import fs from "node:fs";
import path from "node:path";

declare const __dirname: string; // ensure NodeJS global typed when Node types aren't auto-included

export type OnrampsJson = {
  version: string;
  generated_at: string;
  countries: Array<{
    iso2: string;
    notes?: string | null;
    providers: Array<{
      id: string;
      display_name: string;
      type: "exchange" | "onramp";
      priority: number;
      deeplink_template: string;
      coverage_url?: string | null;
      regulator_links?: string[] | null;
      supported_payment_methods?: string[] | null;
      supports_fiat?: string[] | null;
      state_rules?: {
        unsupported?: string[];
        restricted?: string[];
        notes?: string | null;
      };
      kyc_speed_hint?: string | null;
      limits_hint?: string | null;
      fee_hint?: string | null;
      risk_notes?: string | null;
      last_verified?: string;
    }>;
    fallback_providers?: string[];
  }>;
  globals: {
    fallback_providers?: string[];
    deeplink_placeholders: string[]; // should include {address},{amount},{fiat}
  };
};

let cache: OnrampsJson;

export function loadOnrampsJson(): OnrampsJson {
  if (cache) return cache;

  const envPath = process.env.ONRAMPS_JSON_PATH
    ? path.resolve(process.cwd(), process.env.ONRAMPS_JSON_PATH)
    : null;

  const candidatePaths = [
    envPath,
    path.join(process.cwd(), "data", "onramps_providers.json"),
    path.join(process.cwd(), "src/data", "onramps_providers.json"),
    path.join(__dirname, "..", "data", "onramps_providers.json"),
    path.join(__dirname, "..", "..", "src", "data", "onramps_providers.json")
  ].filter((candidate): candidate is string => Boolean(candidate));

  let lastError: unknown;

  for (const candidate of candidatePaths) {
    try {
      if (!fs.existsSync(candidate)) continue;
      const raw = fs.readFileSync(candidate, "utf8");
      cache = JSON.parse(raw);
      return cache;
    } catch (error) {
      lastError = error;
    }
  }

  const searched = candidatePaths.map(p => `"${p}"`).join(", ");
  const reason = lastError instanceof Error ? lastError.message : String(lastError ?? "unknown error");
  throw new Error(`Unable to load onramps providers JSON. Checked paths: ${searched}. Last error: ${reason}`);
}
