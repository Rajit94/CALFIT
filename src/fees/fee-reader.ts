import { isUuid } from '../common/uuid.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import { feeNotFound } from './fee-errors.js';
import { FEE_DETAIL_SELECT } from './fee-select.js';
import { toFeeDetail } from './fee-view.js';
import type { FeeDetail } from './fee-view.js';

export async function loadFeeDetail(
  prisma: PrismaService,
  gymId: string,
  feeId: string,
  today: string,
): Promise<FeeDetail> {
  if (!isUuid(feeId)) throw feeNotFound();
  const row = await prisma.memberFee.findFirst({
    where: { id: feeId, gymId },
    select: FEE_DETAIL_SELECT,
  });
  if (!row) throw feeNotFound();
  return toFeeDetail(row, today);
}