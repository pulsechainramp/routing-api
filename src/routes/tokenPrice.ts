import { FastifyInstance } from 'fastify';
import { TokenPriceController } from '../controllers/TokenPriceController';
import { PulseXQuoteService } from '../services/PulseXQuoteService';

export default async function tokenPriceRoutes(
    fastify: FastifyInstance,
    options: { pulseXQuoteService: PulseXQuoteService },
) {
    const controller = new TokenPriceController(options.pulseXQuoteService);

    fastify.get('/price', controller.getPrice.bind(controller));
}
