export interface Currency {
  ticker: string;
  name: string;
  image: string;
  hasExternalId: boolean;
  isExtraIdSupported: boolean;
  isFiat: boolean;
  featured: boolean;
  isStable: boolean;
  supportsFixedRate: boolean;
  network: string;
  tokenContract: string | null;
  buy: boolean;
  sell: boolean;
  legacyTicker: string;
}

export interface ExchangeRange {
  fromCurrency: string;
  fromNetwork: string;
  toCurrency: string;
  toNetwork: string;
  flow: string;
  minAmount: number;
  maxAmount: number | null;
}

export interface EstimateResponse {
  fromCurrency: string;
  fromNetwork: string;
  toCurrency: string;
  toNetwork: string;
  flow: string;
  type: string;
  rateId: string | null;
  validUntil: string | null;
  transactionSpeedForecast: string | null;
  warningMessage: string | null;
  fromAmount: number;
  toAmount: number;
  depositFee: number;
  withdrawalFee: number;
  userId: number | null;
}

export interface TransactionResponse {
  id: string;
  fromAmount: number;
  toAmount: number;
  flow: string;
  type: string;
  payinAddress: string;
  payoutAddress: string;
  payinExtraId: string | null;
  payoutExtraId: string | null;
  fromCurrency: string;
  fromNetwork: string;
  toCurrency: string;
  toNetwork: string;
  refundAddress: string | null;
  refundExtraId: string | null;
  rateId: string | null;
}

export interface TransactionStatus {
  id: string;
  status: string;
  actionsAvailable: boolean;
  fromCurrency: string;
  fromNetwork: string;
  toCurrency: string;
  toNetwork: string;
  expectedAmountFrom: number | null;
  expectedAmountTo: number | null;
  amountFrom: number | null;
  amountTo: number | null;
  payinAddress: string;
  payoutAddress: string;
  payinExtraId: string | null;
  payoutExtraId: string | null;
  refundAddress: string | null;
  refundExtraId: string | null;
  createdAt: string;
  updatedAt: string;
  depositReceivedAt: string | null;
  payinHash: string | null;
  payoutHash: string | null;
  fromLegacyTicker: string;
  toLegacyTicker: string;
  refundHash: string | null;
  refundAmount: number | null;
  userId: number | null;
  validUntil: string | null;
  relatedExchangesInfo: any[] | null;
  repeatedExchangesInfo: any[] | null;
  originalExchangeInfo: any | null;
}

export interface CreateTransactionParams {
  fromCurrency: string;
  fromNetwork: string;
  toNetwork: string;
  toCurrency: string;
  fromAmount: string;
  address: string;
  extraId?: string;
  refundAddress?: string;
  refundExtraId?: string;
  flow?: 'standard' | 'fixed-rate';
  rateId?: string;
}

export interface EstimateParams {
  fromCurrency: string;
  toCurrency: string;
  fromAmount?: number;
  toAmount?: number;
  fromNetwork?: string;
  toNetwork?: string;
  flow?: 'standard' | 'fixed-rate';
  type?: 'direct' | 'reverse';
  useRateId?: boolean;
} 