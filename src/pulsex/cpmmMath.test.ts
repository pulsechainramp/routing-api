import { getAmountOutCpmm } from './cpmmMath';

describe('getAmountOutCpmm', () => {
  it('computes an expected output for a balanced pool', () => {
    const amountOut = getAmountOutCpmm(10_000n, 1_000_000n, 2_000_000n, 25);
    expect(amountOut).toBe(19_752n);
  });

  it('returns zero for dust inputs', () => {
    const amountOut = getAmountOutCpmm(1n, 1_000_000_000_000_000_000n, 500_000_000_000_000_000n, 25);
    expect(amountOut).toBe(0n);
  });

  it('throws when reserves are non-positive', () => {
    expect(() => getAmountOutCpmm(1_000n, 0n, 10n, 25)).toThrow('Invalid CPMM reserves');
    expect(() => getAmountOutCpmm(1_000n, 10n, 0n, 25)).toThrow('Invalid CPMM reserves');
  });

  it('throws when fee bps is outside the valid range', () => {
    expect(() => getAmountOutCpmm(1_000n, 1_000n, 1_000n, -5)).toThrow('feeBps must be between 0 and 10_000');
    expect(() => getAmountOutCpmm(1_000n, 1_000n, 1_000n, 10_000)).toThrow('feeBps must be between 0 and 10_000');
  });
});
