import { PrismaClient } from '../src/generated/prisma/client.js';

try {
  process.loadEnvFile();
} catch {
  // no .env file: rely on real environment variables
}

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is not set');
const dbName = new URL(url).pathname.slice(1);

const prisma = new PrismaClient({ datasourceUrl: url });

const BADGE_DAYS = [7, 14, 30, 60, 100, 200, 365];

async function main(): Promise<void> {
  console.log(`Seeding database: ${dbName}`);

  for (const days of BADGE_DAYS) {
    const data = {
      name: `${days} Day Streak`,
      description: `Checked in ${days} days in a row`,
      streakThreshold: days,
    };
    await prisma.badge.upsert({
      where: { code: `STREAK_${days}` },
      create: { code: `STREAK_${days}`, ...data },
      update: data,
    });
  }

  // update: {} so re-running the seed never overwrites a value tuned later
  await prisma.appConfig.upsert({
    where: { key: 'streak.rest_day' },
    create: { key: 'streak.rest_day', value: { windowDays: 7, allowed: 1 } },
    update: {},
  });

  const badges = await prisma.badge.count();
  const configs = await prisma.appConfig.count();
  console.log(`Done. badges: ${badges}, app_config rows: ${configs}`);
}

try {
  await main();
} finally {
  await prisma.$disconnect();
}