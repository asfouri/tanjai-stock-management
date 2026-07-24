import { diffByKey, diffMultiset, hashContent } from './refresh-diff';

describe('hashContent', () => {
  it('is stable regardless of object key order', () => {
    expect(hashContent({ a: 1, b: 2 })).toBe(hashContent({ b: 2, a: 1 }));
  });

  it('treats undefined and null as equal, and absent as null', () => {
    expect(hashContent({ a: 1, b: null })).toBe(hashContent({ a: 1, b: undefined }));
    expect(hashContent({ a: 1, b: undefined })).toBe(hashContent({ a: 1 }));
  });

  it('distinguishes different values and types', () => {
    expect(hashContent({ a: 1 })).not.toBe(hashContent({ a: 2 }));
    expect(hashContent({ a: '1' })).not.toBe(hashContent({ a: 1 }));
    expect(hashContent([1, 2])).not.toBe(hashContent([2, 1]));
  });

  it('hashes dates by their timestamp', () => {
    const iso = '2026-07-15T00:00:00.000Z';
    expect(hashContent({ d: new Date(iso) })).toBe(
      hashContent({ d: new Date(iso) }),
    );
    expect(hashContent({ d: new Date(iso) })).not.toBe(
      hashContent({ d: new Date('2026-07-16T00:00:00.000Z') }),
    );
  });
});

describe('diffByKey', () => {
  const existing = [
    { id: 'o1', key: 'A', hash: 'h1' },
    { id: 'o2', key: 'B', hash: 'h2' },
    { id: 'o3', key: 'C', hash: 'h3' },
  ];

  it('skips unchanged, updates changed, inserts new, deletes removed', () => {
    const result = diffByKey(existing, [
      { key: 'A', hash: 'h1', data: { key: 'A' } }, // unchanged -> skip
      { key: 'B', hash: 'h2-new', data: { key: 'B' } }, // changed -> update o2
      { key: 'D', hash: 'h4', data: { key: 'D' } }, // new -> insert
      // C is gone -> delete o3
    ]);

    expect(result.toInsert).toEqual([{ key: 'D' }]);
    expect(result.toUpdate).toEqual([{ id: 'o2', data: { key: 'B' } }]);
    expect(result.toDeleteIds).toEqual(['o3']);
  });

  it('writes nothing when the incoming set is identical', () => {
    const result = diffByKey(existing, [
      { key: 'A', hash: 'h1', data: {} },
      { key: 'B', hash: 'h2', data: {} },
      { key: 'C', hash: 'h3', data: {} },
    ]);
    expect(result.toInsert).toHaveLength(0);
    expect(result.toUpdate).toHaveLength(0);
    expect(result.toDeleteIds).toHaveLength(0);
  });

  it('deletes everything when incoming is empty', () => {
    const result = diffByKey(existing, []);
    expect(result.toDeleteIds.sort()).toEqual(['o1', 'o2', 'o3']);
  });

  it('inserts everything when there is no existing data', () => {
    const result = diffByKey([], [{ key: 'A', hash: 'h', data: { key: 'A' } }]);
    expect(result.toInsert).toEqual([{ key: 'A' }]);
    expect(result.toDeleteIds).toHaveLength(0);
  });

  it('collapses duplicate incoming keys to the first occurrence', () => {
    const result = diffByKey(
      [{ id: 'o1', key: 'A', hash: 'h1' }],
      [
        { key: 'A', hash: 'h1', data: { n: 1 } },
        { key: 'A', hash: 'h9', data: { n: 2 } },
      ],
    );
    expect(result.toInsert).toHaveLength(0);
    expect(result.toUpdate).toHaveLength(0);
    expect(result.toDeleteIds).toHaveLength(0);
  });
});

describe('diffMultiset', () => {
  it('cancels unchanged rows and only writes deltas', () => {
    const existing = [
      { id: 'r1', hash: 'a' },
      { id: 'r2', hash: 'a' },
      { id: 'r3', hash: 'b' },
    ];
    const incoming = [
      { hash: 'a', index: 0 }, // cancels r1 or r2
      { hash: 'b', index: 1 }, // cancels r3
      { hash: 'c', index: 2 }, // new -> insert index 2
    ];
    const result = diffMultiset(existing, incoming);
    expect(result.toInsertIndexes).toEqual([2]);
    expect(result.toDeleteIds).toHaveLength(1); // one leftover 'a' row
    expect(['r1', 'r2']).toContain(result.toDeleteIds[0]);
  });

  it('writes nothing when multisets match', () => {
    const existing = [
      { id: 'r1', hash: 'a' },
      { id: 'r2', hash: 'b' },
    ];
    const incoming = [
      { hash: 'b', index: 0 },
      { hash: 'a', index: 1 },
    ];
    const result = diffMultiset(existing, incoming);
    expect(result.toInsertIndexes).toHaveLength(0);
    expect(result.toDeleteIds).toHaveLength(0);
  });

  it('handles duplicate incoming rows beyond existing copies', () => {
    const existing = [{ id: 'r1', hash: 'a' }];
    const incoming = [
      { hash: 'a', index: 0 }, // cancels r1
      { hash: 'a', index: 1 }, // extra copy -> insert
    ];
    const result = diffMultiset(existing, incoming);
    expect(result.toInsertIndexes).toEqual([1]);
    expect(result.toDeleteIds).toHaveLength(0);
  });

  it('deletes all existing when incoming is empty', () => {
    const existing = [
      { id: 'r1', hash: 'a' },
      { id: 'r2', hash: 'b' },
    ];
    const result = diffMultiset(existing, []);
    expect(result.toDeleteIds.sort()).toEqual(['r1', 'r2']);
  });
});
