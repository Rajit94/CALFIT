export const FEE_SELECT = {
  id: true,
  gymMemberId: true,
  status: true,
  periodStart: true,
  periodEnd: true,
  dueDate: true,
  amount: true,
  amountPaid: true,
  paidAt: true,
  createdAt: true,
  plan: { select: { id: true, name: true } },
  gymMember: {
    select: {
      status: true,
      invitedName: true,
      invitedPhone: true,
      user: { select: { name: true, phone: true } },
    },
  },
} as const;

export const PAYMENT_SELECT = {
  id: true,
  receiptNo: true,
  amount: true,
  method: true,
  paidAt: true,
  note: true,
  recordedById: true,
} as const;

export const FEE_DETAIL_SELECT = {
  ...FEE_SELECT,
  payments: {
    orderBy: [{ paidAt: 'asc' as const }, { createdAt: 'asc' as const }],
    select: PAYMENT_SELECT,
  },
};