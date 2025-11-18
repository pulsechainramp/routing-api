export type Address = `0x${string}`;

export interface PulsexToken {
  address: Address;
  decimals: number;
  symbol?: string;
  name?: string;
  isNative?: boolean;
}

export type PulsexProtocol = 'PULSEX_V1' | 'PULSEX_V2' | 'PULSEX_STABLE';

export interface ExactInQuoteRequest {
  chainId: number;
  tokenIn: PulsexToken;
  tokenOut: PulsexToken;
  amountIn: bigint;
  slippageBps: number;
  recipient: Address;
  deadlineSeconds?: number;
}

export interface RouteLegSummary {
  protocol: PulsexProtocol;
  tokenIn: PulsexToken;
  tokenOut: PulsexToken;
  poolAddress: Address;
  userData: string;
}

export interface SplitRouteMeta {
  shareBps: number;
  amountIn: bigint;
  amountOut: bigint;
  legs: RouteLegSummary[];
}

export interface PulsexQuoteResult {
  request: ExactInQuoteRequest;
  totalAmountOut: bigint;
  routerAddress: Address;
  singleRoute?: RouteLegSummary[];
  splitRoutes?: SplitRouteMeta[];
  calldata?: string;
  value?: bigint;
  gasEstimate?: bigint;
  gasPLSWei?: bigint;
  gasPLSFormatted?: string;
  gasUsd?: number;
}
