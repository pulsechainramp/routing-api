import { CombinedRoute } from './Quote';

export interface QuoteResponse {
  calldata: string;
  tokenInAddress: string;
  tokenOutAddress: string;
  amountIn: string;
  minAmountOut: string;
  outputAmount: string;
  deadline: number;
  gasAmountEstimated: number;
  gasUSDEstimated: number;
  route: CombinedRoute;
}

export interface QuoteIntegrityPayload {
  version: number;
  router: string;
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  minAmountOut: string;
  deadline: number;
  calldataHash: string;
  issuedAt: number;
  slippageBps: number;
}

export interface SignedQuoteIntegrity {
  payload: QuoteIntegrityPayload;
  signature: string;
  signer: string;
}

export type SignedQuoteResponse = QuoteResponse & {
  integrity: SignedQuoteIntegrity;
};
