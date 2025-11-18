import { Contract, type Provider } from 'ethers';
import type { Address } from '../types/pulsex';
import { StableThreePoolQuoter } from './StableThreePoolQuoter';

jest.mock('ethers', () => {
  const actual = jest.requireActual('ethers');
  return {
    ...actual,
    Contract: jest.fn(),
  };
});

const mockCoins = jest.fn();
const mockGetDyInt = jest.fn();
const mockGetDyUint = jest.fn();

const contractFactory = () => ({
  coins: mockCoins,
  ['get_dy(int128,int128,uint256)']: mockGetDyInt,
  ['get_dy(uint256,uint256,uint256)']: mockGetDyUint,
});

const CONTRACT_ADDRESS = '0x00000000000000000000000000000000000000aa' as Address;
const STABLE_TOKENS: Address[] = [
  '0x0000000000000000000000000000000000000001' as Address,
  '0x0000000000000000000000000000000000000002' as Address,
  '0x0000000000000000000000000000000000000003' as Address,
];

const withStableCoins = () => {
  mockCoins.mockImplementation((index: number) => {
    if (index < STABLE_TOKENS.length) {
      return Promise.resolve(STABLE_TOKENS[index]);
    }
    return Promise.reject(new Error('index out of range'));
  });
};

const ContractMock = Contract as unknown as jest.Mock;

describe('StableThreePoolQuoter', () => {
  beforeEach(() => {
    mockCoins.mockReset();
    mockGetDyInt.mockReset();
    mockGetDyUint.mockReset();
    ContractMock.mockImplementation(contractFactory);
  });

  afterAll(() => {
    ContractMock.mockReset();
  });

  it('builds the index map once and reuses the cached copy', async () => {
    withStableCoins();
    mockGetDyInt.mockResolvedValue(1_000n);

    const quoter = new StableThreePoolQuoter({} as Provider, CONTRACT_ADDRESS);
    await quoter.quoteStableOut(STABLE_TOKENS[0], STABLE_TOKENS[1], 100n);
    const callsAfterFirstLoad = mockCoins.mock.calls.length;

    await quoter.quoteStableOut(STABLE_TOKENS[1], STABLE_TOKENS[2], 200n);
    expect(mockCoins).toHaveBeenCalledTimes(callsAfterFirstLoad);
  });

  it('falls back to the uint256 get_dy signature when int128 variant fails', async () => {
    withStableCoins();
    mockGetDyInt.mockRejectedValueOnce(new Error('int128 failure'));
    mockGetDyUint.mockResolvedValueOnce(555n);

    const quoter = new StableThreePoolQuoter({} as Provider, CONTRACT_ADDRESS);
    const result = await quoter.quoteStableOut(STABLE_TOKENS[0], STABLE_TOKENS[1], 1_000n);

    expect(result).toBe(555n);
    expect(mockGetDyInt).toHaveBeenCalledTimes(1);
    expect(mockGetDyUint).toHaveBeenCalledTimes(1);
  });

  it('throws when a token is not part of the stable pool', async () => {
    withStableCoins();
    mockGetDyInt.mockResolvedValue(10n);

    const quoter = new StableThreePoolQuoter({} as Provider, CONTRACT_ADDRESS);
    await expect(
      quoter.quoteStableOut('0x00000000000000000000000000000000000000ff' as Address, STABLE_TOKENS[1], 10n),
    ).rejects.toThrow('Token 0x00000000000000000000000000000000000000ff is not supported by the stable pool');
  });

  it('requires valid tokens even when amount is zero', async () => {
    withStableCoins();
    mockGetDyInt.mockResolvedValue(10n);

    const quoter = new StableThreePoolQuoter({} as Provider, CONTRACT_ADDRESS);
    await expect(
      quoter.quoteStableOut('0x00000000000000000000000000000000000000ff' as Address, STABLE_TOKENS[1], 1n),
    ).rejects.toThrow('Token 0x00000000000000000000000000000000000000ff is not supported by the stable pool');
  });

  it('throws for negative input amounts', async () => {
    withStableCoins();
    mockGetDyInt.mockResolvedValue(10n);

    const quoter = new StableThreePoolQuoter({} as Provider, CONTRACT_ADDRESS);
    await expect(quoter.quoteStableOut(STABLE_TOKENS[0], STABLE_TOKENS[1], -1n)).rejects.toThrow(
      'amountIn must be non-negative',
    );
  });

  it('surfaces errors when stable coins cannot be fully discovered without a cache', async () => {
    mockCoins.mockImplementation((index: number) => {
      if (index === 0) {
        return Promise.resolve(STABLE_TOKENS[0]);
      }
      return Promise.reject(new Error('boom'));
    });

    const quoter = new StableThreePoolQuoter({} as Provider, CONTRACT_ADDRESS);
    await expect(quoter.quoteStableOut(STABLE_TOKENS[0], STABLE_TOKENS[1], 100n)).rejects.toThrow(
      'Failed to load stable pool coins: boom',
    );
  });

  it('reuses the previous cache if coin discovery fails but cache exists', async () => {
    withStableCoins();
    mockGetDyInt.mockResolvedValue(1_000n);
    const quoter = new StableThreePoolQuoter({} as Provider, CONTRACT_ADDRESS);
    await quoter.quoteStableOut(STABLE_TOKENS[0], STABLE_TOKENS[1], 100n);

    mockCoins.mockImplementation(() => Promise.reject(new Error('boom')));
    mockGetDyInt.mockResolvedValueOnce(2_000n);

    await expect(quoter.quoteStableOut(STABLE_TOKENS[1], STABLE_TOKENS[2], 200n)).resolves.toBe(2_000n);
  });

  it('exposes helpers for index map retrieval and token validation', async () => {
    withStableCoins();
    const quoter = new StableThreePoolQuoter({} as Provider, CONTRACT_ADDRESS);

    const indexMap = await quoter.getIndexMap();
    expect(indexMap.size).toBe(3);
    expect(indexMap.get(STABLE_TOKENS[0])).toBe(0);
    expect(indexMap.get(STABLE_TOKENS[1])).toBe(1);

    // Mutating the returned map should not affect the internal cache
    indexMap.clear();

    await expect(quoter.isTokenSupported(STABLE_TOKENS[2])).resolves.toBe(true);
    await expect(
      quoter.isTokenSupported('0x00000000000000000000000000000000000000ff' as Address),
    ).resolves.toBe(false);
  });
  it('quotes directly by indices without re-resolving token addresses', async () => {
    withStableCoins();
    mockGetDyInt.mockResolvedValue(123n);

    const quoter = new StableThreePoolQuoter({} as Provider, CONTRACT_ADDRESS);
    await expect(quoter.quoteStableOutByIndices(0, 1, 1_000n)).resolves.toBe(123n);
    expect(mockCoins).not.toHaveBeenCalled();
  });

  it('short-circuits index-based quotes when indices are equal', async () => {
    withStableCoins();
    const quoter = new StableThreePoolQuoter({} as Provider, CONTRACT_ADDRESS);
    await expect(quoter.quoteStableOutByIndices(1, 1, 500n)).resolves.toBe(500n);
    expect(mockGetDyInt).not.toHaveBeenCalled();
  });
});
