import test from 'node:test';
import assert from 'node:assert/strict';
import { createCloudSyncRefreshers } from '../src/utils/cloudSync.ts';

test('poll/reconnect refresh reconciles every data category and maintenance state', async () => {
  const calls = [];
  let maintenance;
  const refreshers = createCloudSyncRefreshers({
    logs: () => calls.push('logs'),
    activity: () => calls.push('activity'),
    suggestions: () => calls.push('suggestions'),
    foremen: () => calls.push('foremen'),
    approvals: () => calls.push('approvals'),
    imports: () => calls.push('imports'),
    fetchStatus: async () => ({ maintenance: { on: true, since: 42 } }),
    maintenance: (value) => { maintenance = value; },
  });
  await refreshers.refreshAll();
  assert.deepEqual(new Set(calls), new Set(['logs', 'activity', 'suggestions', 'foremen', 'approvals', 'imports']));
  assert.equal(calls.length, 6);
  assert.deepEqual(maintenance, { on: true, since: 42 });
});

test('overlapping polling ticks share one in-flight refresh rather than stacking requests', async () => {
  let calls = 0;
  let release;
  const wait = new Promise((resolve) => { release = resolve; });
  const refreshers = createCloudSyncRefreshers({ logs: async () => { calls++; await wait; } });
  const first = refreshers.refreshAll();
  const second = refreshers.refreshAll();
  assert.equal(first, second);
  assert.equal(calls, 1); // the first refresh starts immediately, the second reuses it
  release();
  await Promise.all([first, second]);
  await refreshers.refreshAll();
  assert.equal(calls, 2);
});

test('a failed callback does not prevent other categories from refreshing', async () => {
  let activities = 0;
  const refreshers = createCloudSyncRefreshers({ logs: async () => { throw new Error('offline'); }, activity: () => { activities++; } });
  await assert.doesNotReject(refreshers.refreshAll());
  assert.equal(activities, 1);
});

test('disposing prevents subsequent refreshes', async () => {
  let calls = 0;
  const refreshers = createCloudSyncRefreshers({ logs: () => { calls++; } });
  refreshers.dispose();
  await refreshers.refreshAll();
  assert.equal(calls, 0);
});
