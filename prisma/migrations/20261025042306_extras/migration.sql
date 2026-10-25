-- =============================================================================
-- CALFIT - rules Prisma cannot express in schema.prisma
-- Apply as a custom migration:
--   npx prisma migrate dev --create-only --name extras
--   (paste this file into the generated migration.sql, then run `npx prisma migrate dev`)
-- Column names are camelCase (no @map), so they must be double-quoted.
-- =============================================================================

-- 1. Fuzzy people / gym search (Search tab) without extra infrastructure
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX users_username_trgm ON users USING gin (username gin_trgm_ops);
CREATE INDEX users_name_trgm     ON users USING gin (name gin_trgm_ops);
CREATE INDEX gyms_name_trgm      ON gyms  USING gin (name gin_trgm_ops);

-- 2. THE streak rule: one VALID check-in per person per day.
--    Voided rows stay in the table (history is never deleted) but do not block a re-check-in.
CREATE UNIQUE INDEX check_ins_one_valid_per_day
  ON check_ins ("userId", "checkInDate")
  WHERE "voidedAt" IS NULL;

-- 3. Data integrity checks
ALTER TABLE users
  ADD CONSTRAINT users_username_lowercase CHECK (username IS NULL OR username = lower(username));

ALTER TABLE follows
  ADD CONSTRAINT follows_no_self_follow CHECK ("followerId" <> "followingId");

ALTER TABLE blocks
  ADD CONSTRAINT blocks_no_self_block CHECK ("blockerId" <> "blockedId");

ALTER TABLE plan_assignments
  ADD CONSTRAINT plan_assignments_has_a_plan
  CHECK ("workoutPlanId" IS NOT NULL OR "dietPlanId" IS NOT NULL);

ALTER TABLE gym_members
  ADD CONSTRAINT gym_members_has_identity
  CHECK ("userId" IS NOT NULL OR "invitedPhone" IS NOT NULL);

ALTER TABLE member_fees
  ADD CONSTRAINT member_fees_amounts_valid
  CHECK (amount >= 0 AND "amountPaid" >= 0);

-- 4. Seed data (run from prisma/seed.ts, shown here for reference)
-- INSERT INTO badges (code, name, "streakThreshold") VALUES
--   ('STREAK_7','7 Day Streak',7), ('STREAK_14','14 Day Streak',14),
--   ('STREAK_30','30 Day Streak',30), ('STREAK_60','60 Day Streak',60),
--   ('STREAK_100','100 Day Streak',100), ('STREAK_200','200 Day Streak',200),
--   ('STREAK_365','365 Day Streak',365);
-- INSERT INTO app_config (key, value, "updatedAt") VALUES
--   ('streak.rest_day', '{"windowDays":7,"allowed":1}', now());
