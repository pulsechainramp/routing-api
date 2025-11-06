import { OmniBridgeService } from './OmniBridgeService';
import { OmniBridgeCurrency } from '../types/omnibridge';

describe('OmniBridgeService fee math', () => {
  const pulseToken: OmniBridgeCurrency = {
    name: 'Pulse Token',
    symbol: 'PLS',
    decimals: 18,
    address: '0x0000000000000000000000000000000000000001',
    chainId: 369,
    logoURI: '',
    tags: [],
    network: 'pulsechain'
  };

  const mockSupportedCurrencies = (
    service: OmniBridgeService,
    currencies: OmniBridgeCurrency[]
  ) => {
    jest.spyOn(service as any, 'getSupportedCurrencies').mockResolvedValue(currencies);
  };

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('handles 1 wei PulseChain inputs without scientific notation errors', async () => {
    const service = new OmniBridgeService();
    mockSupportedCurrencies(service, [pulseToken]);

    const response = await service.getEstimatedAmount({
      tokenAddress: pulseToken.address,
      networkId: pulseToken.chainId,
      amount: '1'
    });

    expect(response.isSupported).toBe(true);
    expect(response.fee).toBe('0');
    expect(response.estimatedAmount).toBe('1');
  });

  it('returns exact values for very large amounts', async () => {
    const service = new OmniBridgeService();
    mockSupportedCurrencies(service, [pulseToken]);

    const amount = '1000000000000000000000000';
    const response = await service.getEstimatedAmount({
      tokenAddress: pulseToken.address,
      networkId: pulseToken.chainId,
      amount
    });

    const amountBigInt = BigInt(amount);
    const expectedFee = (amountBigInt * 30n) / 10000n;
    const expectedEstimatedAmount = amountBigInt - expectedFee;

    expect(response.fee).toBe(expectedFee.toString());
    expect(response.estimatedAmount).toBe(expectedEstimatedAmount.toString());
  });
});
