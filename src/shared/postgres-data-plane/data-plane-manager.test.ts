import { describe, expect, test } from 'bun:test';
import { DisabledDataPlane } from './data-plane-manager.ts';

describe('DisabledDataPlane', () => {
  test('advertises no port and does nothing for every lifecycle call', async () => {
    const dataPlane = new DisabledDataPlane();

    expect(await dataPlane.startInstance()).toBeNull();
    expect(dataPlane.getPort()).toBeNull();

    await expect(dataPlane.stopInstance()).resolves.toBeUndefined();
    await expect(dataPlane.dropInstance()).resolves.toBeUndefined();
    await expect(dataPlane.restartInstance()).resolves.toBeUndefined();
    await expect(dataPlane.openDatabase()).resolves.toBeUndefined();
    await expect(dataPlane.dropDatabase()).resolves.toBeUndefined();
    await expect(dataPlane.stopAll()).resolves.toBeUndefined();
    await expect(dataPlane.upsertUser()).resolves.toBeUndefined();
    await expect(dataPlane.dropUser()).resolves.toBeUndefined();
  });
});
