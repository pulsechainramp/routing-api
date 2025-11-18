import { JsonRpcProvider } from 'ethers';
import pulsexConfig from '../../src/config/pulsex';
import PulseXStableSwapPoolAbi from '../../src/abis/PulseXStableSwapPool.json';

const provider = new JsonRpcProvider(
  process.env.RPC_URL ?? 'https://rpc.pulsechain.com',
  pulsexConfig.chainId,
);

const stableRouterAddress =
  process.env.PULSEX_STABLE_ROUTER_ADDRESS ??
  '0xDA9aBA4eACF54E0273f56dfFee6B8F1e20B23Bba';

async function main(): Promise<void> {
  const { Contract } = require('ethers');
  const pool = new Contract(
    pulsexConfig.stablePoolAddress,
    PulseXStableSwapPoolAbi,
    provider,
  );
  const amount = 1_000_000n;
  const dy = await pool['get_dy(uint256,uint256,uint256)'](
    1,
    0,
    amount,
    {
      from: stableRouterAddress,
    },
  );
  console.log('get_dy(uint,uint,uint) amountOut=', dy.toString());
}

void main();
