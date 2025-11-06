# PulseChain Routing API
Fastify service that aggregates PulseChain swap quotes, bridge data, and onramp providers with Prisma-backed persistence and rate limiting.

---

## TL;DR (Quickstart)

```bash
# Native toolchain
git clone https://github.com/pulsechainramp/routing-api.git && cd routing-api
cp .env.example .env                   # edit credentials & secrets
npm install
npm run db:generate && npm run db:migrate
npm run dev
```

```bash
# Docker Compose
git clone https://github.com/pulsechainramp/routing-api.git && cd routing-api
cp .env.example .env                   # edit credentials & secrets
cp docker-compose.yml.example docker-compose.yml  # or copy on Windows
# edit docker-compose.yml and .env to set POSTGRES_USER/POSTGRES_PASSWORD and DATABASE_URL
docker compose up --build
```

**Open:** http://localhost:3000/health  
**Requirements:** Node 18+, npm 9+, Postgres 15+ (or Docker Desktop / Docker Engine 24+)  
**Demo data (optional):** `npm run db:reset`

---

## What's Inside (Features)
- **PulseX & Piteas quotes** - Aggregates on-chain routes with slippage controls and PulseX fallback quoting.
- **OmniBridge support** - Lists supported currencies, estimates bridge output, and records bridge transactions.
- **Referral management** - Generates referral codes, resolves addresses, and exposes indexed referral fees.
- **Onramp discovery** - Serves geo-aware onramp providers with templated onramp deeplinks (address/amount aware).

---

## Installation & Setup

### Prerequisites
- **Runtime:** Node.js >=18 with TypeScript toolchain
- **Package manager:** npm (uses `package-lock.json`)
- **Infra:** PostgreSQL (local or via Docker Compose)

### Local Development
```bash
npm install
npm run db:generate && npm run db:migrate
npm run dev
```

### Docker (optional)
```bash
docker compose up --build
```

### Configuration (ENV)
| Key | Example | Required | Description |
|---|---|:--:|---|
| `DATABASE_URL` | `postgresql://routing_app:password@localhost:5432/routing?schema=public` | yes | Postgres DSN for Prisma/Prisma |
| `PITEAS_API_BASE_URL` | `https://sdk.piteas.io` | yes | Upstream aggregator used for quotes |
| `CORS_ALLOWLIST` | `http://localhost:5173` |  | Comma-separated origins allowed by CORS |
| `TRUST_PROXY` | `` |  | Optional Fastify `trustProxy` setting (boolean/number/list). Leave empty to disable |
| `RPC_URL` | `https://rpc.pulsechain.com` |  | PulseChain RPC endpoint (override default) |
| `ONRAMPS_JSON_PATH` | `./src/data/onramps_providers.json` |  | Path to onramp provider catalog |
| `USE_PROXY` | `false` |  | Toggle proxy routing (with `PROXY_*` creds) |
| `CHANGENOW_API_KEY` | `changexxxx` |  | Optional: enable legacy ChangeNOW routes |
| `JWT_SECRET` | `super-secret-value` | yes | HMAC secret for SIWE-issued JWTs |
| `JWT_EXPIRES_IN` | `1h` |  | Optional JWT lifetime (Fastify JWT format) |
| `SIWE_DOMAIN` | `pulsechainramp.com` |  | Expected SIWE domain (defaults to request host) |
| `SIWE_URI` | `https://pulsechainramp.com` |  | Audience URI embedded in SIWE messages |
| `SIWE_STATEMENT` | `Sign in to create a referral code` |  | Custom SIWE message statement |
| `SIWE_CHAIN_ID` | `369` |  | Chain ID used for SIWE validation (defaults to 369) |
| `REFERRAL_CREATION_RATE_LIMIT_MAX` | `3` |  | Per-address POST `/referral/code` limit |
| `REFERRAL_CREATION_RATE_LIMIT_WINDOW` | `1 minute` |  | Rate-limit window for referral creation |
| `REFERRAL_READ_RATE_LIMIT_MAX` | `60` |  | GET `/referral/*` read limit |
| `REFERRAL_READ_RATE_LIMIT_WINDOW` | `1 minute` |  | Window for referral read limits |
| `REFERRAL_FEES_RATE_LIMIT_MAX` | `120` |  | GET `/referral-fees/*` limit |
| `REFERRAL_FEES_RATE_LIMIT_WINDOW` | `1 minute` |  | Window for referral fee limits |
| `SIWE_CHALLENGE_RATE_LIMIT_MAX` | `20` |  | Auth challenge/verify rate limit |
| `SIWE_CHALLENGE_RATE_LIMIT_WINDOW` | `1 minute` |  | Window for auth rate limit |
| `OMNIBRIDGE_CREATE_RATE_LIMIT_MAX` | `5` |  | Per-wallet POST `/exchange/omnibridge/transaction` limit |
| `OMNIBRIDGE_CREATE_RATE_LIMIT_WINDOW` | `1 minute` |  | Window for OmniBridge transaction creation |
| `OMNIBRIDGE_CREATE_RATE_LIMIT_BAN` | *(unset)* |  | Optional ban threshold; omit to rely on 429 responses |
| `OMNIBRIDGE_CREATE_ENABLED` | `true` |  | Feature flag to disable OmniBridge transaction creation |
| `OMNI_MISS_TTL_MS` | `600000` |  | Cache duration (ms) for failed OmniBridge lookups |
| `RPC_ETH_MAX_CONCURRENCY` | `5` |  | Max concurrent Ethereum RPC calls for OmniBridge ingestion |
| `RPC_PLS_MAX_CONCURRENCY` | `5` |  | Max concurrent PulseChain RPC calls for OmniBridge ingestion |

> Copy `.env.example` to `.env` and populate secrets before running locally or via Docker.
> Copy `docker-compose.yml.example` to `docker-compose.yml` and set `POSTGRES_USER`, `POSTGRES_PASSWORD`, and `DATABASE_URL` before running Compose.
> Update `src/config/index.ts` before deploying so `AffiliateRouterAddress` (and other contract constants) match your target network.

---

## Usage

### API
**Base URL:** http://localhost:3000

```http
GET /quote/pulsex?tokenInAddress=0xA1077a294dDE1B09bB078844df40758a5D0f9a27&tokenOutAddress=0xefD766cCb38EaF1dfd701853BFCe31359239F305&amount=1000000000000000000
```
**Response (excerpt)**
```json
{
  "outputAmount": "998347654321234567",
  "route": {
    "steps": [
      { "dex": "PulseX V2", "path": ["0xA1077...", "0xefD766..."] }
    ]
  }
}
```

```http
GET /exchange/omnibridge/transactions?userAddress=0x1234000000000000000000000000000000000000&limit=5
```
**Response**
```json
{
  "success": true,
  "data": [
    { "messageId": "0xabc...", "status": "pending", "sourceChainId": 1, "targetChainId": 369 }
  ]
}
```

```http
GET /onramps/providers?country=US&address=0x1234&amount=200&fiat=USD
```
**Response (excerpt)**
```json
{
  "country": "US",
  "providers": [
    { "id": "moonpay", "deeplink_available": true, "deeplink": "https://buy.moonpay..." }
  ]
}
```

Swagger UI is available in non-production environments at `/docs`.

### Authenticated Referral Flow
1. **Challenge:**  
   `GET /auth/challenge?address=0xAbC...`  
   Returns a SIWE message + nonce for the wallet to sign.

2. **Verify:**  
   `POST /auth/verify`  
   ```json
   { "message": "<siwe message>", "signature": "<0x…>" }
   ```  
   Responds with a short-lived JWT (`{ "token": "...", "address": "0xabc..." }`).

3. **Check on-chain fee:**  
   `GET /referral/creation-fee` → `{ "fee": "35000000000000000", "contractAddress": "0x..." }`

4. **Create code (authenticated):**  
   `POST /referral/code` with headers:
   ```
   Authorization: Bearer <jwt>
   X-Idempotency-Key: <uuid>
   ```
   Body: `{ "address": "0xabc..." }`

   - `200/201` — Existing or newly created referral record.
   - `402` — `{ "error": "Referral creation fee required", "fee": "35000000000000000", "contractAddress": "0x..." }`
   - `401` — JWT missing/invalid or wallet mismatch.

Read-only endpoints (`GET /referral/code`, `/referral/address`, `/referral-fees/*`) remain unauthenticated but inherit tighter rate limits.

---

## Project Structure
```
routing-api/
  prisma/           # Prisma schema and migrations
  src/
    controllers/    # Request handlers (e.g. quote)
    routes/         # Fastify route modules
    services/       # Business logic & integrations
    utils/          # Logging, web3 helpers, link builders
  Dockerfile
  docker-compose.yml
```

**Key scripts**
| Script | What it does |
|---|---|
| `npm run dev` | Start Fastify with TypeScript hot reload |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm run start` | Serve compiled build |
| `npm run test` | Execute Jest test suite (none defined yet) |
| `npm run db:generate` | Regenerate Prisma client |
| `npm run db:migrate` | Apply latest database migrations |
| `npm run db:reset` | Reset database (drops data) |

---

## Architecture & Design
- **Pattern:** Modular Fastify plugins with explicit dependency injection via a route registry.
- **Modules:** Quote aggregation, OmniBridge, referrals, referral fee indexer, onramp catalog, proxy/rate limiting.
- **Data:** PostgreSQL + Prisma client (`Transaction`, `RateCache`, `OmniBridgeTransaction`, `ReferralFee`, `User`, `IndexingState`).
- **Integrations:** Piteas, PulseX routers, ChangeNOW, OmniBridge GraphQL, MoonPay, Transak, Ramp, optional proxy list.
- **Indexers:** `IndexerManager` runs referral fee indexing against PulseChain RPC when the server boots.
- **Resilience:** Global and per-endpoint rate limits, proxy rotation, sanitized logging, and retry-friendly error handling.

---

## Testing & Quality
- **Test types:** Jest scaffold present; add unit/integration tests as features mature.
- **Run:** `npm test`
- **Lint/format:** No dedicated scripts; rely on TypeScript compiler and project conventions.
- **Conventional commits:** Not enforced (use team guidelines if applicable).

---

## Security & Compliance
- **Secrets:** Loaded via `.env`; never commit production credentials.
- **Auth:** SIWE challenge + Fastify JWT now gate referral *and* OmniBridge transaction creation; other routes remain unauthenticated and should sit behind network controls.
- **Validation:** Fastify schemas validate query params, body payloads, and rate-limit responses.
- **Protections:** Helmet defaults, strict CORS allowlist, log redaction for auth headers/secrets, per-wallet OmniBridge rate limits, and memoized bridge misses to avoid RPC exhaustion.
- **Dependencies:** Managed via npm; review with `npm audit` during CI/CD.

---

## Networking & Rate Limits
- When you deploy behind nginx or another trusted reverse proxy, set `TRUST_PROXY=1` (or list the proxy IPs/CIDRs) so Fastify honors the original client address forwarded by your edge.
- Leave `TRUST_PROXY` empty when Fastify is exposed directly; this prevents spoofed `X-Forwarded-For` headers from bypassing the global or quote-specific rate limits.

---

## Observability
- **Logging:** `pino` (developer-friendly with `pino-pretty`), contextual request IDs, redacted secrets.
- **Health check:** `GET /health` verifies application and database connectivity.
- **Swagger:** `/docs` (non-production) for discoverability during development.

---

## Deployment
- **Environments:** Configure `.env` per environment; ensure Postgres and PulseChain RPC endpoints are reachable.
- **CI/CD:** No pipeline committed; add GitHub Actions or other automation for installs, tests, and migrations.
- **Artifacts:** Dockerfile builds production image; `docker-compose.yml` wires API + Postgres for local/staging usage.
- **Migrations:** Run `npm run db:migrate` (or `npm run db:deploy` in CI) before promoting builds.

---

## Troubleshooting / FAQ
- **Prisma connection errors:** Confirm Postgres is running and `DATABASE_URL` targets the reachable host/port.
- **Onramp catalog missing:** Ensure `src/data/onramps_providers.json` exists or set `ONRAMPS_JSON_PATH` to a valid file.

---

## Contributing
- Fork or branch from `main`, run `npm run db:migrate`, and keep Prisma schema changes committed.
- Add or update Jest tests when touching business logic; run `npm test` before opening a PR.
- Document new env keys and endpoints in this README or service-specific docs.
