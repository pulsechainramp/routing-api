import { ALLOWED_PROVIDER_HOSTS } from "../data/allowedProviderHosts";

const allowlistMap = ALLOWED_PROVIDER_HOSTS as Record<string, readonly string[]>;

export const normalizeHost = (host: string) =>
  host.toLowerCase().replace(/^www\./, "");

const matchesAllowedHost = (candidate: string, allowed: string) =>
  candidate === allowed || candidate.endsWith(`.${allowed}`);

export const hostMatchesAllowlist = (
  providerId: string,
  hostname: string | null
): boolean => {
  if (!hostname) return false;
  const normalized = normalizeHost(hostname);
  const allowedHosts = allowlistMap[providerId];
  if (!allowedHosts || allowedHosts.length === 0) {
    return false;
  }
  return allowedHosts.some((allowedHost: string) =>
    matchesAllowedHost(normalized, allowedHost)
  );
};
