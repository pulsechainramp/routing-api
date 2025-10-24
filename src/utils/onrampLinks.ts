import crypto from "node:crypto";

export type FillParams = {
  address?: string | null;
  amount?: string | null; // fiat amount (e.g., "200")
  fiat?: string | null;   // fiat currency (e.g., "USD")
};

export function fillTemplate(
  tpl: string | null | undefined,
  params: FillParams,
  env: Record<string, string | undefined>
) {
  if (!tpl || typeof tpl !== "string") return null; // ← guard
  const withPublic = tpl
    .replace("{address}", encodeURIComponent(params.address ?? ""))
    .replace("{amount}", encodeURIComponent(params.amount ?? ""))
    .replace("{fiat}", encodeURIComponent(params.fiat ?? ""))
    // publishable keys / public params:
    .replace("{MOONPAY_KEY}", encodeURIComponent(env.MOONPAY_PUBLISHABLE_KEY ?? ""))
    .replace("{TRANSAK_KEY}", encodeURIComponent(env.TRANSAK_KEY ?? ""))
    .replace("{RAMP_KEY}", encodeURIComponent(env.RAMP_HOST_API_KEY ?? ""))
    .replace("{APP}", encodeURIComponent(env.RAMP_HOST_APP_NAME ?? ""))
    .replace("{REFERRER_DOMAIN}", encodeURIComponent(env.TRANSAK_REFERRER_DOMAIN ?? ""))
    .replace("{FINAL_URL}", encodeURIComponent(env.RAMP_FINAL_URL ?? ""));
  return withPublic;
}

// Create MoonPay signature if walletAddress is used
export function signMoonPayIfNeeded(urlStr: string | null, secretKey?: string): string | null {
  if (!urlStr) return null;
  if (!secretKey) return urlStr;

  const url = new URL(urlStr);
  // If the URL is not a MoonPay URL, or doesn't include walletAddress, skip
  const hasWalletAddress = url.searchParams.has("walletAddress") || url.searchParams.has("walletAddresses");
  if (!hasWalletAddress) return urlStr;

  // MoonPay requires the HMAC-SHA256 of the query string (values must be URL-encoded)
  // Then append &signature=<base64> (URL-encoded)
  const query = url.search; // includes leading '?'
  const signature = crypto
    .createHmac("sha256", secretKey)
    .update(query)
    .digest("base64");

  url.searchParams.set("signature", signature);
  return url.toString();
}
