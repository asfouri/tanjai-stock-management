export const defaultOrderExcelGracePeriodDays = 7;

type ApiOrderCandidate = {
  id: string;
  storeId: string;
  externalOrderNumber: string;
  provider: string;
  createdAt: Date;
  store: { name: string };
};

type ExcelOrderReference = {
  storeId: string;
  externalOrderNumber: string;
};

export function normalizeOrderReference(value: string) {
  return value
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(/^#\s*/, '')
    .replace(/\s+/g, '');
}

export function orderReferenceVariants(value: string) {
  const raw = value.normalize('NFKC').trim();
  const normalized = normalizeOrderReference(raw);
  return [
    ...new Set([raw, normalized, `#${normalized}`, `# ${normalized}`]),
  ].filter(Boolean);
}

export function findApiOrdersMissingFromExcel<T extends ApiOrderCandidate>(
  apiOrders: T[],
  excelOrders: ExcelOrderReference[],
  gracePeriodDays = defaultOrderExcelGracePeriodDays,
  now = new Date(),
) {
  const safeGracePeriodDays =
    Number.isFinite(gracePeriodDays) && gracePeriodDays > 0
      ? gracePeriodDays
      : defaultOrderExcelGracePeriodDays;
  const gracePeriodMs = safeGracePeriodDays * 24 * 60 * 60 * 1000;
  const excelKeys = new Set(
    excelOrders.map(
      (order) =>
        `${order.storeId}:${normalizeOrderReference(order.externalOrderNumber)}`,
    ),
  );

  return apiOrders
    .filter(
      (order) => now.getTime() - order.createdAt.getTime() >= gracePeriodMs,
    )
    .filter(
      (order) =>
        !excelKeys.has(
          `${order.storeId}:${normalizeOrderReference(order.externalOrderNumber)}`,
        ),
    )
    .map((order) => ({
      ...order,
      notificationAt: new Date(order.createdAt.getTime() + gracePeriodMs),
    }));
}
