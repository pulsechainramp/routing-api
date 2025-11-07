import { CombinedRoute } from './Quote';
import { SignedQuoteIntegrity } from './QuoteResponse';

export interface UnsignedQuotePayload {
  calldata: string;
  tokenInAddress: string;
  tokenOutAddress: string;
  outputAmount: string;
  gasUSDEstimated: number;
  gasAmountEstimated?: number;
  route: CombinedRoute;
}

export interface QuoteAttestationContext {
  tokenInAddress: string;
  tokenOutAddress: string;
  amountInWei: string;
  minAmountOutWei: string;
  slippageBps: number;
  recipient: string;
  routerAddress: string;
  chainId: number;
  referrerAddress?: string;
}

export interface QuoteAttestationRequest {
  quote: UnsignedQuotePayload;
  context: QuoteAttestationContext;
}

export interface QuoteAttestationResponse {
  integrity: SignedQuoteIntegrity;
}
