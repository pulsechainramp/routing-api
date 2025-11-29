import { Contract, JsonRpcProvider, ZeroAddress, formatUnits } from 'ethers';
import baseConfig from '../../src/config';
import pulsexConfig from '../../src/config/pulsex';
import { getAmountOutCpmm } from '../../src/pulsex/cpmmMath';
import type { PulsexToken } from '../../src/types/pulsex';

type ProtocolConfig = {
  name: 'PULSEX_V1' | 'PULSEX_V2';
  factory: string;
  router: string;
  feeBps: number;
};

type PairCheck = {
  tokenIn: PulsexToken;
  tokenOut: PulsexToken;
  protocol: ProtocolConfig;
};

const ROUTER_ABI = [
  'function getAmountsOut(uint256 amountIn, address[] memory path) view returns (uint256[] memory amounts)',
];

const FACTORY_ABI = [
  'function getPair(address tokenA, address tokenB) external view returns (address pair)',
];

const PAIR_ABI = [
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
];

const SAMPLE_PAIR_COUNT = Number(process.env.PULSEX_COMPARE_PAIR_COUNT ?? 8);
const AMOUNT_IN_SCALE = 10 ** 6; // stay small to avoid overflow when running on many pairs
const TOLERANCE_WEI = BigInt(process.env.PULSEX_COMPARE_TOLERANCE_WEI ?? 2);
const rpcUrls =
  process.env.PULSECHAIN_RPC_URLS?.split(',').map((entry) => entry.trim()).filter(Boolean) ??
  [];
const providerUrl =
  process.env.RPC_URL ??
  rpcUrls[0] ??
  baseConfig.PULSECHAIN_RPC_URLS?.[0] ??
  baseConfig.RPC_URL;

if (!providerUrl) {
  throw new Error('No RPC_URL or PULSECHAIN_RPC_URLS configured for compareRouterMath');
}

const provider = new JsonRpcProvider(providerUrl);

const PROTOCOLS: ProtocolConfig[] = [
  {
    name: 'PULSEX_V2',
    factory: pulsexConfig.factories.v2,
    router: pulsexConfig.routers.v2,
    feeBps: pulsexConfig.fees.v2FeeBps,
  },
  {
    name: 'PULSEX_V1',
    factory: pulsexConfig.factories.v1,
    router: pulsexConfig.routers.v1,
    feeBps: pulsexConfig.fees.v1FeeBps,
  },
];

const formatToken = (token: PulsexToken): string => {
  const symbol = token.symbol ?? token.name ?? token.address.slice(0, 6);
  return `${symbol} (${token.address})`;
};

const buildAmountIn = (token: PulsexToken): bigint => {
  const decimals = Math.max(0, Math.min(18, token.decimals ?? 18));
  return BigInt(AMOUNT_IN_SCALE) * 10n ** BigInt(Math.max(0, decimals - 6));
};

const pickRandomPairs = (tokens: PulsexToken[], count: number): Array<{ tokenIn: PulsexToken; tokenOut: PulsexToken }> => {
  const filtered = tokens.filter(
    (token, index, array) =>
      token.address !== ZeroAddress &&
      array.findIndex((candidate) => candidate.address.toLowerCase() === token.address.toLowerCase()) === index,
  );
  const picks: Array<{ tokenIn: PulsexToken; tokenOut: PulsexToken }> = [];
  let attempts = 0;
  const maxAttempts = filtered.length * filtered.length;
  while (picks.length < count && filtered.length > 1 && attempts < maxAttempts) {
    attempts += 1;
    const a = filtered[Math.floor(Math.random() * filtered.length)];
    const b = filtered[Math.floor(Math.random() * filtered.length)];
    if (!a || !b || a.address.toLowerCase() === b.address.toLowerCase()) {
      continue;
    }
    const exists = picks.some((entry) => {
      const inAddr = entry.tokenIn.address.toLowerCase();
      const outAddr = entry.tokenOut.address.toLowerCase();
      const aLower = a.address.toLowerCase();
      const bLower = b.address.toLowerCase();
      return (
        (inAddr === aLower && outAddr === bLower) ||
        (inAddr === bLower && outAddr === aLower)
      );
    });
    if (exists) {
      continue;
    }
    picks.push({ tokenIn: a, tokenOut: b });
  }
  return picks;
};

const normalizeReserves = (
  tokenIn: PulsexToken,
  tokenOut: PulsexToken,
  token0: string,
  token1: string,
  reserve0: bigint,
  reserve1: bigint,
) => {
  const token0Lower = token0.toLowerCase();
  const token1Lower = token1.toLowerCase();
  const inLower = tokenIn.address.toLowerCase();
  const outLower = tokenOut.address.toLowerCase();
  if (inLower === outLower) {
    return null;
  }
  if (
    (inLower !== token0Lower && inLower !== token1Lower) ||
    (outLower !== token0Lower && outLower !== token1Lower)
  ) {
    return null;
  }
  return {
    reserveIn: inLower === token0Lower ? reserve0 : reserve1,
    reserveOut: outLower === token0Lower ? reserve0 : reserve1,
  };
};

async function fetchPairData(
  pair: PairCheck,
): Promise<{
  reserveIn: bigint;
  reserveOut: bigint;
  routerAmountOut: bigint;
}> {
  const factory = new Contract(pair.protocol.factory, FACTORY_ABI, provider);
  const router = new Contract(pair.protocol.router, ROUTER_ABI, provider);

  const pairAddress: string = await factory.getPair(pair.tokenIn.address, pair.tokenOut.address);
  if (!pairAddress || pairAddress === ZeroAddress) {
    throw new Error('Pair does not exist on chain');
  }

  const pairContract = new Contract(pairAddress, PAIR_ABI, provider);
  const [token0, token1, reserves] = await Promise.all([
    pairContract.token0() as Promise<string>,
    pairContract.token1() as Promise<string>,
    pairContract.getReserves() as Promise<readonly [reserve0: bigint, reserve1: bigint, blockTimestampLast: number]>,
  ]);

  const normalized = normalizeReserves(
    pair.tokenIn,
    pair.tokenOut,
    token0,
    token1,
    BigInt(reserves[0]),
    BigInt(reserves[1]),
  );

  if (!normalized) {
    throw new Error('Pair tokens do not match reserves ordering');
  }

  const amountIn = buildAmountIn(pair.tokenIn);
  const amountsOut = (await router.getAmountsOut(amountIn, [
    pair.tokenIn.address,
    pair.tokenOut.address,
  ])) as [bigint, bigint];

  return {
    reserveIn: normalized.reserveIn,
    reserveOut: normalized.reserveOut,
    routerAmountOut: BigInt(amountsOut[1]),
  };
}

async function compareOnce(pair: PairCheck): Promise<boolean> {
  const { reserveIn, reserveOut, routerAmountOut } = await fetchPairData(pair);
  const cpmmAmountOut = getAmountOutCpmm(
    buildAmountIn(pair.tokenIn),
    reserveIn,
    reserveOut,
    pair.protocol.feeBps,
  );

  const diff = cpmmAmountOut > routerAmountOut ? cpmmAmountOut - routerAmountOut : routerAmountOut - cpmmAmountOut;
  const passes = diff <= TOLERANCE_WEI;

  const summary = {
    pair: `${formatToken(pair.tokenIn)} -> ${formatToken(pair.tokenOut)}`,
    protocol: pair.protocol.name,
    reserveIn: formatUnits(reserveIn, pair.tokenIn.decimals ?? 18),
    reserveOut: formatUnits(reserveOut, pair.tokenOut.decimals ?? 18),
    cpmmAmountOut: cpmmAmountOut.toString(),
    routerAmountOut: routerAmountOut.toString(),
    diffWei: diff.toString(),
    feeBps: pair.protocol.feeBps,
  };

  if (!passes) {
    console.warn('[FAIL]', summary);
  } else {
    console.info('[OK]', summary);
  }

  return passes;
}

async function main() {
  const pairs = pickRandomPairs(pulsexConfig.connectorTokens, SAMPLE_PAIR_COUNT);
  if (!pairs.length) {
    throw new Error('No connector token pairs available for comparison');
  }

  const checks: PairCheck[] = [];
  for (const protocol of PROTOCOLS) {
    for (const pair of pairs) {
      checks.push({
        tokenIn: pair.tokenIn,
        tokenOut: pair.tokenOut,
        protocol,
      });
    }
  }

  let failures = 0;
  let skipped = 0;
  let successes = 0;
  for (const check of checks) {
    try {
      const ok = await compareOnce(check);
      if (!ok) {
        failures += 1;
      } else {
        successes += 1;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.toLowerCase().includes('pair does not exist')) {
        skipped += 1;
        console.warn('[SKIP missing pair]', {
          pair: `${formatToken(check.tokenIn)} -> ${formatToken(check.tokenOut)}`,
          protocol: check.protocol.name,
        });
        continue;
      }
      skipped += 1;
      console.warn('[SKIP]', {
        pair: `${formatToken(check.tokenIn)} -> ${formatToken(check.tokenOut)}`,
        protocol: check.protocol.name,
        message,
      });
    }
  }

  if (successes === 0) {
    console.error('compareRouterMath finished with no comparable pairs');
    process.exitCode = 1;
    return;
  }

  if (failures > 0) {
    console.error(`compareRouterMath finished with ${failures} mismatches (skipped ${skipped})`);
    process.exitCode = 1;
  } else {
    console.info(`compareRouterMath finished with all pairs within tolerance (skipped ${skipped})`);
  }
}

main().catch((error) => {
  console.error('compareRouterMath failed', error);
  process.exitCode = 1;
});
