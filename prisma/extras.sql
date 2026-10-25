-- =============================================================================
-- CALFIT - database rules that Prisma cannot express in schema.prisma.
-- REFERENCE ONLY. These are ALREADY APPLIED through migration
-- 20261025042306_extras. Do not run this file again.
-- Trigram search indexes are declared in schema.prisma, not here.
-- Column names are camelCase, so they must be double-quoted in raw SQL.
-- =============================================================================

-- One VALID check-in per person per day. Voided rows stay as history
-- but do not block a re-check-in.
CREATE UNIQUE INDEX check_ins_one_valid_per_day
  ON check_ins ("userId", "checkInDate")
  WHERE "voidedAt" IS NULL;

-- Integrity checks
ALTER TABLE users ADD CONSTRAINT users_username_lowercase
  CHECK (username IS NULL OR username = lower(username));
ALTER TABLE follows ADD CONSTRAINT follows_no_self_follow
  CHECK ("followerId" <> "followingId");
ALTER TABLE blocks ADD CONSTRAINT blocks_no_self_block
  CHECK ("blockerId" <> "blockedId");
ALTER TABLE plan_assignments ADD CONSTRAINT plan_assignments_has_a_plan
  CHECK ("workoutPlanId" IS NOT NULL OR "dietPlanId" IS NOT NULL);
ALTER TABLE gym_members ADD CONSTRAINT gym_members_has_identity
  CHECK ("userId" IS NOT NULL OR "invitedPhone" IS NOT NULL);
ALTER TABLE member_fees ADD CONSTRAINT member_fees_amounts_valid
  CHECK (amount >= 0 AND "amountPaid" >= 0);

-- Seed data (will be inserted by prisma/seed.ts, not by this file):
--   badges: STREAK_7, 14, 30, 60, 100, 200, 365
--   app_config: key 'streak.rest_day' = {"windowDays":7,"allowed":1}
