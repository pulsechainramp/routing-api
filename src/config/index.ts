export default {
  AffiliateRouterAddress: '0x4653251486a57f90Ee89F9f34E098b9218659b83',
  ReferralFeeIndexerName: 'referral_fee_indexer',
  ReferralFeeIndexStartBlock: 24366340,
  PulsexV1FactoryAddress: '0x1715a3e4a142d8b698131108995174f37aeba10d',
  PulsexV2FactoryAddress: '0x29ea7545def87022badc76323f373ea1e707c523',

  // PulseX routers
  PulsexV1RouterAddress: process.env.PULSEX_V1_ROUTER ?? '0x98bf93ebf5c380C0e6Ae8e192A7e2AE08edAcc02',
  PulsexV2RouterAddress: process.env.PULSEX_V2_ROUTER ?? '0x165C3410fC91EF562C50559f7d2289fEbed552d9',

  // common connectors for fallback
  WPLS: process.env.WPLS ?? '0xA1077a294dDE1B09bB078844df40758a5D0f9a27',
  USDC: process.env.USDC ?? '0x15D38573d2feeb82e7ad5187aB8c1D52810B1f07',
  USDT: process.env.USDT ?? '0x0Cb6F5a34ad42ec934882A05265A7d5F59b51A2f',
  DAI:  process.env.DAI  ?? '0xefD766cCb38EaF1dfd701853BFCe31359239F305',

  // PulseX 3‑pool (USDT/USDC/DAI) used by StableThreePoolQuoter
  PulsexStablePoolAddress: process.env.PULSEX_STABLE_POOL ?? '0xE3acFA6C40d53C3faf2aa62D0a715C737071511c',

  RPC_URL: process.env.RPC_URL || 'https://rpc.pulsechain.com',
};
