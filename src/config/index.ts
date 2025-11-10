export default {
  AffiliateRouterAddress: '0xCf2B8a55c86790Ab8F04873033a6e46be99658a7',
  ReferralFeeIndexerName: 'referral_fee_indexer',
  ReferralFeeIndexStartBlock: 24366340,
  PulsexV1FactoryAddress: '0x1715a3e4a142d8b698131108995174f37aeba10d',
  PulsexV2FactoryAddress: '0x29ea7545def87022badc76323f373ea1e707c523',
  PulsexV1RouterAddress: '0x98bf93ebf5c380C0e6Ae8e192A7e2AE08edAcc02',
  PulsexV2RouterAddress: '0x165C3410fC91EF562C50559f7d2289fEbed552d9',

  // common connectors for fallback
  WPLS: '0xA1077a294dDE1B09bB078844df40758a5D0f9a27',
  USDC: '0x15D38573d2feeb82e7ad5187aB8c1D52810B1f07',
  USDT: '0x0Cb6F5a34ad42ec934882A05265A7d5F59b51A2f',
  DAI: '0xefD766cCb38EaF1dfd701853BFCe31359239F305',

  // PulseX 3‑pool (USDT/USDC/DAI) used by StableThreePoolQuoter
  PulsexStablePoolAddress: '0xE3acFA6C40d53C3faf2aa62D0a715C737071511c',

  RPC_URL: process.env.RPC_URL || 'https://rpc.pulsechain.com',
};
