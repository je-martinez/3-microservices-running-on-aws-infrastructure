-- CreateEnum
CREATE TYPE "AuthType" AS ENUM ('PASSWORD', 'PASSWORDLESS');

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "auth_type" "AuthType" NOT NULL DEFAULT 'PASSWORD';
