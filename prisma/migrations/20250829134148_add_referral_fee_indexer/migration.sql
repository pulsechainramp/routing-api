-- CreateTable
CREATE TABLE "referral_fees" (
    "id" TEXT NOT NULL,
    "referrer" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "amount" DECIMAL(20,8) NOT NULL,
    "lastUpdated" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "referral_fees_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "indexing_states" (
    "id" TEXT NOT NULL,
    "indexerName" TEXT NOT NULL,
    "lastIndexedBlock" INTEGER NOT NULL DEFAULT 0,
    "lastIndexedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "isActive" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "indexing_states_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "referral_fees_referrer_idx" ON "referral_fees"("referrer");

-- CreateIndex
CREATE INDEX "referral_fees_token_idx" ON "referral_fees"("token");

-- CreateIndex
CREATE UNIQUE INDEX "referral_fees_referrer_token_key" ON "referral_fees"("referrer", "token");

-- CreateIndex
CREATE UNIQUE INDEX "indexing_states_indexerName_key" ON "indexing_states"("indexerName");
