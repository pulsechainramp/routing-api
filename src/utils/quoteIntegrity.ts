import { AbiCoder, getBytes, keccak256, Wallet } from 'ethers';
import config from '../config';
import {
  QuoteIntegrityPayload,
  QuoteResponse,
  SignedQuoteIntegrity,
  SignedQuoteResponse,
} from '../types/QuoteResponse';

const SIGNING_VERSION = 1;

const abiCoder = new AbiCoder();

const PAYLOAD_TYPES = [
  'uint8', // version
  'address', // router
  'address', // tokenIn
  'address', // tokenOut
  'uint256', // amountIn
  'uint256', // minAmountOut
  'uint256', // deadline
  'bytes32', // calldataHash
  'uint256', // issuedAt
  'uint32', // slippageBps
] as const;

const sanitizePrivateKey = (value?: string | null): string => {
  if (!value) return '';
  return value.trim();
};

let cachedSigner: Wallet | null = null;

const resolveSigner = (): Wallet => {
  if (cachedSigner) {
    return cachedSigner;
  }

  const privateKey = sanitizePrivateKey(process.env.QUOTE_SIGNING_PRIVATE_KEY);
  if (!privateKey) {
    throw new Error('QUOTE_SIGNING_PRIVATE_KEY is not configured');
  }

  const wallet = new Wallet(privateKey);
  const configuredAddress = sanitizePrivateKey(process.env.QUOTE_SIGNER_ADDRESS);
  if (configuredAddress && wallet.address.toLowerCase() !== configuredAddress.toLowerCase()) {
    throw new Error('QUOTE_SIGNER_ADDRESS does not match QUOTE_SIGNING_PRIVATE_KEY');
  }

  cachedSigner = wallet;
  return cachedSigner;
};

const normalizeSlippageBps = (allowedSlippage: number): number => {
  if (!Number.isFinite(allowedSlippage) || allowedSlippage < 0) {
    return 0;
  }
  if (allowedSlippage > 100) {
    return 10_000;
  }
  return Math.round(allowedSlippage * 100);
};

export const buildIntegrityPayload = (
  quote: QuoteResponse,
  {
    allowedSlippage,
  }: {
    allowedSlippage: number;
  }
): QuoteIntegrityPayload => ({
  version: SIGNING_VERSION,
  router: config.AffiliateRouterAddress,
  tokenIn: quote.tokenInAddress,
  tokenOut: quote.tokenOutAddress,
  amountIn: quote.amountIn,
  minAmountOut: quote.minAmountOut,
  deadline: quote.deadline,
  calldataHash: keccak256(quote.calldata),
  issuedAt: Math.floor(Date.now() / 1000),
  slippageBps: normalizeSlippageBps(allowedSlippage),
});

const encodeIntegrityPayload = (payload: QuoteIntegrityPayload): string =>
  abiCoder.encode(PAYLOAD_TYPES, [
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

export const signQuoteResponse = async (
  quote: QuoteResponse,
  context: { allowedSlippage: number }
): Promise<SignedQuoteResponse> => {
  const signer = resolveSigner();
  const payload = buildIntegrityPayload(quote, context);
  const encodedPayload = encodeIntegrityPayload(payload);
  const digest = keccak256(encodedPayload);
  const signature = await signer.signMessage(getBytes(digest));

  const integrity: SignedQuoteIntegrity = {
    payload,
    signature,
    signer: signer.address,
  };

  return {
    ...quote,
    integrity,
  };
};
