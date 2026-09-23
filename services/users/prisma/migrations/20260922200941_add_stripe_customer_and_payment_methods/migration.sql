-- AlterTable
ALTER TABLE "users" ADD COLUMN     "stripe_customer_data" JSONB,
ADD COLUMN     "stripe_customer_id" TEXT;

-- CreateTable
CREATE TABLE "stripe_payment_methods" (
    "id" TEXT NOT NULL,
    "stripe_payment_method_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "brand" TEXT,
    "last4" TEXT,
    "exp_month" INTEGER,
    "exp_year" INTEGER,
    "funding" TEXT,
    "country" TEXT,
    "fingerprint" TEXT,
    "billing_name" TEXT,
    "billing_email" TEXT,
    "billing_address" JSONB,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "raw_payload" JSONB NOT NULL,
    "created_by" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" TEXT,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_by" TEXT,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "stripe_payment_methods_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "stripe_payment_methods_stripe_payment_method_id_key" ON "stripe_payment_methods"("stripe_payment_method_id");

-- CreateIndex
CREATE INDEX "stripe_payment_methods_user_id_deleted_at_idx" ON "stripe_payment_methods"("user_id", "deleted_at");

-- CreateIndex
CREATE UNIQUE INDEX "users_stripe_customer_id_key" ON "users"("stripe_customer_id");

-- AddForeignKey
ALTER TABLE "stripe_payment_methods" ADD CONSTRAINT "stripe_payment_methods_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

