import { FastifyReply, FastifyRequest } from 'fastify';
import { ethers, ZeroAddress } from 'ethers';
import { PulseXQuoteService } from '../services/PulseXQuoteService';

interface PriceQuery {
    address: string;
}

export class TokenPriceController {
    constructor(private pulseXQuoteService: PulseXQuoteService) { }

    async getPrice(request: FastifyRequest<{ Querystring: PriceQuery }>, reply: FastifyReply) {
        try {
            const { address } = request.query;
            const normalized = address?.toLowerCase();

            const isNative =
                normalized === 'pls' ||
                normalized === '0x0' ||
                normalized === ZeroAddress.toLowerCase();

            if (!isNative && (!address || !ethers.isAddress(address))) {
                reply.code(400).send({ error: 'Valid address is required' });
                return;
            }

            const price = await this.pulseXQuoteService.getTokenPrice(address);
            return reply.send({ usd_price: price });
        } catch (error) {
            console.error('Error fetching token price:', error);
            const isUnavailable =
                error instanceof Error && error.message.toLowerCase().includes('unavailable');
            if (isUnavailable) {
                reply.code(404).send({ error: 'Token price unavailable' });
                return;
            }
            reply.code(500).send({ error: 'Failed to fetch token price' });
        }
    }
}
