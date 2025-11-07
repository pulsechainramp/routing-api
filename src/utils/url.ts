const ABSOLUTE_HTTP_REGEX = /^https?:\/\//i;

type SanitizeOptions = {
  allowHttp?: boolean;
};

const defaultAllowHttp = () => process.env.NODE_ENV !== "production";

export function sanitizeExternalUrl(
  raw: string | null | undefined,
  options?: SanitizeOptions
): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed || !ABSOLUTE_HTTP_REGEX.test(trimmed)) {
    return null;
  }

  const allowHttp = options?.allowHttp ?? defaultAllowHttp();

  try {
    const parsed = new URL(trimmed);
    const protocol = parsed.protocol.toLowerCase();
    if (protocol === "https:") {
      return parsed.toString();
    }
    if (protocol === "http:" && allowHttp) {
      return parsed.toString();
    }
  } catch {
    return null;
  }

  return null;
}
