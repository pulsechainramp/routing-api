import { ethers } from 'ethers';
import { BlockchainService } from './BlockchainService';

describe('BlockchainService.extractTokensBridgingInitiatedEvent', () => {
  const networkId = 1;
  const omniBridgeAddress = '0x88ad09518695c6c3712ac10a214be5109a655671';
  const bridgeManagerAddress = '0x1715a3e4a142d8b698131108995174f37aeba10d';
  const forgedAddress = '0x1111111111111111111111111111111111111111';

  const tokenAddress = '0x0000000000000000000000000000000000000001';
  const senderAddress = '0x0000000000000000000000000000000000000002';
  const amount = '1234000000000000000';
  const messageId = `0x${'aa'.repeat(32)}`;

  let service: BlockchainService;
  let encodedLog: { topics: string[]; data: string };

  beforeEach(() => {
    const mockProvider = {} as any;
    service = new BlockchainService(mockProvider, mockProvider);
    const iface = (service as any).omniBridgeInterface as ethers.Interface;
    encodedLog = iface.encodeEventLog('TokensBridgingInitiated', [
      tokenAddress,
      senderAddress,
      BigInt(amount),
      messageId
    ]);
  });

  function buildReceipt(address: string) {
    return {
      logs: [
        {
          address,
          topics: encodedLog.topics,
          data: encodedLog.data
        }
      ]
    };
  }

  it('returns the parsed event when emitted by an approved OmniBridge contract', () => {
    const receipt = buildReceipt(omniBridgeAddress);
    const event = service.extractTokensBridgingInitiatedEvent(receipt as any, networkId);

    expect(event).toEqual({
      token: tokenAddress,
      sender: senderAddress,
      value: amount,
      messageId
    });
  });

  it('returns the parsed event when emitted by the BridgeManager wrapper', () => {
    const receipt = buildReceipt(bridgeManagerAddress);
    const event = service.extractTokensBridgingInitiatedEvent(receipt as any, networkId);

    expect(event).toEqual({
      token: tokenAddress,
      sender: senderAddress,
      value: amount,
      messageId
    });
  });

  it('ignores look-alike events emitted by untrusted contracts', () => {
    const receipt = buildReceipt(forgedAddress);
    const event = service.extractTokensBridgingInitiatedEvent(receipt as any, networkId);

    expect(event).toBeNull();
  });
});
