import { JsonRpcProvider } from 'ethers';
import pulsexConfig from '../../src/config/pulsex';
import { PulseXQuoter } from '../../src/pulsex/PulseXQuoter';

const provider = new JsonRpcProvider(
  process.env.RPC_URL ?? pulsexConfig.chainId,
  pulsexConfig.chainId,
);

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
