import { config as loadEnv } from 'dotenv';
import axios from 'axios';
import { formatUnits, parseUnits } from 'ethers';
import pulsexConfig from '../../src/config/pulsex';
import type { PulsexToken } from '../../src/types/pulsex';
import type { SignedQuoteResponse } from '../../src/types/QuoteResponse';
import type { CombinedRoute, CombinedPath } from '../../src/types/Quote';

loadEnv();

const DEFAULT_QUOTE_URL = 'http://localhost:3000/quote/pulsex';
const quoteUrl =
  (process.env.PULSEX_QUOTE_URL ?? process.env.PULSEX_STRESS_QUOTE_URL ?? DEFAULT_QUOTE_URL).trim();
const slippageBps = process.env.PULSEX_SMOKE_SLIPPAGE ?? '0.5';

const symbolAliases: Record<string, string> = {
  PLS: 'WPLS',
};

const tokenIndex = new Map(
  pulsexConfig.connectorTokens.map((token) => [
    (token.symbol ?? token.address).toUpperCase(),
    token,
  ]),
);

const findTokenBySymbol = (symbol: string): PulsexToken => {
  const normalized = symbolAliases[symbol.toUpperCase()] ?? symbol.toUpperCase();
  const token = tokenIndex.get(normalized);
  if (!token) {
    throw new Error(`Unknown token symbol ${symbol}`);
  }
  return token;
};

interface Scenario {
  label: string;
  tokenIn: PulsexToken;
  tokenOut: PulsexToken;
  humanAmount: string;
  expectStable: boolean;
}

const scenarios: Scenario[] = [
  {
    label: 'USDC -> PLS (100k)',
    tokenIn: findTokenBySymbol('USDC'),
    tokenOut: findTokenBySymbol('PLS'),
    humanAmount: '100000',
    expectStable: true,
  },
  {
    label: 'USDT -> PLSX (50k)',
    tokenIn: findTokenBySymbol('USDT'),
    tokenOut: findTokenBySymbol('PLSX'),
    humanAmount: '50000',
    expectStable: true,
  },
  {
    label: 'DAI -> PLSX (100k)',
    tokenIn: findTokenBySymbol('DAI'),
    tokenOut: findTokenBySymbol('PLSX'),
    humanAmount: '100000',
    expectStable: true,
  },
];

const flattenPaths = (route: CombinedRoute | undefined): CombinedPath[] => {
  if (!route?.length) {
    return [];
  }
  return route.flatMap((swap) =>
    (swap?.subroutes ?? []).flatMap((subroute) => subroute.paths ?? []),
  );
};

const runScenario = async (scenario: Scenario): Promise<void> => {
  const amountWei = parseUnits(scenario.humanAmount, scenario.tokenIn.decimals);
  const response = await axios.get<SignedQuoteResponse>(quoteUrl, {
    params: {
      tokenInAddress: scenario.tokenIn.address,
      tokenOutAddress: scenario.tokenOut.address,
      amount: amountWei.toString(),
      allowedSlippage: slippageBps,
    },
    timeout: Number(process.env.PULSEX_QUOTE_TIMEOUT_MS ?? 15_000),
  });

  const quote = response.data;
  const paths = flattenPaths(quote.route);
  const usesStable = paths.some((path) => path.exchange === 'PulseX Stable');

  if (scenario.expectStable && !usesStable) {
    throw new Error('Expected a PulseX stable route leg but none was returned');
  }

  const formattedOut = formatUnits(
    BigInt(quote.outputAmount),
    scenario.tokenOut.decimals ?? scenario.tokenIn.decimals,
  );

  console.log(
    `[PASS] ${scenario.label} -> amountOut=${formattedOut} (stableLeg=${usesStable})`,
  );
  console.log(
    '       path summary:',
    paths
      .map(
        (path) =>
          `${path.exchange} (${(path.percent ?? 0) / 1000}%): ${
            path.tokens.map((token) => token.symbol ?? token.address).join(' -> ') || 'n/a'
          }`,
      )
      .join(' | '),
  );
};

const main = async (): Promise<void> => {
  console.log('PulseX stable routing smoke test');
  console.log('Quote endpoint:', quoteUrl);
  let failures = 0;
  for (const scenario of scenarios) {
    try {
      await runScenario(scenario);
    } catch (error) {
      failures += 1;
      console.error(
        `[FAIL] ${scenario.label}:`,
        error instanceof Error ? error.message : error,
      );
    }
  }
  if (failures > 0) {
    console.error(`PulseX stable routing smoke test completed with ${failures} failures.`);
    process.exitCode = 1;
    return;
  }
  console.log('All PulseX stable routing smoke checks passed.');
};

void main();
