-- CreateTable
CREATE TABLE "users_cognito_data" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "cognito_sub" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "last_event_type" TEXT NOT NULL,
    "raw_payload" JSONB NOT NULL,
    "created_by" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" TEXT,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_by" TEXT,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "users_cognito_data_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users_cognito_events" (
    "id" TEXT NOT NULL,
    "cognito_sub" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "message_id" TEXT NOT NULL,
    "raw_payload" JSONB NOT NULL,
    "created_by" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" TEXT,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_by" TEXT,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "users_cognito_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_cognito_data_user_id_key" ON "users_cognito_data"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "users_cognito_data_cognito_sub_key" ON "users_cognito_data"("cognito_sub");

-- CreateIndex
CREATE INDEX "users_cognito_data_deleted_at_idx" ON "users_cognito_data"("deleted_at");

-- CreateIndex
CREATE UNIQUE INDEX "users_cognito_events_message_id_key" ON "users_cognito_events"("message_id");

-- CreateIndex
CREATE INDEX "users_cognito_events_deleted_at_idx" ON "users_cognito_events"("deleted_at");

-- AddForeignKey
ALTER TABLE "users_cognito_data" ADD CONSTRAINT "users_cognito_data_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "users_cognito_events" ADD CONSTRAINT "users_cognito_events_cognito_sub_fkey" FOREIGN KEY ("cognito_sub") REFERENCES "users_cognito_data"("cognito_sub") ON DELETE RESTRICT ON UPDATE CASCADE;
