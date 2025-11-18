import { JsonRpcProvider, parseUnits } from 'ethers';
import pulsexConfig from '../../src/config/pulsex';
import { PulseXQuoter } from '../../src/pulsex/PulseXQuoter';
import type { PulsexToken } from '../../src/types/pulsex';

const provider = new JsonRpcProvider(
  process.env.RPC_URL ?? pulsexConfig.chainId,
  pulsexConfig.chainId,
);

const selectToken = (symbol: string): PulsexToken => {
  const lower = symbol.toLowerCase();
  const token =
    pulsexConfig.connectorTokens.find(
      (candidate) => (candidate.symbol ?? '').toLowerCase() === lower,
    ) ?? pulsexConfig.stableTokens.find(
      (candidate) => (candidate.symbol ?? '').toLowerCase() === lower,
    );
  if (!token) {
    throw new Error(`Token with symbol ${symbol} not found in config`);
  }
  return token;
};

async function main(): Promise<void> {
  const quoter = new PulseXQuoter(provider, pulsexConfig);
  const internals = quoter as unknown as {
    ensureStableIndicesLoaded: () => Promise<void>;
    generateRouteCandidates: (a: PulsexToken, b: PulsexToken) => any[];
    simulateRoute: (route: any, amountIn: bigint) => Promise<{ amountOut: bigint } | null>;
  };

  await internals.ensureStableIndicesLoaded();

  const tokenIn = selectToken(process.argv[2] ?? 'USDC');
  const tokenOut = selectToken(process.argv[3] ?? 'WPLS');
  const humanAmount = process.argv[4] ?? '100000';
  const amountIn = parseUnits(humanAmount, tokenIn.decimals);

  const candidates = internals.generateRouteCandidates(tokenIn, tokenOut);
  console.log(
    `Generated ${candidates.length} candidates for ${tokenIn.symbol} -> ${tokenOut.symbol}`,
  );
  for (const candidate of candidates) {
    const simulation = await internals.simulateRoute(candidate, amountIn);
    const amountOut = simulation ? simulation.amountOut.toString() : 'FAILED';
    console.log(
      candidate.id,
      candidate.legs.map((leg: any) => leg.protocol).join(' -> '),
      'amountOut=',
      amountOut,
    );
  }
}

void main();
