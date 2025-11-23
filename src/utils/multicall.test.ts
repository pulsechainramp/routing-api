import { Contract, type Provider } from 'ethers';
import { MulticallClient, type MulticallCall, type MulticallResult } from './multicall';
import { Logger } from './logger';

jest.mock('ethers', () => {
  const actual = jest.requireActual('ethers');
  return {
    ...actual,
    Contract: jest.fn(),
  };
});

const mockExecute = (responses: MulticallResult[] | Error, callCount?: { count: number }) => {
  (Contract as unknown as jest.Mock).mockImplementation(() => ({
    multicall: jest.fn().mockImplementation(async (calls: MulticallCall[]) => {
      if (callCount) {
        callCount.count += calls.length;
      }
      if (responses instanceof Error) {
        throw responses;
      }
      return responses;
    }),
  }));
};

describe('MulticallClient', () => {
  const provider = {} as Provider;
  const logger = new Logger('test');
  const baseConfig = {
    address: '0x0000000000000000000000000000000000000001',
    enabled: true,
    maxBatchSize: 2,
    timeoutMs: 50,
  } as const;

  beforeEach(() => {
    (Contract as unknown as jest.Mock).mockReset();
  });

  it('batches calls by maxBatchSize and returns normalized results', async () => {
    const counter = { count: 0 };
    mockExecute(
      [
        { success: true, returnData: '0x01' },
        { success: false, returnData: '' },
      ],
      counter,
    );
    const client = new MulticallClient(provider, baseConfig, logger);

    const results = await client.execute([
      { target: baseConfig.address, callData: '0xaaa' },
      { target: baseConfig.address, callData: '0xbbb' },
    ]);

    expect(results).toEqual([
      { success: true, returnData: '0x01' },
      { success: false, returnData: '' },
    ]);
    expect(counter.count).toBe(2);
  });

  it('returns empty array when no calls are provided', async () => {
    mockExecute([], undefined);
    const client = new MulticallClient(provider, baseConfig, logger);
    const results = await client.execute([]);
    expect(results).toEqual([]);
  });

  it('throws when multicall is disabled', async () => {
    const client = new MulticallClient(provider, { ...baseConfig, enabled: false }, logger);
    await expect(
      client.execute([{ target: baseConfig.address, callData: '0x' }]),
    ).rejects.toThrow('Multicall is disabled');
  });

  it('propagates timeout errors from chunks', async () => {
    mockExecute(new Error('boom'));
    const client = new MulticallClient(provider, baseConfig, logger);
    await expect(
      client.execute([{ target: baseConfig.address, callData: '0x' }]),
    ).rejects.toThrow('Multicall returned an empty result set');
  });
});
