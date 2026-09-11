import { describe, expect, test } from 'bun:test';
import { messageMatchesFilter, parseAttributeFilter } from './attribute-filter.ts';

describe('parseAttributeFilter', () => {
  test('parses a single attribute equality', () => {
    expect(parseAttributeFilter('attributes.foo = "bar"')).toEqual([{ key: 'foo', value: 'bar' }]);
  });

  test('parses AND-joined equalities', () => {
    expect(parseAttributeFilter('attributes.foo = "foo" AND attributes.bar = "bar"')).toEqual([
      { key: 'foo', value: 'foo' },
      { key: 'bar', value: 'bar' },
    ]);
  });

  test('treats blank filters as match-all', () => {
    expect(parseAttributeFilter('')).toEqual([]);
    expect(parseAttributeFilter('   ')).toEqual([]);
  });

  test('rejects unsupported filter syntax', () => {
    expect(() => parseAttributeFilter('attributes.foo != "bar"')).toThrow(/Unsupported/);
    expect(() => parseAttributeFilter('data = "x"')).toThrow(/Unsupported/);
  });
});

describe('messageMatchesFilter', () => {
  test('matches when every clause is present', () => {
    expect(
      messageMatchesFilter(
        { foo: 'foo', bar: 'bar' },
        'attributes.foo = "foo" AND attributes.bar = "bar"'
      )
    ).toBe(true);
  });

  test('rejects when a clause is missing', () => {
    expect(
      messageMatchesFilter({ foo: 'foo' }, 'attributes.foo = "foo" AND attributes.bar = "bar"')
    ).toBe(false);
  });

  test('empty filter matches any attributes', () => {
    expect(messageMatchesFilter(undefined, null)).toBe(true);
    expect(messageMatchesFilter({ a: 'b' }, '')).toBe(true);
  });
});
