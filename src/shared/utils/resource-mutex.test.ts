/**
 * Unit tests for ResourceMutex
 */

import { describe, expect, test } from 'bun:test';
import { ResourceMutex } from './resource-mutex.ts';

describe('ResourceMutex', () => {
  test('runExclusively_givenTwoOperationsOnTheSameKey_runsTheSecondOnlyAfterTheFirstCompletes', async () => {
    const mutex = new ResourceMutex();
    const events: string[] = [];
    let releaseFirst = () => {};

    const firstReleased = new Promise<void>(resolve => {
      releaseFirst = resolve;
    });

    const first = mutex.runExclusively('instance-a', async () => {
      events.push('first:start');
      await firstReleased;
      events.push('first:end');
    });
    const second = mutex.runExclusively('instance-a', async () => {
      events.push('second:start');
    });

    await Bun.sleep(5);

    expect(events).toEqual(['first:start']);

    releaseFirst();
    await Promise.all([first, second]);

    expect(events).toEqual(['first:start', 'first:end', 'second:start']);
  });

  test('runExclusively_givenOperationsOnDifferentKeys_doesNotSerializeThemAgainstEachOther', async () => {
    const mutex = new ResourceMutex();
    const events: string[] = [];
    let releaseA = () => {};

    const aReleased = new Promise<void>(resolve => {
      releaseA = resolve;
    });

    const a = mutex.runExclusively('instance-a', async () => {
      await aReleased;
      events.push('a');
    });
    const b = mutex.runExclusively('instance-b', async () => {
      events.push('b');
    });

    await b;

    // Held work on one resource must not stall an unrelated one, or a single
    // slow instance would serialize the whole emulator.
    expect(events).toEqual(['b']);

    releaseA();
    await a;
  });

  test('runExclusively_whenTheHolderRejects_stillRunsTheNextOperationForThatKey', async () => {
    const mutex = new ResourceMutex();

    const failed = mutex.runExclusively('instance-a', () =>
      Promise.reject(new Error('holder failed'))
    );

    await expect(failed).rejects.toThrow('holder failed');

    // A predecessor's failure is its caller's problem, not a reason to wedge
    // every later operation on that resource.
    const result = await mutex.runExclusively('instance-a', () => Promise.resolve('ran'));

    expect(result).toBe('ran');
  });

  test('runExclusively_afterTheQueueForAKeyDrains_forgetsThatKey', async () => {
    const mutex = new ResourceMutex();

    await mutex.runExclusively('instance-a', () => Promise.resolve());
    await mutex.runExclusively('instance-b', () => Promise.resolve());

    // Otherwise the map grows once per instance name the emulator ever sees.
    expect(mutex.trackedKeyCount()).toBe(0);
  });

  test('runExclusively_propagatesTheOperationsResolvedValue', async () => {
    const mutex = new ResourceMutex();

    const result = await mutex.runExclusively('instance-a', () => Promise.resolve({ id: 7 }));

    expect(result).toEqual({ id: 7 });
  });
});
