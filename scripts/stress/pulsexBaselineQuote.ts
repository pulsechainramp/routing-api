import { config as loadEnv } from 'dotenv';
import { formatUnits, JsonRpcProvider } from 'ethers';
import pulsexBaseConfig from '../../src/config';
import pulsexConfig from '../../src/config/pulsex';
import { PulseXQuoter } from '../../src/pulsex/PulseXQuoter';
import type {
  Address,
  ExactInQuoteRequest,
  PulsexToken,
  PulsexQuoteResult,
  RouteLegSummary,
} from '../../src/types/pulsex';

loadEnv();

const resolveRpcUrl = (): string => {
  const candidates = [
    process.env.PULSEX_BASELINE_RPC_URL,
    process.env.PULSEX_QUOTE_BASE_RPC,
    process.env.PULSECHAIN_RPC_URL,
    process.env.RPC_URL,
    pulsexBaseConfig.RPC_URL,
  ];
  for (const url of candidates) {
    if (url && url.trim()) {
      return url;
    }
  }
  throw new Error(
    'Unable to resolve an RPC URL. Set PULSEX_BASELINE_RPC_URL or PULSECHAIN_RPC_URL.',
  );
};

const selectToken = (
  tokens: PulsexToken[],
  predicate: (token: PulsexToken) => boolean,
): PulsexToken => {
  const token = tokens.find(predicate);
  if (!token) {
    throw new Error('Required token metadata missing from PulseX config');
  }
  return token;
};

const RPC_URL = resolveRpcUrl();
const provider = new JsonRpcProvider(RPC_URL, pulsexConfig.chainId);
const quoter = new PulseXQuoter(provider, pulsexConfig);

const usdcToken = selectToken(
  pulsexConfig.stableTokens,
  (token) => token.symbol?.toUpperCase() === 'USDC',
);
const plsToken = selectToken(
  pulsexConfig.connectorTokens,
  (token) => token.isNative,
);

const AMOUNT_IN_USDC_100K: bigint = 100_000n * 1_000_000n;
const recipient = pulsexConfig.routers.default;

const buildRequest = (): ExactInQuoteRequest => ({
  chainId: pulsexConfig.chainId,
  tokenIn: usdcToken,
  tokenOut: plsToken,
  amountIn: AMOUNT_IN_USDC_100K,
  slippageBps: 50,
  recipient: recipient as Address,
});

const collectLegs = (quote: PulsexQuoteResult): RouteLegSummary[] => {
  if (quote.singleRoute?.length) {
    return quote.singleRoute;
  }
  if (quote.splitRoutes?.length) {
    return quote.splitRoutes.flatMap((route) => route.legs);
  }
  return [];
};

const logLegs = (legs: RouteLegSummary[]): void => {
  if (!legs.length) {
    console.log('No route legs returned. Check upstream quote response.');
    return;
  }
  console.log('\n--- Route Legs ---');
  legs.forEach((leg, index) => {
    const input = leg.tokenIn.symbol ?? leg.tokenIn.address;
    const output = leg.tokenOut.symbol ?? leg.tokenOut.address;
    console.log(`${index + 1}. ${leg.protocol}: ${input} -> ${output}`);
  });
};

const main = async (): Promise<void> => {
  console.log('PulseX baseline quote (USDC -> PLS, 100k USDC)');
  console.log('RPC URL:', RPC_URL);
  try {
    const quote = await quoter.quoteBestExactIn(buildRequest());
    const legs = collectLegs(quote);
    logLegs(legs);
    const plsFormatted = formatUnits(quote.totalAmountOut, plsToken.decimals);
    console.log('\nTotal amount out (PLS):', quote.totalAmountOut.toString());
    console.log('Formatted amount out (PLS):', plsFormatted);

    const usesStable = legs.some((leg) => leg.protocol === 'PULSEX_STABLE');
    if (usesStable) {
      console.error(
        '\nBaseline expectation violated: stable router leg detected in current routing.',
      );
      process.exitCode = 1;
    } else {
      console.log(
        '\nBaseline confirmed: no PulseX stable-router legs present in the current best route.',
      );
    }
  } catch (error) {
    console.error(
      'Failed to run baseline quote:',
      error instanceof Error ? error.message : error,
    );
    process.exitCode = 1;
  }
};

void main();
