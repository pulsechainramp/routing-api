-- AlterTable
ALTER TABLE "currencies" ALTER COLUMN "isStable" SET DEFAULT true;

-- CreateTable
CREATE TABLE "omnibridge_transactions" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "userAddress" TEXT NOT NULL,
    "sourceChainId" INTEGER NOT NULL,
    "targetChainId" INTEGER NOT NULL,
    "sourceTxHash" TEXT NOT NULL,
    "targetTxHash" TEXT,
    "tokenAddress" TEXT NOT NULL,
    "tokenSymbol" TEXT NOT NULL,
    "tokenDecimals" INTEGER NOT NULL,
    "amount" DECIMAL(20,8) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "sourceTimestamp" TIMESTAMP(3) NOT NULL,
    "targetTimestamp" TIMESTAMP(3),
    "encodedData" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "omnibridge_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "omnibridge_transactions_messageId_key" ON "omnibridge_transactions"("messageId");

-- CreateIndex
CREATE INDEX "omnibridge_transactions_userAddress_idx" ON "omnibridge_transactions"("userAddress");

-- CreateIndex
CREATE INDEX "omnibridge_transactions_messageId_idx" ON "omnibridge_transactions"("messageId");

-- CreateIndex
CREATE INDEX "omnibridge_transactions_sourceChainId_idx" ON "omnibridge_transactions"("sourceChainId");

-- CreateIndex
CREATE INDEX "omnibridge_transactions_targetChainId_idx" ON "omnibridge_transactions"("targetChainId");
