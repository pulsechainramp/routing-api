jest.mock('crypto', () => {
  const actual = jest.requireActual<typeof import('crypto')>('crypto');
  return {
    ...actual,
    randomInt: jest.fn((...args: any[]) => (actual.randomInt as any)(...args))
  };
});

const actualCrypto = jest.requireActual<typeof import('crypto')>('crypto');

import * as crypto from 'crypto';
import { ReferralService } from './ReferralService';
import { PrismaClient } from '../generated/prisma-client';

describe('ReferralService referral code generation', () => {
  const prismaMock = {} as unknown as PrismaClient;

  const createService = () => new ReferralService(prismaMock);

  afterEach(() => {
    const randomIntMock = crypto.randomInt as jest.Mock;
    randomIntMock.mockImplementation((...args) => (actualCrypto.randomInt as any)(...args));
    randomIntMock.mockClear();
  });

  it('uses crypto.randomInt to build referral codes', () => {
    const service = createService();
    const randomIntMock = crypto.randomInt as jest.Mock;
    randomIntMock.mockImplementation(() => 0);

    (service as any)._generateReferralCode();

    expect(randomIntMock).toHaveBeenCalledTimes(8);
    randomIntMock.mock.calls.forEach(call => {
      expect(call[0]).toBe(36);
    });
  });

  it('produces unique codes across a large sample', () => {
    const service = createService();
    const sampleSize = 500;
    const codes = new Set<string>();

    for (let i = 0; i < sampleSize; i++) {
      codes.add((service as any)._generateReferralCode());
    }

    expect(codes.size).toBe(sampleSize);
  });
});
