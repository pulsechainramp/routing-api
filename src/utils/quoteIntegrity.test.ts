import { AbiCoder, getBytes, keccak256, verifyMessage, Wallet } from 'ethers';
import config from '../config';
import { QuoteResponse } from '../types/QuoteResponse';

const TEST_PRIVATE_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

const PAYLOAD_TYPES = [
  'uint8',
  'address',
  'address',
  'address',
  'uint256',
  'uint256',
  'uint256',
  'bytes32',
  'uint256',
  'uint32',
] as const;

describe('quoteIntegrity', () => {
  beforeEach(() => {
    process.env.QUOTE_SIGNING_PRIVATE_KEY = TEST_PRIVATE_KEY;
    delete process.env.QUOTE_SIGNER_ADDRESS;
    // Reset the module cache to force signer re-resolution per test
    jest.resetModules();
  });

  const buildQuote = (): QuoteResponse => ({
    calldata: '0x1234',
    tokenInAddress: '0x1111111111111111111111111111111111111111',
    tokenOutAddress: '0x2222222222222222222222222222222222222222',
    amountIn: '1000000000000000000',
    minAmountOut: '950000000000000000',
    outputAmount: '1000000000000000000',
    deadline: Math.floor(Date.now() / 1000) + 600,
    gasAmountEstimated: 250000,
    gasUSDEstimated: 2.5,
    route: [],
  });

  it('builds a deterministic payload', async () => {
    const { buildIntegrityPayload: buildPayload } = await import('./quoteIntegrity');
    const quote = buildQuote();
    const payload = buildPayload(quote, { allowedSlippage: 0.5 });

    expect(payload.router.toLowerCase()).toBe(config.AffiliateRouterAddress.toLowerCase());
    expect(payload.tokenIn).toBe(quote.tokenInAddress);
    expect(payload.tokenOut).toBe(quote.tokenOutAddress);
    expect(payload.calldataHash).toBe(keccak256(quote.calldata));
    expect(payload.version).toBeGreaterThan(0);
    expect(payload.slippageBps).toBe(50);
  });

  it('signs the payload with the configured key', async () => {
    const wallet = new Wallet(TEST_PRIVATE_KEY);
    const { signQuoteResponse: signQuote } = await import('./quoteIntegrity');
    const quote = buildQuote();
    const signed = await signQuote(quote, { allowedSlippage: 1.25 });

    expect(signed.integrity.signer).toBe(wallet.address);

    const payload = signed.integrity.payload;
    const abiCoder = new AbiCoder();
    const encoded = abiCoder.encode(PAYLOAD_TYPES, [
      payload.version,
      payload.router,
      payload.tokenIn,
      payload.tokenOut,
      payload.amountIn,
      payload.minAmountOut,
      payload.deadline,
      payload.calldataHash,
      payload.issuedAt,
      payload.slippageBps,
    ]);
    const digest = keccak256(encoded);
    const actual = verifyMessage(getBytes(digest), signed.integrity.signature).toLowerCase();
    expect(actual).toBe(wallet.address.toLowerCase());
  });
});
