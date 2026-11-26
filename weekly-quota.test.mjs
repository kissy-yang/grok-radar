import {strict as assert} from 'node:assert';
import {test} from 'node:test';
import {summarizeWeeklyQuota} from './weekly-quota.mjs';

const HOUR_MS = 60 * 60 * 1000;
const resetAt = '2026-12-08T00:00:00Z';
const sampledAt = '2026-12-06T18:00:00Z';
const now = Date.parse(sampledAt) + HOUR_MS;
const quota = (remainingPercent, overrides = {}) => ({remainingPercent, updatedAt: sampledAt, resetAt, ...overrides});

test('estimates when 14% will run out using the sample’s weekly average', () => {
  const summary = summarizeWeeklyQuota(quota(14), now);
  assert.equal(summary.remainingPercent, 14);
  assert.equal(summary.updatedAt, Date.parse(sampledAt));
  assert.equal(summary.resetAt, Date.parse(resetAt));
  assert.equal(summary.untilResetMs, 29 * HOUR_MS);
  assert.equal(summary.pacePercent, 105);
  assert.ok(Math.abs(summary.expectedRemainingPercent - 100 * 30 / (7 * 24)) < 1e-9);
  assert.ok(Math.abs(summary.estimatedMs - (138 * 14 / 86 - 1) * HOUR_MS) < 1e-6);
  assert.equal(summary.forecast, 'estimate');
});

test('reports that allowance on or below the expected pace lasts until reset', () => {
  const halfway = '2026-12-04T12:00:00Z';
  const midpoint = Date.parse(halfway);
  const onPace = summarizeWeeklyQuota(quota(50, {updatedAt: halfway}), midpoint);
  assert.equal(onPace.pacePercent, 100);
  assert.equal(onPace.expectedRemainingPercent, 50);
  assert.equal(onPace.forecast, 'until-reset');
  assert.equal(onPace.estimatedMs, null);
  const unused = summarizeWeeklyQuota(quota(100), now);
  assert.equal(unused.pacePercent, 0);
  assert.equal(unused.forecast, 'until-reset');
  assert.equal(unused.estimatedMs, null);
});

test('keeps a confirmed zero balance without a scheduled reset', () => {
  const summary = summarizeWeeklyQuota(quota(0, {resetAt: null}), now);
  assert.equal(summary.remainingPercent, 0);
  assert.equal(summary.resetAt, null);
  assert.equal(summary.untilResetMs, null);
  assert.equal(summary.pacePercent, null);
  assert.equal(summary.estimatedMs, null);
  assert.equal(summary.forecast, 'depleted');
  assert.equal(summarizeWeeklyQuota(quota(0), now).forecast, 'depleted');
});

test('uses the displayed whole-percent pace for a near-budget forecast', () => {
  const halfway = '2026-12-04T12:00:00Z';
  const midpoint = Date.parse(halfway);
  const rounded = summarizeWeeklyQuota(quota(49.9, {updatedAt: halfway}), midpoint);
  assert.equal(rounded.pacePercent, 100);
  assert.equal(rounded.forecast, 'until-reset');
  const fast = summarizeWeeklyQuota(quota(49.7, {updatedAt: halfway}), midpoint);
  assert.equal(fast.pacePercent, 101);
  assert.equal(fast.forecast, 'estimate');
});

test('shows a valid balance while cycle timing is missing or unsuitable for an estimate', () => {
  for (const overrides of [
    {resetAt: undefined},
    {resetAt: 'invalid'},
    {updatedAt: '2026-12-01T00:00:00Z'},
    {updatedAt: '2026-11-30T23:59:00Z'},
  ]) {
    const summary = summarizeWeeklyQuota(quota(65, overrides), now);
    assert.equal(summary.remainingPercent, 65);
    assert.equal(summary.forecast, 'unavailable');
    assert.equal(summary.pacePercent, null);
    assert.equal(summary.expectedRemainingPercent, null);
    assert.equal(summary.estimatedMs, null);
  }
});

test('flags an estimate in the past while retaining the recorded balance', () => {
  const summary = summarizeWeeklyQuota(quota(14), Date.parse('2026-12-07T18:00:00Z'));
  assert.equal(summary.remainingPercent, 14);
  assert.equal(summary.forecast, 'outdated');
  assert.equal(summary.estimatedMs, null);
});

test('rejects missing balances, invalid readings and readings from an elapsed cycle', () => {
  for (const input of [
    undefined, null, {}, quota(-1), quota(100.1), quota(NaN), quota(Infinity), quota('14'),
    quota(14, {updatedAt: 'invalid'}), quota(14, {updatedAt: '2026-12-07T00:00:00Z'}),
    quota(14, {resetAt: new Date(now).toISOString()}),
  ]) {
    assert.equal(summarizeWeeklyQuota(input, now), null);
  }
  assert.equal(summarizeWeeklyQuota(quota(14), NaN), null);
});
