export interface UserResponse {
  id: string;
  address: string;
  referralCode: string;
  createdAt: string;
  updatedAt: string;
}

export interface ReferralCodeRequest {
  address: string;
}

export interface ReferralCodeByCodeRequest {
  referralCode: string;
}

export interface ReferralCodeByCodeResponse {
  address: string;
  referralCode: string;
  createdAt: string;
}

export interface ReferralFeeResponse {
  id: string;
  referrer: string;
  token: string;
  amount: string;
  lastUpdated: string;
  createdAt: string;
}

export interface ReferralFeeUpdateEvent {
  referrer: string;
  token: string;
  amount: string;
  blockNumber: number;
  transactionHash: string;
  logIndex: number;
}

export interface IndexingStateResponse {
  id: string;
  indexerName: string;
  lastIndexedBlock: number;
  lastIndexedAt: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
} 