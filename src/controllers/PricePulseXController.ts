import fp from 'fastify-plugin';
import { FastifyInstance } from 'fastify';
import { FallbackQuoterService } from '../services/FallbackQuoterService';
import config from '../config';
import { PathToken } from '../types/Quote';
import { ethers } from 'ethers';
import ERC20 from '../abis/ERC20.json';

type Qs = {
  tokenAddress: string;           // token to price
  quoteToken?: 'USDC' | 'DAI';    // default USDC
  scale?: string;                 // optional, default "1"
  precision?: string;             // optional, default "18"
};

const decimalsCache = new Map<string, number>();

async function getDecimals(addr: string, provider: ethers.Provider): Promise<number> {
  const key = (addr || '').toLowerCase();
  if (key === String(config.WPLS).toLowerCase()) return 18;
  if (key === String(config.USDC).toLowerCase()) return 6;
  if (key === String(config.DAI ).toLowerCase()) return 18;
  if (decimalsCache.has(key)) return decimalsCache.get(key)!;

  try {
    const c = new ethers.Contract(addr, ERC20, provider);
    const d = Number(await c.decimals());
    if (!Number.isFinite(d) || d < 0 || d > 36) throw new Error('bad decimals');
    decimalsCache.set(key, d);
    return d;
  } catch {
    // Best-effort fallback for odd tokens
    decimalsCache.set(key, 18);
    return 18;
  }
}

function formatScaled(numer: bigint, denom: bigint, precision: number): string {
  if (denom === 0n) return '0';
  const scale = 10n ** BigInt(precision);
  const scaled = (numer * scale) / denom;           // integer division
  const s = scaled.toString().padStart(precision + 1, '0');
  const i = s.slice(0, -precision);
  const f = s.slice(-precision);
  return `${i}.${f}`;
}

export default fp(async function pricePulsexPlugin(app: FastifyInstance) {
  const svc = new FallbackQuoterService();
  const provider = new ethers.JsonRpcProvider(process.env.RPC_URL || 'https://rpc.pulsechain.com');

  app.get<{ Querystring: Qs }>('/price/pulsex', async (req, reply) => {
    try {
      const { tokenAddress } = req.query;
      let { quoteToken = 'USDC', scale = '1', precision = '18' } = req.query;

      if (!tokenAddress || !ethers.isAddress(tokenAddress)) {
        return reply.code(400).send({ error: 'INVALID_TOKEN' });
      }
      if (quoteToken !== 'USDC' && quoteToken !== 'DAI') {
        quoteToken = 'USDC';
      }

      // Parse and clamp scale/precision
      let scaleBn: bigint;
      try {
        scaleBn = BigInt(scale);
        if (scaleBn < 1n) scaleBn = 1n;
        if (scaleBn > 1_000_000n) scaleBn = 1_000_000n; // safety cap
      } catch {
        scaleBn = 1n;
      }
      let prec = parseInt(precision, 10);
      if (!Number.isFinite(prec)) prec = 18;
      prec = Math.min(Math.max(prec, 6), 30);

      const inDec  = await getDecimals(tokenAddress, provider);
      const outDec = quoteToken === 'USDC' ? 6 : 18;
      const outAddr = quoteToken === 'USDC' ? config.USDC : config.DAI;

      // amountIn = (1 token) * scale, in base units of tokenAddress
      const amountIn = (10n ** BigInt(inDec)) * scaleBn;

      const inMeta:  PathToken = { address: tokenAddress, symbol: '', decimals: inDec,  chainId: 369 };
      const outMeta: PathToken = { address: outAddr,     symbol: quoteToken, decimals: outDec, chainId: 369 };

      const res = await svc.quoteBestExactIn(tokenAddress, outAddr, amountIn, inMeta, outMeta);
      if (!res?.success) {
        return reply.code(422).send({ error: 'NO_ROUTE' });
      }

      const out = BigInt(res.destAmount ?? 0n); // quote result in quoteToken base units
      if (out <= 0n) {
        return reply.code(422).send({ error: 'NO_LIQUID_ROUTE' });
      }

      // price = out / (10^outDec * scale)
      const denom = (10n ** BigInt(outDec)) * scaleBn;
      const usd_price_str = formatScaled(out, denom, prec);
      const usd_price = Number(usd_price_str); // convenience number (rounded by JS)

      return reply.send({
        token: tokenAddress,
        quoteToken,
        usd_price,
        usd_price_str,
        scale: scaleBn.toString(),
        precision: prec
      });
    } catch (e: any) {
      req.log.error({ err: e }, 'PRICE_PULSEX_ERROR');
      return reply.code(500).send({ error: 'PRICE_PULSEX_ERROR', detail: e?.message });
    }
  });
});
