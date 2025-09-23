export const ENFORCE_ALLOWED_DEXES =
  (process.env.ENFORCE_ALLOWED_DEXES ?? 'true').toLowerCase() === 'true';

// Slugs must match the output of toCorrectDexName() (case-insensitive).
// Unknown/new DEXes are blocked by default (deny-by-default).
export const DEFAULT_ALLOWED = [
  'pulsexv1',
  'pulsexv2',
  'pulsexstable',
  'phux',
  '9inchv2',
  '9inchv3',
  '9mmv2',
  '9mmv3',
  'pdexv3',
  'dextop',
  'tide'
];

export function buildAllowlistFromEnvAndQuery(
  base = new Set(DEFAULT_ALLOWED),
  allowedCsv?: string,
  blockedCsv?: string
) {
  // Start from env override if present
  const envCsv = process.env.ALLOWED_DEXES;
  if (envCsv) base = new Set(envCsv.split(',').map(s => s.trim().toLowerCase()));

  const allow = new Set(base);
  if (allowedCsv) {
    for (const s of allowedCsv.split(',')) allow.add(s.trim().toLowerCase());
  }
  if (blockedCsv) {
    for (const s of blockedCsv.split(',')) allow.delete(s.trim().toLowerCase());
  }
  return allow;
}
