import pulsexConfig from '../config/pulsex';
import { getAmountOutCpmm } from './cpmmMath';

describe('getAmountOutCpmm', () => {
  it('computes an expected output for a balanced pool', () => {
    const amountOut = getAmountOutCpmm(
      10_000n,
      1_000_000n,
      2_000_000n,
      pulsexConfig.fees.v2FeeBps,
    );
    expect(amountOut).toBe(19_745n);
  });

  it('returns zero for dust inputs', () => {
    const amountOut = getAmountOutCpmm(
      1n,
      1_000_000_000_000_000_000n,
      500_000_000_000_000_000n,
      pulsexConfig.fees.v2FeeBps,
    );
    expect(amountOut).toBe(0n);
  });

  it('throws when reserves are non-positive', () => {
    expect(() => getAmountOutCpmm(1_000n, 0n, 10n, pulsexConfig.fees.v2FeeBps)).toThrow('Invalid CPMM reserves');
    expect(() => getAmountOutCpmm(1_000n, 10n, 0n, pulsexConfig.fees.v2FeeBps)).toThrow('Invalid CPMM reserves');
  });

  it('throws when fee bps is outside the valid range', () => {
    expect(() => getAmountOutCpmm(1_000n, 1_000n, 1_000n, -5)).toThrow('feeBps must be between 0 and 10_000');
    expect(() => getAmountOutCpmm(1_000n, 1_000n, 1_000n, 10_000)).toThrow('feeBps must be between 0 and 10_000');
  });

  it('matches a pinned PulseX V2 getAmountsOut fixture with current fee configuration', () => {
    const amountOut = getAmountOutCpmm(
      1_000_000n,
      1_000_000_000n,
      2_000_000_000n,
      pulsexConfig.fees.v2FeeBps,
    );
    expect(amountOut).toBe(1_992_213n);
  });

  it('keeps configured fees within valid router-derived bounds', () => {
    expect(pulsexConfig.fees.v1FeeBps).toBeGreaterThanOrEqual(0);
    expect(pulsexConfig.fees.v1FeeBps).toBeLessThanOrEqual(10_000);
    expect(pulsexConfig.fees.v2FeeBps).toBeGreaterThanOrEqual(0);
    expect(pulsexConfig.fees.v2FeeBps).toBeLessThanOrEqual(10_000);
  });
});
