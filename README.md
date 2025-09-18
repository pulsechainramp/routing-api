# Routing API

API Gateway for Piteas with proxy rotation and rate limiting

## ChangeNow Cross-Chain Aggregator

This API now includes ChangeNow-based cross-chain cryptocurrency exchange functionality.

### New Features
- **Cross-Chain Swaps**: Swap cryptocurrencies between different networks (e.g., ETH to PLS)
- **Real-time Quotes**: Get instant exchange rates and fees
- **Transaction Tracking**: Monitor swap progress in real-time
- **Rate Caching**: Optimized performance with cached exchange rates

### New API Endpoints

#### Rate Endpoints
- `GET /exchange/rate` - Get exchange rate for a currency pair

#### Trade Endpoints
- `POST /exchange/trade` - Create a new trade transaction
- `GET /exchange/order/:id` - Get order status
- `GET /exchange/orders` - Get user's order history
- `GET /exchange/stats` - Get transaction statistics


### Setup for ChangeNow Features

1. **Environment Variables**
   Add to your `.env` file:
   ```env
   DATABASE_URL="postgresql://user:password@localhost:5432/pt_quote_api"
   CHANGENOW_API_KEY=your_api_key_here
   ```

2. **Database Setup**
   ```bash
   npm run db:generate
   npm run db:migrate
   ```

3. **Start Development**
   ```bash
   npm run dev
   ```

### Example Usage

Get a rate:
```bash
curl "http://localhost:3000/exchange/rate?fromCurrency=eth&toCurrency=pls&amount=0.1"
```

Create a trade:
```bash
curl -X POST "http://localhost:3000/exchange/trade" \
  -H "Content-Type: application/json" \
  -d '{
    "fromCurrency": "eth",
    "toCurrency": "pls",
    "fromAmount": 0.1,
    "userAddress": "0x1234567890123456789012345678901234567890"
  }'
```

Get order status:
```bash
curl "http://localhost:3000/exchange/order/order_id_here"
```

## Original Features

A Fastify-based API that provides cross-chain cryptocurrency exchange functionality using ChangeNow as the backend provider. This service abstracts away ChangeNow's complexity and provides a simple, branded interface for users to swap cryptocurrencies across different networks.

## Features

- **Cross-Chain Swaps**: Swap cryptocurrencies between different networks (e.g., ETH to PLS)
- **Real-time Quotes**: Get instant exchange rates and fees
- **Transaction Tracking**: Monitor swap progress in real-time
- **Rate Caching**: Optimized performance with cached exchange rates
- **Database Integration**: Persistent storage with Prisma ORM
- **API Gateway**: Clean REST API for frontend integration

## API Endpoints

### Quote Endpoints
- `GET /api/v1/quote` - Get exchange quote for a currency pair

### Swap Endpoints
- `POST /api/v1/swap` - Create a new swap transaction
- `GET /api/v1/transaction/:id` - Get transaction status
- `GET /api/v1/transactions` - Get user's transaction history
- `GET /api/v1/stats` - Get transaction statistics

## Setup

### Prerequisites
- Node.js >= 18.0.0
- PostgreSQL database
- ChangeNow API key

### Installation

1. **Clone the repository**
   ```bash
   git clone <repository-url>
   cd pt-quote-api
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Environment Configuration**
   Create a `.env` file with the following variables:
   ```env
   # Database
   DATABASE_URL="postgresql://user:password@localhost:5432/pt_quote_api"
   
   # ChangeNow Configuration
   CHANGENOW_API_KEY=your_api_key_here
   
   # Application Configuration
   NODE_ENV=development
   PORT=3000
   LOG_LEVEL=info
   ```

4. **Database Setup**
   ```bash
   # Generate Prisma client
   npm run db:generate
   
   # Run database migrations
   npm run db:migrate
   ```

5. **Start Development Server**
   ```bash
   npm run dev
   ```

## Usage Examples

### Get Exchange Quote
```bash
curl "http://localhost:3000/api/v1/quote?fromCurrency=eth&toCurrency=pls&amount=0.1&fromNetwork=eth&toNetwork=pls"
```

### Create Swap Transaction
```bash
curl -X POST "http://localhost:3000/api/v1/swap" \
  -H "Content-Type: application/json" \
  -d '{
    "fromCurrency": "eth",
    "toCurrency": "pls",
    "fromAmount": 0.1,
    "userAddress": "0x1234567890123456789012345678901234567890",
    "fromNetwork": "eth",
    "toNetwork": "pls"
  }'
```

### Get Transaction Status
```bash
curl "http://localhost:3000/api/v1/transaction/transaction_id_here"
```

## Database Schema

### Transactions Table
- `id`: Unique transaction identifier
- `changenowId`: ChangeNow transaction ID
- `userAddress`: User's wallet address
- `fromCurrency`/`toCurrency`: Source and destination currencies
- `fromNetwork`/`toNetwork`: Source and destination networks
- `fromAmount`/`toAmount`: Exchange amounts
- `status`: Transaction status (pending, finished, failed, etc.)
- `payinAddress`/`payoutAddress`: Deposit and withdrawal addresses
- `payinHash`/`payoutHash`: Blockchain transaction hashes

### Rate Cache Table
- Caches exchange ranges and rates for performance
- Automatic expiration and refresh

## Development

### Available Scripts
- `npm run dev` - Start development server
- `npm run build` - Build for production
- `npm run start` - Start production server
- `npm run db:migrate` - Run database migrations
- `npm run db:generate` - Generate Prisma client
- `npm run db:studio` - Open Prisma Studio
- `npm run test` - Run tests

### Project Structure
```
src/
├── services/
│   ├── ChangeNowService.ts    # ChangeNow API integration
│   ├── RateService.ts         # Rate caching and quotes
│   └── TransactionService.ts  # Transaction management
├── routes/
│   ├── quote.ts              # Quote endpoints
│   ├── swap.ts               # Swap endpoints
│   ├── status.ts             # Status endpoints
├── types/
│   └── changenow.ts          # ChangeNow API types
└── generated/
    └── prisma-client/        # Generated Prisma client
```

## Architecture

### Service Layer
- **ChangeNowService**: Handles all ChangeNow API interactions
- **RateService**: Manages rate caching and quote calculations
- **TransactionService**: Orchestrates swap creation and tracking

### Data Flow
1. User requests quote → RateService validates and caches rates
2. User creates swap → TransactionService creates ChangeNow transaction
3. User monitors status → Real-time status updates from ChangeNow
4. Transaction completes → Database updated with final status

### Error Handling
- Comprehensive error handling for API failures
- User-friendly error messages
- Automatic retry mechanisms for transient failures

## Security

- API key management for ChangeNow
- Input validation and sanitization
- Rate limiting to prevent abuse
- Secure database connections

## Monitoring

- Health check endpoint (`/health`)
- Transaction statistics endpoint
- Comprehensive logging
- Database connection monitoring

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests if applicable
5. Submit a pull request

## License

[Your License Here] 