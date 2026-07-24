import {
  findApiOrdersMissingFromExcel,
  normalizeOrderReference,
  orderReferenceVariants,
} from './order-reconciliation';

describe('API order Excel reconciliation', () => {
  const now = new Date('2026-07-24T12:00:00.000Z');
  const apiOrder = {
    id: 'api-order-1',
    storeId: 'store-1',
    externalOrderNumber: '# 1234',
    provider: 'WOOCOMMERCE',
    createdAt: new Date('2026-07-17T12:00:00.000Z'),
    store: { name: 'Test store' },
  };

  it('normalizes common Excel and API order-number formatting differences', () => {
    expect(normalizeOrderReference(' # 1234 ')).toBe('1234');
    expect(orderReferenceVariants('# 1234')).toEqual(
      expect.arrayContaining(['# 1234', '1234', '#1234']),
    );
  });

  it('alerts once an API order has been missing from Excel for seven days', () => {
    const result = findApiOrdersMissingFromExcel([apiOrder], [], 7, now);

    expect(result).toHaveLength(1);
    expect(result[0].notificationAt.toISOString()).toBe(
      '2026-07-24T12:00:00.000Z',
    );
  });

  it('does not alert before seven days or when the same store has the Excel order', () => {
    const recentOrder = {
      ...apiOrder,
      id: 'api-order-2',
      createdAt: new Date('2026-07-18T12:00:00.000Z'),
    };
    const result = findApiOrdersMissingFromExcel(
      [apiOrder, recentOrder],
      [{ storeId: 'store-1', externalOrderNumber: '1234' }],
      7,
      now,
    );

    expect(result).toEqual([]);
  });

  it('does not match an identical order number belonging to another store', () => {
    const result = findApiOrdersMissingFromExcel(
      [apiOrder],
      [{ storeId: 'store-2', externalOrderNumber: '1234' }],
      7,
      now,
    );

    expect(result).toHaveLength(1);
  });
});
