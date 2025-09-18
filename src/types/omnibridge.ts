export interface OmniBridgeToken {
  name: string;
  chainId: number;
  symbol: string;
  decimals: number;
  address: string;
  logoURI: string;
  tags: string[];
}

export interface OmniBridgeTokenList {
  name: string;
  version: {
    major: number;
    minor: number;
    patch: number;
  };
  keywords: string[];
  logoURI: string;
  timestamp: string;
  tags: {
    [key: string]: {
      name: string;
      description: string;
    };
  };
  tokens: OmniBridgeToken[];
}

export interface OmniBridgeCurrency {
  name: string;
  symbol: string;
  decimals: number;
  address: string;
  chainId: number;
  logoURI: string;
  tags: string[];
  network: string;
}

export interface OmniBridgeEstimateParams {
  tokenAddress: string;
  networkId: number;
  amount?: string;
}

export interface OmniBridgeEstimateResponse {
  tokenAddress: string;
  networkId: number;
  amount: string;
  estimatedAmount: string;
  fee: string;
  feePercentage: number;
  isSupported: boolean;
}

// GraphQL Response Types
export interface OmniBridgeRequest {
  user: string | null;
  txHash: string;
  messageId: string;
  timestamp: string;
  amount: string;
  token: string;
  decimals: number;
  symbol: string;
  encodedData: string;
  message: {
    txHash: string;
    messageId: string;
    messageData: string | null;
    signatures: string | null;
  };
}

export interface OmniBridgeExecution {
  txHash: string;
  messageId: string;
  token: string;
  status: boolean;
}

export interface OmniBridgeGraphQLResponse<T> {
  data: T;
}

export interface OmniBridgeRequestsResponse {
  requests: OmniBridgeRequest[];
}

export interface OmniBridgeExecutionsResponse {
  executions: OmniBridgeExecution[];
}

// Database Types
export interface OmniBridgeTransactionCreate {
  messageId: string;
  userAddress: string;
  sourceChainId: number;
  targetChainId: number;
  sourceTxHash: string;
  tokenAddress: string;
  tokenSymbol: string;
  tokenDecimals: number;
  amount: string; // Store as string to handle large wei amounts
  sourceTimestamp: Date;
  encodedData?: string;
}

export interface OmniBridgeTransactionUpdate {
  targetTxHash?: string;
  status?: string;
  targetTimestamp?: Date;
} 