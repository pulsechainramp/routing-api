import { config as loadEnv } from 'dotenv';
import { JsonRpcProvider } from 'ethers';
import pulsexConfig from '../../src/config/pulsex';
import { PulseXQuoter } from '../../src/pulsex/PulseXQuoter';
import pulsexBaseConfig from '../../src/config';

loadEnv();

const resolveRpcUrl = (): string => {
  const candidates = [
    process.env.RPC_URL,
    process.env.PULSECHAIN_RPC_URL,
    pulsexBaseConfig.RPC_URL,
  ];
  for (const url of candidates) {
    const trimmed = url?.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  throw new Error(
    'Unable to resolve an RPC URL. Set RPC_URL or PULSECHAIN_RPC_URL.',
  );
};

const provider = new JsonRpcProvider(resolveRpcUrl(), pulsexConfig.chainId);

async function main(): Promise<void> {
  const quoter = new PulseXQuoter(provider, pulsexConfig);
  const internals = quoter as unknown as {
    ensureStableIndicesLoaded: () => Promise<void>;
    stableIndexMap?: Map<string, number>;
  };

  await internals.ensureStableIndicesLoaded();
  const map = internals.stableIndexMap
    ? Array.from(internals.stableIndexMap.entries())
    : [];

  console.log('Stable index map entries:', map);
}

void main();
