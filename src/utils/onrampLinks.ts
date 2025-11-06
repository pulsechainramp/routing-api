export type FillParams = {
  address?: string | null;
  amount?: string | null; // fiat amount (e.g., "200")
  fiat?: string | null;   // fiat currency (e.g., "USD")
};

export function fillTemplate(
  tpl: string | null | undefined,
  params: FillParams
): string | null {
  if (!tpl || typeof tpl !== "string") {
    return null;
  }

  return tpl
    .replace("{address}", encodeURIComponent(params.address ?? ""))
    .replace("{amount}", encodeURIComponent(params.amount ?? ""))
    .replace("{fiat}", encodeURIComponent(params.fiat ?? ""));
}
