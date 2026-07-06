import { parseRows } from './excel-openxml';

describe('parseRows', () => {
  it('ignores self-closing styled empty cells without consuming shared-string cells', () => {
    const rows = parseRows(
      '<worksheet><sheetData><row r="1"><c r="A1" s="24"/><c r="B1" s="167" t="s"><v>0</v></c><c r="C1"><v>42</v></c></row></sheetData></worksheet>',
      ['hello'],
      'Sheet1',
    );

    expect(rows).toEqual([{ rowNumber: 1, cells: { 2: 'hello', 3: 42 } }]);
    expect(rows[0].cells[1]).toBeUndefined();
  });

  it('keeps value columns stable after consecutive self-closing cells', () => {
    const rows = parseRows(
      '<worksheet><sheetData><row r="2"><c r="A2" s="24"/><c r="B2" s="24"/><c r="C2"><v>42</v></c></row></sheetData></worksheet>',
      [],
      'Sheet1',
    );

    expect(rows).toEqual([{ rowNumber: 2, cells: { 3: 42 } }]);
  });

  it('resolves shared-string cells instead of returning their numeric index', () => {
    const rows = parseRows(
      '<worksheet><sheetData><row r="3"><c r="A3" t="s"><v>0</v></c></row></sheetData></worksheet>',
      ['hello'],
      'Sheet1',
    );

    expect(rows).toEqual([{ rowNumber: 3, cells: { 1: 'hello' } }]);
  });
});
