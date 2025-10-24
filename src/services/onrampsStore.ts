import fs from "node:fs";
import path from "node:path";

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
    default_provider_details?: Record<string, {
      id: string;
      display_name: string;
      type: "exchange" | "onramp";
      priority?: number;
      deeplink_template?: string | null;
      coverage_url?: string | null;
      regulator_links?: string[] | null;
      supported_payment_methods?: string[] | null;
      supports_fiat?: string[] | null;
      kyc_speed_hint?: string | null;
      limits_hint?: string | null;
      fee_hint?: string | null;
      risk_notes?: string | null;
      last_verified?: string | null;
      state_rules?: {
        unsupported?: string[];
        restricted?: string[];
        notes?: string | null;
      };
    }>;
    deeplink_placeholders: string[]; // should include {address},{amount},{fiat}
  };
};

let cache: OnrampsJson;

export function loadOnrampsJson(): OnrampsJson {
  if (cache) return cache;
  const file = process.env.ONRAMPS_JSON_PATH || path.join(process.cwd(), "data", "onramps_providers.json");
  const raw = fs.readFileSync(file, "utf8");
  cache = JSON.parse(raw);
  return cache;
}
