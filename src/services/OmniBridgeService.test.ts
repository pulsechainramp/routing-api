import { OmniBridgeService } from './OmniBridgeService';
import { OmniBridgeCurrency } from '../types/omnibridge';

describe('OmniBridgeService fee math', () => {
  const ethWeth: OmniBridgeCurrency = {
    name: 'Wrapped Ether',
    symbol: 'WETH',
    decimals: 18,
    address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
    chainId: 1,
    logoURI: '',
    tags: ['verified'],
    network: 'ethereum',
  };

  const pulseWethFromEthereum: OmniBridgeCurrency = {
    name: 'Wrapped Ether from Ethereum',
    symbol: 'WETH from Ethereum',
    decimals: 18,
    address: '0x02DcdD04e3F455D838cd1249292C58f3B79e3C3C',
    chainId: 369,
    logoURI: '',
    tags: ['verified'],
    network: 'pulsechain',
  };

  const pulseNative: OmniBridgeCurrency = {
    name: 'Pulse',
    symbol: 'PLS',
    decimals: 18,
    address: '0x0000000000000000000000000000000000000000',
    chainId: 369,
    logoURI: '',
    tags: ['verified'],
    network: 'pulsechain',
  };

  const ethWrappedPlsPrimary: OmniBridgeCurrency = {
    name: 'Wrapped PLS from PulseChain',
    symbol: 'WPLS from PulseChain',
    decimals: 18,
    address: '0xA882606494D86804B5514E07e6Bd2D6a6eE6d68A',
    chainId: 1,
    logoURI: '',
    tags: ['verified'],
    network: 'ethereum',
  };

  const ethWrappedPlsSecondary: OmniBridgeCurrency = {
    ...ethWrappedPlsPrimary,
    address: '0x97Ac4a2439A47c07ad535bb1188c989dae755341',
  };

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

  it('marks unsupported when no counterpart exists on targetChainId', async () => {
    const service = new OmniBridgeService();
    mockSupportedCurrencies(service, [pulseToken]);

    const response = await service.getEstimatedAmount({
      tokenAddress: pulseToken.address,
      networkId: pulseToken.chainId,
      amount: '100',
      targetChainId: 1
    });

    expect(response.isSupported).toBe(false);
    expect(response.estimatedAmount).toBe('0');
  });

  it('allows bridging when counterpart exists on targetChainId', async () => {
    const service = new OmniBridgeService();
    mockSupportedCurrencies(service, [ethWeth, pulseWethFromEthereum]);

    const response = await service.getEstimatedAmount({
      tokenAddress: ethWeth.address,
      networkId: ethWeth.chainId,
      amount: '100',
      targetChainId: 369
    });

    expect(response.isSupported).toBe(true);
    expect(response.estimatedAmount).not.toBe('0');
  });

  it('rejects duplicate-symbol targets when mapped counterpart address is missing', async () => {
    const service = new OmniBridgeService();
    const wrongPulseWeth: OmniBridgeCurrency = {
      ...pulseWethFromEthereum,
      address: '0x1111111111111111111111111111111111111111',
    };

    mockSupportedCurrencies(service, [ethWeth, wrongPulseWeth]);

    const response = await service.getEstimatedAmount({
      tokenAddress: ethWeth.address,
      networkId: ethWeth.chainId,
      amount: '100',
      targetChainId: 369,
    });

    expect(response.isSupported).toBe(false);
    expect(response.estimatedAmount).toBe('0');
  });

  it('accepts target when explicit mapped counterpart address exists among duplicates', async () => {
    const service = new OmniBridgeService();
    const wrongPulseWeth: OmniBridgeCurrency = {
      ...pulseWethFromEthereum,
      address: '0x1111111111111111111111111111111111111111',
    };

    mockSupportedCurrencies(service, [ethWeth, wrongPulseWeth, pulseWethFromEthereum]);

    const response = await service.getEstimatedAmount({
      tokenAddress: ethWeth.address,
      networkId: ethWeth.chainId,
      amount: '100',
      targetChainId: 369,
    });

    expect(response.isSupported).toBe(true);
    expect(response.estimatedAmount).not.toBe('0');
  });

  it('supports secondary mapped counterpart when first mapped counterpart is absent', async () => {
    const service = new OmniBridgeService();
    // PLS has multiple mapped counterparts on Ethereum; only the secondary one exists here.
    mockSupportedCurrencies(service, [pulseNative, ethWrappedPlsSecondary]);

    const response = await service.getEstimatedAmount({
      tokenAddress: pulseNative.address,
      networkId: pulseNative.chainId,
      amount: '100',
      targetChainId: 1,
    });

    expect(response.isSupported).toBe(true);
    expect(response.estimatedAmount).not.toBe('0');
  });

  it('returns unsupported when none of mapped counterparts are present on target', async () => {
    const service = new OmniBridgeService();
    mockSupportedCurrencies(service, [pulseNative, ethWeth]);

    const response = await service.getEstimatedAmount({
      tokenAddress: pulseNative.address,
      networkId: pulseNative.chainId,
      amount: '100',
      targetChainId: 1,
    });

    expect(response.isSupported).toBe(false);
    expect(response.estimatedAmount).toBe('0');
  });
});
