export default {
  AffiliateRouterAddress: '0x4653251486a57f90Ee89F9f34E098b9218659b83',
  ReferralFeeIndexerName: 'referral_fee_indexer',
  ReferralFeeIndexStartBlock: 24366340,
  PulsexV1FactoryAddress: '0x1715a3e4a142d8b698131108995174f37aeba10d',
  PulsexV2FactoryAddress: '0x29ea7545def87022badc76323f373ea1e707c523',

  // V2-style router endpoints for fallback quoting (getAmountsOut)
  PulsexV1RouterAddress: process.env.PULSEX_V1_ROUTER ?? '0x0000000000000000000000000000000000000000',
  PulsexV2RouterAddress: process.env.PULSEX_V2_ROUTER ?? '0x165C3410fC91EF562C50559f7d2289fEbed552d9',

  // common connectors for fallback
  WPLS: process.env.WPLS ?? '0xA1077a294dDE1B09bB078844df40758a5D0f9a27',
  USDC: process.env.USDC ?? '0x15D38573d2feeb82e7ad5187aB8c1D52810B1f07',
  DAI:  process.env.DAI  ?? '0xefD766cCb38EaF1dfd701853BFCe31359239F305',
};