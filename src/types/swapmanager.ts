export interface SwapStep {
  dex: string;
  path: string[];
  pool: string;
  percent: number;
  groupId: number;
  parentGroupId: number;
  userData: string;
}

export interface Group {
  id: number;
  percent: number;
}

export interface SwapRoute {
  steps: SwapStep[];
  parentGroups: Group[];
  destination: string;
  tokenIn: string;
  tokenOut: string;
  groupCount: number;
  deadline: number;
  amountIn: string;
  amountOutMin: string;
}