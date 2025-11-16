const FEE_BPS_DENOMINATOR = 10_000n;

export function getAmountOutCpmm(
  amountIn: bigint,
  reserveIn: bigint,
  reserveOut: bigint,
  feeBps: number,
): bigint {
  if (amountIn <= 0n) {
    return 0n;
  }

  if (reserveIn <= 0n || reserveOut <= 0n) {
    throw new Error('Invalid CPMM reserves');
  }

  if (!Number.isFinite(feeBps) || feeBps < 0 || feeBps >= Number(FEE_BPS_DENOMINATOR)) {
    throw new Error('feeBps must be between 0 and 10_000');
  }

  const feeBpsBigInt = BigInt(Math.floor(feeBps));
  const feeAdjusted = FEE_BPS_DENOMINATOR - feeBpsBigInt;
  const amountInWithFee = amountIn * feeAdjusted;
  const numerator = amountInWithFee * reserveOut;
  const denominator = reserveIn * FEE_BPS_DENOMINATOR + amountInWithFee;

  return numerator / denominator;
}
