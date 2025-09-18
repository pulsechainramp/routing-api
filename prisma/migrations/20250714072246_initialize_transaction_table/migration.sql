-- CreateTable
CREATE TABLE "transactions" (
    "id" TEXT NOT NULL,
    "changenowId" TEXT NOT NULL,
    "userAddress" TEXT NOT NULL,
    "fromCurrency" TEXT NOT NULL,
    "toCurrency" TEXT NOT NULL,
    "fromNetwork" TEXT,
    "toNetwork" TEXT,
    "fromAmount" DECIMAL(20,8) NOT NULL,
    "toAmount" DECIMAL(20,8),
    "expectedToAmount" DECIMAL(20,8) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "payinAddress" TEXT NOT NULL,
    "payoutAddress" TEXT NOT NULL,
    "payinHash" TEXT,
    "payoutHash" TEXT,
    "depositReceivedAt" TIMESTAMP(3),
    "refundAddress" TEXT,
    "refundHash" TEXT,
    "refundAmount" DECIMAL(20,8),
    "errorMessage" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rate_cache" (
    "id" TEXT NOT NULL,
    "fromCurrency" TEXT NOT NULL,
    "toCurrency" TEXT NOT NULL,
    "fromNetwork" TEXT,
    "toNetwork" TEXT,
    "minAmount" DECIMAL(20,8) NOT NULL,
    "maxAmount" DECIMAL(20,8),
    "rate" DECIMAL(20,8) NOT NULL,
    "validUntil" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rate_cache_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "currencies" (
    "id" TEXT NOT NULL,
    "ticker" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "network" TEXT,
    "isFiat" BOOLEAN NOT NULL DEFAULT false,
    "featured" BOOLEAN NOT NULL DEFAULT false,
    "isStable" BOOLEAN NOT NULL DEFAULT false,
    "buy" BOOLEAN NOT NULL DEFAULT true,
    "sell" BOOLEAN NOT NULL DEFAULT true,
    "image" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "currencies_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "transactions_changenowId_key" ON "transactions"("changenowId");

-- CreateIndex
CREATE UNIQUE INDEX "rate_cache_fromCurrency_toCurrency_key" ON "rate_cache"("fromCurrency", "toCurrency");

-- CreateIndex
CREATE UNIQUE INDEX "currencies_ticker_key" ON "currencies"("ticker");
