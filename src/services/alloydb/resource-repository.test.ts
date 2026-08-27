import { beforeEach, describe, expect, test } from 'bun:test';
import { StorageManager } from '@/core/storage/manager.ts';
import type { BaseRecord, TableSchema } from '@/core/storage/types.ts';
import type { ListByPrefixResult, NamedRecord } from './resource-repository.ts';
import { ResourceRepository } from './resource-repository.ts';

const WIDGETS_TABLE = 'alloydb_test_widgets';

interface WidgetRecord extends NamedRecord {
  note: string;
}

const widgetTableSchema: TableSchema = {
  name: WIDGETS_TABLE,
  columns: [
    { name: 'name', type: 'string', unique: true },
    { name: 'note', type: 'string' },
  ],
  indexes: [{ name: `idx_${WIDGETS_TABLE}_name`, columns: ['name'], unique: true }],
  timestamps: true,
};

/** Exercises the base contract directly rather than through one real resource. */
class WidgetRepository extends ResourceRepository<WidgetRecord> {
  constructor(storage: StorageManager) {
    super(storage, WIDGETS_TABLE, widgetTableSchema, 'widget');
  }

  listUnder(prefix: string, pageSize?: number, pageToken?: string) {
    return this.listByPrefix(prefix, pageSize, pageToken);
  }
}

const PREFIX = 'projects/p/locations/us-central1/widgets/';

let storage: StorageManager;
let repository: WidgetRepository;

function widget(name: string): Omit<WidgetRecord, keyof BaseRecord> {
  return { name, note: 'n' };
}

async function listedNames(result: ListByPrefixResult<WidgetRecord>): Promise<string[]> {
  return result.records.map(record => record.name);
}

beforeEach(async () => {
  storage = new StorageManager();
  await storage.initialize({ type: 'memory' });

  repository = new WidgetRepository(storage);
  await repository.initialize();
});

describe('initialize', () => {
  test('initialize_createsTheTable', async () => {
    expect(await storage.listTables()).toContain(WIDGETS_TABLE);
  });

  test('initialize_calledTwice_doesNotThrow', async () => {
    await repository.initialize();

    expect(await storage.listTables()).toContain(WIDGETS_TABLE);
  });
});

describe('create', () => {
  test('create_persistsAndReturnsTheRecord', async () => {
    const created = await repository.create(widget(`${PREFIX}w1`));

    expect(created.name).toBe(`${PREFIX}w1`);
    expect(created.id).toBeTypeOf('string');
    expect(await repository.getByName(`${PREFIX}w1`)).not.toBeNull();
  });

  /**
   * The in-memory provider does not enforce unique indexes, so without an
   * explicit guard a duplicate inserts cleanly in memory mode and fails only
   * under SQLite — a bug that hides in exactly the mode developers run.
   */
  test('create_givenADuplicateName_throwsInsteadOfInsertingASecondRow', async () => {
    await repository.create(widget(`${PREFIX}w1`));

    await expect(repository.create(widget(`${PREFIX}w1`))).rejects.toThrow(/already exists/i);
    expect(await storage.count(WIDGETS_TABLE)).toBe(1);
  });

  test('create_reportsTheResourceLabelItWasConstructedWith', async () => {
    await repository.create(widget(`${PREFIX}w1`));

    await expect(repository.create(widget(`${PREFIX}w1`))).rejects.toThrow(/widget/i);
  });
});

describe('getByName', () => {
  test('getByName_givenAnUnknownName_returnsNull', async () => {
    expect(await repository.getByName(`${PREFIX}nope`)).toBeNull();
  });

  /**
   * Lookup is an exact match, not a prefix match: `w1` must not resolve to `w10`.
   */
  test('getByName_doesNotResolveAnIdThatMerelySharesAPrefix', async () => {
    await repository.create(widget(`${PREFIX}w10`));

    expect(await repository.getByName(`${PREFIX}w1`)).toBeNull();
    expect((await repository.getByName(`${PREFIX}w10`))?.name).toBe(`${PREFIX}w10`);
  });
});

describe('update', () => {
  test('update_appliesThePatchAndPersistsIt', async () => {
    await repository.create(widget(`${PREFIX}w1`));

    const updated = await repository.update(`${PREFIX}w1`, { note: 'changed' });

    expect(updated?.note).toBe('changed');
    expect((await repository.getByName(`${PREFIX}w1`))?.note).toBe('changed');
  });

  test('update_givenAnUnknownName_returnsNull', async () => {
    expect(await repository.update(`${PREFIX}nope`, { note: 'x' })).toBeNull();
  });
});

describe('delete', () => {
  test('delete_removesTheRecord', async () => {
    await repository.create(widget(`${PREFIX}w1`));

    expect(await repository.delete(`${PREFIX}w1`)).toBe(true);
    expect(await repository.getByName(`${PREFIX}w1`)).toBeNull();
  });

  test('delete_givenAnUnknownName_returnsFalse', async () => {
    expect(await repository.delete(`${PREFIX}nope`)).toBe(false);
  });
});

describe('listByPrefix', () => {
  test('listByPrefix_returnsMatchingRecordsSortedByName', async () => {
    for (const id of ['w3', 'w1', 'w2']) {
      await repository.create(widget(`${PREFIX}${id}`));
    }

    expect(await listedNames(await repository.listUnder(PREFIX))).toEqual([
      `${PREFIX}w1`,
      `${PREFIX}w2`,
      `${PREFIX}w3`,
    ]);
  });

  test('listByPrefix_excludesRecordsOutsideThePrefix', async () => {
    await repository.create(widget(`${PREFIX}w1`));
    await repository.create(widget('projects/p/locations/europe-west1/widgets/w1'));
    await repository.create(widget('projects/other/locations/us-central1/widgets/w1'));

    expect(await listedNames(await repository.listUnder(PREFIX))).toEqual([`${PREFIX}w1`]);
  });

  /**
   * The prefix carries its own trailing separator so sibling parents whose ids
   * share a prefix stay isolated — listing `c1`'s children must not return
   * `c10`'s.
   */
  test('listByPrefix_isolatesParentsWhoseIdsShareAPrefix', async () => {
    await repository.create(widget('projects/p/locations/l/clusters/c1/widgets/w1'));
    await repository.create(widget('projects/p/locations/l/clusters/c10/widgets/w1'));

    const result = await repository.listUnder('projects/p/locations/l/clusters/c1/widgets/');

    expect(await listedNames(result)).toEqual(['projects/p/locations/l/clusters/c1/widgets/w1']);
  });

  test('listByPrefix_givenAPageSizeSmallerThanTheResultSet_paginatesWithoutOverlap', async () => {
    for (const id of ['w1', 'w2', 'w3']) {
      await repository.create(widget(`${PREFIX}${id}`));
    }

    const firstPage = await repository.listUnder(PREFIX, 2);

    expect(await listedNames(firstPage)).toEqual([`${PREFIX}w1`, `${PREFIX}w2`]);
    expect(firstPage.nextPageToken).toBe('2');

    const secondPage = await repository.listUnder(PREFIX, 2, firstPage.nextPageToken);

    expect(await listedNames(secondPage)).toEqual([`${PREFIX}w3`]);
    expect(secondPage.nextPageToken).toBeUndefined();
  });

  test('listByPrefix_givenNoMatches_returnsAnEmptyListAndNoToken', async () => {
    const result = await repository.listUnder(PREFIX);

    expect(result.records).toEqual([]);
    expect(result.nextPageToken).toBeUndefined();
  });

  // A malformed page token must not be treated as a bogus offset that silently
  // skips records; pagination falls back to the first page.
  test('listByPrefix_givenAMalformedPageToken_startsFromTheBeginning', async () => {
    await repository.create(widget(`${PREFIX}w1`));

    expect(await listedNames(await repository.listUnder(PREFIX, 10, 'not-a-number'))).toEqual([
      `${PREFIX}w1`,
    ]);
  });
});

describe('countByPrefix', () => {
  test('countByPrefix_countsOnlyRecordsBeneaththePrefix', async () => {
    await repository.create(widget(`${PREFIX}w1`));
    await repository.create(widget(`${PREFIX}w2`));
    await repository.create(widget('projects/p/locations/europe-west1/widgets/w1'));

    expect(await repository.countByPrefix(PREFIX)).toBe(2);
  });

  test('countByPrefix_givenNoMatches_returnsZero', async () => {
    expect(await repository.countByPrefix(PREFIX)).toBe(0);
  });
});

describe('deleteByPrefix', () => {
  test('deleteByPrefix_removesEveryRecordBeneathThePrefixAndLeavesOthers', async () => {
    await repository.create(widget(`${PREFIX}w1`));
    await repository.create(widget(`${PREFIX}w2`));
    await repository.create(widget('projects/p/locations/europe-west1/widgets/w1'));

    expect(await repository.deleteByPrefix(PREFIX)).toBe(2);
    expect(await repository.countByPrefix(PREFIX)).toBe(0);
    expect(
      await repository.getByName('projects/p/locations/europe-west1/widgets/w1')
    ).not.toBeNull();
  });

  test('deleteByPrefix_givenNoMatches_deletesNothing', async () => {
    expect(await repository.deleteByPrefix(PREFIX)).toBe(0);
  });
});
