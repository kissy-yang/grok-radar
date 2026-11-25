import assert from 'node:assert/strict';
import test from 'node:test';
import { parseImport } from './data.mjs';

const AT = '2026-11-23T01:20:00.000Z';
const GROK_HEADERS = [
  'Billing Item ID', 'Event Time', 'Product', 'Charge Category', 'Usage Type',
  'Principal Type', 'Principal ID', 'Usage', 'Pricing Currency', 'Pricing Contracted', 'Model', 'User Email',
];
const CURSOR_HEADERS = [
  'Date', 'Cloud Agent ID', 'Automation ID', 'Kind', 'Model', 'Max Mode',
  'Input (w/ Cache Write)', 'Input (w/o Cache Write)', 'Cache Read', 'Output Tokens', 'Total Tokens', 'Cost',
];

function csv(rows) {
  return rows.map((row) => row.map((value) => `"${value.replaceAll('"', '""')}"`).join(',')).join('\r\n');
}

test('normalizes events with an explicit offset, preserves custom labels and measured zeros', () => {
  const input = {
    events: [{
      id: 'r-1', at: '2026-11-23T09:20:00+08:00', source: '内部队列', title: '  完成任务  ',
      route: 'DISPATCHED', agent: '回复 Bot', status: 'DONE', latencyMs: 23.4, inputTokens: 0,
      outputTokens: 23, actualUsd: 0, baselineUsd: 0.025, detail: '  已发出回复  ', turnId: 'turn-1',
    }],
  };
  const result = parseImport(`\uFEFF${JSON.stringify(input)}`, 'events.JSON');
  assert.deepEqual(result, {
    events: [{
      id: 'r-1', at: AT, source: '内部队列', title: '完成任务',
      route: 'dispatched', agent: '回复 Bot', status: 'done', latencyMs: 23.4, inputTokens: 0,
      outputTokens: 23, cacheReadTokens: null, cacheWriteTokens: null, actualUsd: 0,
      baselineUsd: 0.025, model: null, detail: '已发出回复', turnId: 'turn-1', requestId: null,
    }],
    skipped: 0,
    costLabel: '实际费用（USD）',
  });
});

test('skips invalid times and nulls malformed metrics without reinterpreting numeric strings', () => {
  const input = [
    null, { at: '2026-11-23T09:20:00' }, { at: '2026-02-30T00:00:00Z' }, { at: '2026-11-23' },
    { at: AT, route: 'missing', status: 'ok', actualUsd: '-0.1', baselineUsd: -3, latencyMs: '5',
      inputTokens: 4.3, outputTokens: 9_007_199_254_740_992, detail: { accidental: 'payload' } },
  ];
  const { events, skipped } = parseImport(JSON.stringify(input), 'events.json');
  assert.equal(skipped, 4);
  assert.equal(events[0].source, '未标注来源');
  assert.equal(events[0].title, '未命名事件');
  for (const key of ['route', 'status', 'actualUsd', 'baselineUsd', 'latencyMs', 'inputTokens', 'outputTokens', 'detail']) {
    assert.equal(events[0][key], null, key);
  }
});

test('allows duplicate and missing IDs while keeping a unique selection key for every row', () => {
  const input = [{ id: 'a' }, { id: 'a (2)' }, { id: 'a' }, { id: 'event-5' }, {}, { id: 'a' }];
  const { events } = parseImport(JSON.stringify(input.map((row) => ({ ...row, at: AT }))), 'events.json');
  assert.deepEqual(events.map(({ id }) => id), ['a', 'a (2)', 'a (3)', 'event-5', 'event-5 (2)', 'a (4)']);
});

test('imports Grok.com billing token buckets, keeping only Grok Bot and USD charges', () => {
  const usage = JSON.stringify({
    'prompt-text-tokens': '2', 'cached-prompt-text-tokens': '130000',
    'cache-write-text-tokens': '600', 'completion-text-tokens': '0',
  });
  const grok = ['billing-1', AT, 'grok-bot', 'model', 'included', 'user', 'private-id', usage, 'USD', '0.0000000000', '', 'private@example.test'];
  const charged = ['billing-2', AT, 'grok-bot', 'model', 'on_demand', '', '', usage, 'USD', '0.0426060000', '', ''];
  const wrongCurrency = ['billing-3', AT, 'grok-bot', 'model', 'on_demand', '', '', '{malformed}', 'EUR', '1.25', '', ''];
  const other = ['billing-4', AT, 'cursor', 'model', 'on_demand', '', '', usage, 'USD', '1.25', 'grok-4.7', ''];
  const input = `\uFEFF${csv([GROK_HEADERS, grok, charged, charged, wrongCurrency, other])}`;
  const result = parseImport(input, 'grok.csv');

  assert.equal(result.skipped, 2);
  assert.equal(result.costLabel, 'Grok.com · Pricing Contracted（USD）');
  assert.deepEqual(result.events[0], {
    id: 'billing-1', at: AT, source: 'billing', title: 'Grok Bot 用量', route: null, agent: null,
    status: null, latencyMs: null, inputTokens: 2, outputTokens: 0, cacheReadTokens: 130000,
    cacheWriteTokens: 600, actualUsd: 0, baselineUsd: null, model: null, detail: '订阅内用量', turnId: null, requestId: null,
  });
  assert.equal(result.events[1].actualUsd, 0.042606);
  assert.equal(result.events[2].actualUsd, null);
  assert.equal(result.events[2].inputTokens, null);
  assert.match(result.events[2].detail, /EUR/);
  assert.doesNotMatch(JSON.stringify(result), /private|grok-4\.7/);
});

test('imports only explicit Cursor Grok Bot tags and preserves duplicate CSV lines', () => {
  const metered = [AT, 'agent, "A"\nsecond line', '', 'On-Demand', 'grok-bot-automation', '', '', '3', '1,200', '8', '1211', '$0.022'];
  const included = [AT, '', '', 'Included', 'grok-bot', '', '0', '4.5', '', '0', '', 'Included'];
  const other = [AT, '', '', '', 'cursor-grok-4.6-high', '', '', '2', '', '', '', '$90'];
  const nearMatch = [AT, '', '', '', 'grok-botany', '', '', '2', '', '', '', '$90'];
  const invalidTime = ['tomorrow', '', '', '', 'grok-bot-automation', '', '', '2', '', '', '', '$90'];
  const result = parseImport(csv([CURSOR_HEADERS, metered, metered, included, other, nearMatch, invalidTime]), 'cursor.csv');

  assert.equal(result.skipped, 3);
  assert.equal(result.costLabel, 'Cursor CSV · Cost（USD）');
  assert.equal(result.events.length, 3);
  const [first, duplicate, covered] = result.events;
  assert.notEqual(first.id, duplicate.id);
  assert.deepEqual(first, { ...duplicate, id: first.id });
  assert.equal(first.actualUsd, 0.022);
  assert.equal(first.model, null);
  assert.equal(first.cacheReadTokens, 1200);
  assert.equal(first.cacheWriteTokens, null);
  assert.equal(covered.actualUsd, null);
  assert.equal(covered.inputTokens, null);
  assert.equal(covered.outputTokens, 0);
  assert.match(covered.detail, /订阅内用量/);
  assert.doesNotMatch(JSON.stringify(result), /second line|cursor-grok-4\.6|grok-botany/);
});

test('reports recognizable import errors without guessing product attribution', () => {
  assert.throws(() => parseImport('', 'events.csv'), /为空/);
  assert.throws(() => parseImport('{', 'events.json'), /JSON/);
  assert.throws(() => parseImport('{}', 'events.json'), /events 数组/);
  assert.throws(() => parseImport('date,cost\n01,0', 'generic.csv'), /未识别 CSV 表头/);
  assert.throws(() => parseImport(`Date,Model,Cost\n${AT},cursor-grok-4.6,0`, 'cursor.csv'), /未找到可导入的 Grok Bot 行/);
  assert.throws(() => parseImport(`Date,Model,Cost,Product\n${AT},grok-bot,0,cursor`, 'cursor.csv'), /未找到可导入的 Grok Bot 行/);
  assert.throws(() => parseImport(`Date,Model,Cost\n${AT},grok-bot,"0`, 'cursor.csv'), /未闭合/);
  assert.throws(() => parseImport(`Date,Model,Cost,cost\n${AT},grok-bot,0,1`, 'cursor.csv'), /重复列名/);
});

test('bounds imported text, row counts and normalized display fields', () => {
  assert.throws(() => parseImport('x'.repeat(12 * 1024 * 1024 + 1), 'events.json'), /文件过大/);
  assert.throws(() => parseImport(JSON.stringify(Array(50_001).fill({ at: AT })), 'events.json'), /50,000/);
  const title = '字'.repeat(400);
  const detail = '文'.repeat(1000);
  const { events } = parseImport(JSON.stringify([{ at: AT, title, detail }]), 'events.json');
  assert.equal(events[0].title.length, 240);
  assert.equal(events[0].detail.length, 600);
});
