import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseOtlp } from './otlp.mjs';

const toAttributes = (values) => Object.entries(values).map(([key, value]) => ({
  key,
  value: typeof value === 'number'
    ? { intValue: String(value) }
    : typeof value === 'boolean' ? { boolValue: value } : { stringValue: value },
}));

function record(eventName, values = {}, body = 'event body') {
  return {
    eventName,
    timeUnixNano: '1795395600123456789',
    attributes: toAttributes(values),
    body: { stringValue: body },
  };
}

function payload(logRecords, surface = 'grok_bot') {
  return {
    resourceLogs: [{
      resource: { attributes: toAttributes({ 'cursor.surface': surface }) },
      scopeLogs: [{ logRecords }],
    }],
  };
}

test('keeps each model request and removes only identical delivery IDs', () => {
  const common = {
    'cursor.conversation.id': 'bot-1',
    'cursor.request.id': 'turn-7',
    'cursor.grok_bot.turn.id': 'turn-7',
    'cursor.model.name': 'grok-4.7-high-fast',
    'cursor.api.request.input_tokens': 100,
    'cursor.api.request.output_tokens': 5,
    'cursor.api.request.cache_read_tokens': 45,
    'cursor.api.request.cache_creation_tokens': 0,
  };
  const first = record('cursor.api.request', {
    ...common,
    'cursor.event.id': 'customer-telemetry:v1:request-1',
  });
  const second = record('cursor.api.request', {
    ...common,
    'cursor.event.id': 'customer-telemetry:v1:request-2',
    'cursor.api.request.output_tokens': 12,
  });
  const { events, skipped } = parseOtlp(payload([first, second, first]));
  assert.equal(skipped, 1);
  assert.equal(events.length, 2);
  assert.deepEqual(events[0], {
    id: 'otlp:customer-telemetry:v1:request-1',
    at: new Date(1795395600123).toISOString(),
    source: 'inference',
    title: '模型请求',
    route: null,
    agent: 'bot-1',
    status: 'done',
    latencyMs: null,
    inputTokens: 100,
    outputTokens: 5,
    cacheReadTokens: 45,
    cacheWriteTokens: 0,
    actualUsd: null,
    baselineUsd: null,
    model: 'grok-4.7-high-fast',
    detail: 'Cursor 模型请求日志',
    turnId: 'turn-7',
    requestId: 'turn-7',
  });
  assert.equal(events[1].outputTokens, 12);
});

test('uses log surface when supplied and omits a product alias or absent counts', () => {
  const modeledError = record('cursor.api.error', {
    'cursor.surface': 'grok_bot',
    'cursor.model.name': 'grok-bot-v1',
  });
  const event = parseOtlp(payload([modeledError], 'desktop')).events[0];
  assert.equal(event.status, 'failed');
  assert.equal(event.source, 'inference');
  assert.equal(event.model, null);
  assert.equal(event.inputTokens, null);
  assert.equal(event.id, 'otlp-row:1');
});

test('keeps action outcomes and durations without claiming identical tool IDs are duplicates', () => {
  const common = {
    'cursor.grok_bot.turn.id': 'turn-7',
    'cursor.grok_bot.tool_call.id': 'call-7',
  };
  const records = [
    record('cursor.grok_bot.mcp_tool_call', {
      ...common,
      'cursor.tool.name': 'list_items',
      'cursor.tool.status': 'failure',
      'cursor.grok_bot.mcp.duration_ms': 0,
    }),
    record('cursor.grok_bot.tool_decision', {
      ...common,
      'cursor.grok_bot.decision.outcome': 'denied',
    }),
    record('cursor.grok_bot.shell_command', {
      'cursor.grok_bot.shell.allowed': true,
      'cursor.grok_bot.shell.exit_code': -1,
      'cursor.grok_bot.shell.duration_ms': 123,
    }),
    record('cursor.grok_bot.delegation', {
      'cursor.grok_bot.delegation.direction': 'dispatched',
    }),
    record('cursor.grok_bot.message_delivery', {
      'cursor.grok_bot.message_delivery.destination_type': 'draft',
      'cursor.grok_bot.message_delivery.result': 'held',
    }),
  ];
  const { events, skipped } = parseOtlp(payload(records));
  assert.equal(skipped, 0);
  assert.deepEqual(events.map(({ status }) => status), ['failed', 'ignored', 'failed', 'running', 'draft']);
  assert.deepEqual(events.map(({ latencyMs }) => latencyMs), [0, null, 123, null, null]);
  assert.equal(events[0].title, 'MCP 工具调用 · list_items');
  assert.equal(events[0].turnId, 'turn-7');
  assert.equal(events[0].requestId, null);
  assert.ok(events.every(({ source, route }) => source === 'action' && route === null));
});

test('uses official event names and discards conversation bodies and sensitive action attributes', () => {
  const { events, skipped } = parseOtlp(payload([
    record('cursor.conversation.tool_io', {}, 'grok_bot_tool_result'),
    record('cursor.conversation.user_message', {}, 'private prompt'),
    record(undefined, {}, 'api_request'),
    record('cursor.api.request', { 'cursor.surface': 'desktop' }),
    record('cursor.api.correction'),
    record('cursor.grok_bot.browser_navigation', {
      'cursor.grok_bot.browser.url': 'https://private.invalid/path',
      'cursor.grok_bot.browser.page_title': 'private title',
    }),
    record('cursor.grok_bot.tool_result', { 'cursor.tool.name': '/private/item' }, 'private args'),
    record('cursor.grok_bot.shell_command', { 'cursor.grok_bot.shell.command': 'cat /private/command' }),
  ]));
  assert.equal(skipped, 5);
  assert.deepEqual(events.map(({ title }) => title), ['浏览器导航', '内置工具调用', 'Shell 命令']);
  assert.doesNotMatch(JSON.stringify(events), /private|https:\/\//);
});

test('ignores malformed and out-of-range fields, with observed time as fallback', () => {
  const first = {
    ...record('cursor.api.request', { 'cursor.api.request.input_tokens': -5 }),
    timeUnixNano: '0',
    observedTimeUnixNano: '1000000',
  };
  const second = { ...first, observedTimeUnixNano: '18446744073709551616' };
  const { events, skipped } = parseOtlp(payload([first, null, second]));
  assert.equal(skipped, 2);
  assert.equal(events[0].at, '1970-01-01T00:00:00.001Z');
  assert.equal(events[0].inputTokens, null);
});
