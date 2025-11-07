import { AbiCoder, ParamType } from 'ethers';

const abiCoder = new AbiCoder();

const SWAP_ROUTE_ABI = [
  ParamType.from({
    name: 'SwapRoute',
    type: 'tuple',
    components: [
      {
        name: 'steps',
        type: 'tuple[]',
        components: [
          { name: 'dex', type: 'string' },
          { name: 'path', type: 'address[]' },
          { name: 'pool', type: 'address' },
          { name: 'percent', type: 'uint256' },
          { name: 'groupId', type: 'uint256' },
          { name: 'parentGroupId', type: 'uint256' },
          { name: 'userData', type: 'bytes' },
        ],
      },
      {
        name: 'parentGroups',
        type: 'tuple[]',
        components: [
          { name: 'id', type: 'uint256' },
          { name: 'percent', type: 'uint256' },
        ],
      },
      { name: 'destination', type: 'address' },
      { name: 'tokenIn', type: 'address' },
      { name: 'tokenOut', type: 'address' },
      { name: 'groupCount', type: 'uint256' },
      { name: 'deadline', type: 'uint256' },
      { name: 'amountIn', type: 'uint256' },
      { name: 'amountOutMin', type: 'uint256' },
      { name: 'isETHOut', type: 'bool' },
    ],
  }),
];

export interface SwapRouteSummary {
  tokenIn: string;
  tokenOut: string;
  amountIn: bigint;
  amountOutMin: bigint;
  deadline: bigint;
  destination: string;
  isETHOut: boolean;
}

export const decodeSwapRouteSummary = (routeBytes: string): SwapRouteSummary => {
  if (!routeBytes) {
    throw new Error('Route calldata is required');
  }

  const [route] = (abiCoder.decode(SWAP_ROUTE_ABI, routeBytes) as unknown) as [
    {
      tokenIn: string;
      tokenOut: string;
      amountIn: bigint;
      amountOutMin: bigint;
      deadline: bigint;
      destination: string;
      isETHOut: boolean;
    }
  ];

  return {
    tokenIn: route.tokenIn,
    tokenOut: route.tokenOut,
    amountIn: BigInt(route.amountIn),
    amountOutMin: BigInt(route.amountOutMin),
    deadline: BigInt(route.deadline),
    destination: route.destination,
    isETHOut: Boolean(route.isETHOut),
  };
};
