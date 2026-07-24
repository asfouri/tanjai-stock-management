import { PrismaService } from '../../../infrastructure/database/prisma.service';
import { Track17Service } from '../../tracking/services/track17.service';
import { ExcelImportService } from './excel-import.service';
import { ParsedImport } from '../types/import.types';
import { ParsedWorkbook } from '../utilities/excel-openxml';

type ParseWorkbook = (
  workbook: ParsedWorkbook,
  fileName: string,
  fileHash: string,
) => ParsedImport;

function parse(workbook: ParsedWorkbook) {
  const service = new ExcelImportService(
    {} as PrismaService,
    {} as Track17Service,
  );
  return (service as unknown as { parseWorkbook: ParseWorkbook }).parseWorkbook(
    workbook,
    'test.xlsx',
    'test-hash',
  );
}

function sheet(name: string, rows: ParsedWorkbook['sheets'][number]['rows']) {
  return {
    name,
    rows,
    comments: {},
    images: [],
    imageWarnings: [],
    merges: [],
  };
}

describe('ExcelImportService invoice reconciliation', () => {
  it('uses total cost for refunds and canonicalizes written invoice dates', () => {
    const parsed = parse({
      sheets: [
        sheet('Store-DE', [
          { rowNumber: 1, cells: { 1: 'Marcus', 3: '2026/1/20-1' } },
          {
            rowNumber: 2,
            cells: {
              1: 'shop',
              2: 'Order No.',
              3: 'Tracking number',
              4: 'SKU',
              5: 'Lineitem quantity',
              6: 'Product Cost',
              8: 'Shipping cost',
              9: 'Handle Charge',
              10: 'Total cost',
            },
          },
          {
            rowNumber: 3,
            cells: { 2: 100, 3: 'TRACK-100', 4: 'SKU-1', 5: 1, 10: 10 },
          },
          {
            rowNumber: 4,
            cells: { 2: 99, 4: 'redelivery fee', 10: 10 },
          },
          { rowNumber: 5, cells: { 9: '100-refund', 10: -2 } },
          { rowNumber: 6, cells: { 9: 'Total amount', 10: 18 } },
        ]),
        sheet('Payment and balance', [
          {
            rowNumber: 1,
            cells: {
              1: 'Date',
              2: 'Amount',
              3: 'Store name',
              4: 'Invoice No.',
              5: 'invoice Amount',
            },
          },
          {
            rowNumber: 2,
            cells: { 3: 'Store-DE', 4: '2026-1-20-1', 5: 18 },
          },
        ]),
      ],
    });

    expect(parsed.invoices).toEqual([
      expect.objectContaining({
        invoiceReference: '2026-01-20-1',
        refunds: -2,
        adjustments: 10,
        otherCost: 0,
        total: 18,
      }),
    ]);
    expect(parsed.walletTransactions).toEqual([
      expect.objectContaining({
        invoiceReference: '2026-01-20-1',
        amount: -18,
      }),
    ]);
  });

  it('keeps a warning when product components disagree with total cost', () => {
    const parsed = parse({
      sheets: [
        sheet('Store-DE', [
          { rowNumber: 1, cells: { 1: 'Marcus', 3: '2026-01-02' } },
          {
            rowNumber: 2,
            cells: {
              1: 'shop',
              2: 'Order No.',
              3: 'Tracking number',
              4: 'SKU',
              5: 'Lineitem quantity',
              6: 'Product Cost',
              8: 'Shipping cost',
              9: 'Handle Charge',
              10: 'Total cost',
            },
          },
          {
            rowNumber: 3,
            cells: {
              2: 101,
              3: 'TRACK-101',
              4: 'SKU-1',
              5: 1,
              6: 1,
              8: 5,
              9: 1,
              10: 6,
            },
          },
          { rowNumber: 4, cells: { 9: 'Total amount', 10: 6 } },
        ]),
      ],
    });

    expect(parsed.invoices[0]).toEqual(
      expect.objectContaining({ total: 6, otherCost: 0 }),
    );
    expect(parsed.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceRow: 3,
          message:
            'Order 101 line total mismatch: components 7.00, total cost 6.00.',
        }),
      ]),
    );
  });

  it('never associates a deposit with the store on the same Excel row', () => {
    const parsed = parse({
      sheets: [
        sheet('Payment and balance', [
          {
            rowNumber: 1,
            cells: {
              1: 'Date',
              2: 'Amount',
              3: 'Store name',
              4: 'Invoice No.',
              5: 'invoice Amount',
            },
          },
          {
            rowNumber: 2,
            cells: {
              1: '2026-01-12',
              2: 25000,
              3: 'Boltwave-DE',
              4: '2026-1-1',
              5: 186.4,
            },
          },
        ]),
      ],
    });

    const deposit = parsed.walletTransactions.find(
      (transaction) => transaction.transactionType === 'deposit',
    );
    expect(deposit).toEqual(
      expect.objectContaining({ transactionType: 'deposit', amount: 25000 }),
    );
    expect(deposit).not.toHaveProperty('storeName');
    expect(deposit).not.toHaveProperty('invoiceReference');
    expect(parsed.walletTransactions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          transactionType: 'store_invoice',
          amount: -186.4,
          storeName: 'Boltwave-DE',
        }),
      ]),
    );
  });
});
