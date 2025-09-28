import { FastifyInstance } from 'fastify';
import { ethers } from 'ethers';
import config from '../config';
import { FallbackQuoterService } from '../services/FallbackQuoterService';
import { PathToken } from '../types/Quote';

function norm(addr: string): string {
  if (!addr) throw new Error('missing address');
  // Accept "PLS" sentinel → use WPLS on-chain address
  if (addr.toUpperCase() === 'PLS') return ethers.getAddress(config.WPLS);
  return ethers.getAddress(addr);
}

function decimalsOf(addr: string): number {
  const a = addr.toLowerCase();
  if (a === String(config.USDC).toLowerCase()) return 6;
  if (a === String(config.USDT).toLowerCase()) return 6;
  // WPLS & DAI & most others
  return 18;
}

export default async function pulsexQuotePlugin(fastify: FastifyInstance) {
  const quoter = new FallbackQuoterService();

  fastify.get(
    '/pulsex',
    async (req, reply) => {
      try {
        const q = req.query as {
          tokenInAddress: string;
          tokenOutAddress: string;
          amount: string;               // base units
          allowedSlippage?: string;     // e.g. "0.5" = 0.5%
        };

        const tokenIn  = norm(q.tokenInAddress);
        const tokenOut = norm(q.tokenOutAddress);
        const amountInWei = BigInt(q.amount);

        const tokenInMeta: PathToken = {
          address: tokenIn,
          symbol: '',
          decimals: decimalsOf(tokenIn),
          chainId: 369
        };
        const tokenOutMeta: PathToken = {
          address: tokenOut,
          symbol: '',
          decimals: decimalsOf(tokenOut),
          chainId: 369
        };

        const best = await quoter.quoteBestExactIn(
          tokenIn,
          tokenOut,
          amountInWei,
          tokenInMeta,
          tokenOutMeta
        );

        if (!best.success) {
          return reply.send({
            calldata: '0x',
            tokenInAddress: tokenIn,
            tokenOutAddress: tokenOut,
            outputAmount: '0',
            gasAmountEstimated: 0,
            gasUSDEstimated: 0,
            route: [],
            source: 'pulsex'
          });
        }

        return reply.send({
          calldata: best.routeBytes,
          tokenInAddress: tokenIn,
          tokenOutAddress: tokenOut,
          outputAmount: best.destAmount.toString(),
          gasAmountEstimated: best.gasAmountEstimated,
          gasUSDEstimated: best.gasUSDEstimated,
          route: best.combinedRoute,
          source: 'pulsex'
        });
      } catch (e: any) {
        req.log.error(e, 'pulsex quote failed');
        reply.code(500);
        return reply.send({ error: e?.message || String(e) });
      }
    }
  );
}
