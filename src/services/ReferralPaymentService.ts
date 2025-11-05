import { Contract, JsonRpcProvider, getAddress, type InterfaceAbi } from 'ethers';
import AffiliateRouterArtifact from '../abis/AffiliateRouter.json';
import config from '../config';

export class ReferralPaymentService {
  private readonly contract: Contract;

  constructor(
    rpcUrl: string = config.RPC_URL,
    contractAddress: string = config.AffiliateRouterAddress
  ) {
    const provider = new JsonRpcProvider(rpcUrl);
    const abi = (AffiliateRouterArtifact as { abi: InterfaceAbi }).abi;
    this.contract = new Contract(contractAddress, abi, provider);
  }

  async getReferralCreationFee(): Promise<bigint> {
    return (await this.contract.referralCreationFee()) as bigint;
  }

  async hasPaidReferralCreationFee(address: string): Promise<boolean> {
    const normalized = getAddress(address);
    return (await this.contract.hasPaidReferralCreationFee(normalized)) as boolean;
  }
}
