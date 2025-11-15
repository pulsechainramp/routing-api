export type PathToken = {
  address: string;
  symbol: string;
  decimals: number;
  chainId: number;
};

export type PathInfo = {
  percent: number;
  address: string;
  exchange: string;
};

export type Subswap = {
  percent: number;
  paths: PathInfo[];
};

export type Swap = {
  percent: number;
  subswaps: Subswap[];
};

export type Route = {
  paths: PathToken[][];
  swaps: Swap[];
};

export type CombinedPath = Omit<PathInfo, "address"> & {
  pool?: string;
  tokens: PathToken[];
};

export type CombinedSubswap = {
  percent: number;
  paths: CombinedPath[];
};

export type CombinedSwap = {
  percent: number;
  subroutes: CombinedSubswap[];
};

export type CombinedRoute = CombinedSwap[];
