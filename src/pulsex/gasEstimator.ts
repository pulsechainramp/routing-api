import { ethers, formatEther, type Provider } from 'ethers';
import type { PulsexConfig } from '../config/pulsex';

const FALLBACK_GAS_PRICE = 1_000_000_000n; // 1 gwei

export interface GasEstimateResult {
  gasUnits: bigint;
  gasCostWei: bigint;
  gasCostPlsFormatted: string;
  gasUsd: number;
}

export class PulsexGasEstimator {
  constructor(
    private readonly provider: Provider,
    private readonly config: PulsexConfig,
  ) {}

  public async estimateRouteGas(
    totalLegs: number,
    priceUsdPerPls: number,
  ): Promise<GasEstimateResult> {
    const baseUnits = this.config.gasConfig.baseGasUnits;
    const perLegUnits = this.config.gasConfig.gasPerLegUnits;
    const totalUnits = baseUnits + Math.max(totalLegs, 0) * perLegUnits;
    const gasUnits = BigInt(totalUnits);

    const feeData = await this.provider.getFeeData();
    const gasPrice =
      feeData.gasPrice ??
      feeData.maxFeePerGas ??
      feeData.maxPriorityFeePerGas ??
      FALLBACK_GAS_PRICE;

    const gasCostWei = gasUnits * gasPrice;
    const gasPlsFormatted = formatEther(gasCostWei);
    const gasUsd = Number(gasPlsFormatted) * priceUsdPerPls;

    return {
      gasUnits,
      gasCostWei,
      gasCostPlsFormatted: gasPlsFormatted,
      gasUsd,
    };
  }
}
