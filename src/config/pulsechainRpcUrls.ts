import './env';

export const DEFAULT_PULSECHAIN_RPCS = [
  'https://rpc.pulsechain.com',
  'https://pulsechain-rpc.publicnode.com',
  'https://rpc-pulsechain.g4mm4.io',
];

export const resolvePulsechainRpcUrls = (): string[] => {
  const raw =
    process.env.PULSECHAIN_RPC_URLS ??
    process.env.RPC_URL ??
    DEFAULT_PULSECHAIN_RPCS.join(',');

  const urls = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);

  if (urls.length === 0) {
    return [...DEFAULT_PULSECHAIN_RPCS];
  }

  return Array.from(new Set(urls));
};
