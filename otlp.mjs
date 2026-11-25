// Cursor OpenTelemetry Export Wire Reference
// https://cursor.com/docs/enterprise/opentelemetry-export/wire
import {tr} from './i18n.mjs';

const ACTIONS = new Map([
  ['mcp_tool_call', ['MCP 工具调用', 'MCP tool call', 'cursor.tool.status', 'mcp.duration_ms']],
  ['shell_command', ['Shell 命令', 'Shell command', null, 'shell.duration_ms']],
  ['browser_navigation', ['浏览器导航', 'Browser navigation']],
  ['computer_use_session', ['电脑操作会话', 'Computer use session', null, 'computer_use.duration_ms']],
  ['tool_result', ['内置工具调用', 'Built-in tool call', 'cursor.grok_bot.tool_result.outcome', 'tool_result.duration_ms']],
  ['tool_decision', ['工具审批', 'Tool approval', 'cursor.grok_bot.decision.outcome']],
  ['file_transfer', ['文件传输', 'File transfer', 'cursor.grok_bot.file.outcome']],
  ['message_delivery', ['消息投递', 'Message delivery', 'cursor.grok_bot.message_delivery.result']],
  ['routine_run', ['例程运行', 'Routine run', 'cursor.grok_bot.routine_run.outcome', 'routine_run.duration_ms']],
  ['guardrail', ['规则介入', 'Guardrail action', 'cursor.grok_bot.guardrail.action', 'guardrail.duration_ms']],
  ['delegation', ['委派', 'Delegation', 'cursor.grok_bot.delegation.outcome', 'delegation.duration_ms']],
]);

const englishEventTitles = new Map([
  ['模型请求', 'Model request'],
  ...[...ACTIONS.values()].map(([label, english]) => [label, english]),
]);

export function localizeOtlpEvent(event) {
  if (typeof event?.title !== 'string') return event;
  const [title, ...extra] = event.title.split(' · ');
  return {
    ...event,
    title: [englishEventTitles.get(title) ?? title, ...extra].join(' · '),
    detail: event.detail === 'Cursor 模型错误日志' ? 'Cursor model error log' :
      event.detail === 'Cursor 模型请求日志' ? 'Cursor model request log' : event.detail,
  };
}

const EVENT_KINDS = new Map([
  ['cursor.api.request', 'api_request'],
  ['cursor.api.error', 'api_error'],
  ...Array.from(ACTIONS.keys(), (kind) => [`cursor.grok_bot.${kind}`, kind]),
]);

const OUTCOME = new Map([
  ['success', 'done'],
  ['sent', 'done'],
  ['allowed', 'done'],
  ['continued', 'done'],
  ['failure', 'failed'],
  ['failed', 'failed'],
  ['error', 'failed'],
  ['denied', 'ignored'],
  ['cancelled', 'ignored'],
  ['stopped', 'ignored'],
  ['timed_out', 'failed'],
]);

function list(value) {
  return Array.isArray(value) ? value : [];
}

function attributes(items) {
  const values = new Map();
  for (const item of list(items)) {
    if (typeof item?.key === 'string' && item.value) {
      values.set(item.key, item.value.stringValue ?? item.value.intValue ?? item.value.boolValue);
    }
  }
  return values;
}

function count(value) {
  if (typeof value === 'string' && /^\d{1,16}$/.test(value)) value = Number(value);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function timestamp(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) value = String(value);
  if (typeof value !== 'string' || !/^\d{1,20}$/.test(value)) return null;
  const nanos = BigInt(value);
  if (nanos === 0n || nanos > 18446744073709551615n) return null;
  return new Date(Number(nanos / 1000000n)).toISOString();
}

function identifier(value) {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,511}$/.test(value)
    ? value
    : null;
}

function providerModel(value) {
  const name = identifier(value);
  if (!name || /^(?:grok[-_]?bot(?:[-_.:]|$)|unknown$|auto$|default$)/i.test(name)) return null;
  return name;
}

function actionStatus(kind, outcome, bot) {
  if (kind === 'shell_command') {
    if (bot('shell.allowed') === false) return 'ignored';
    const exit = bot('shell.exit_code');
    if (typeof exit === 'number' && Number.isSafeInteger(exit)) return exit === 0 ? 'done' : 'failed';
    if (typeof exit === 'string' && /^-?\d{1,10}$/.test(exit)) return Number(exit) === 0 ? 'done' : 'failed';
    return null;
  }
  if (kind === 'message_delivery' && outcome === 'held') {
    return bot('message_delivery.destination_type') === 'draft' ? 'draft' : null;
  }
  if (kind === 'tool_decision' && outcome === 'held') return 'ignored';
  if (kind === 'delegation' && bot('delegation.direction') === 'dispatched') return 'running';
  return OUTCOME.get(outcome) ?? null;
}

function toEvent(recordAttrs, resourceAttrs, kind, at, id) {
  const action = ACTIONS.get(kind);
  const inference = !action;
  const [baseTitle, , outcomeKey, durationKey] = action ?? ['模型请求'];
  const bot = (field) => recordAttrs.get(`cursor.grok_bot.${field}`);
  const requestUsage = (field) => count(recordAttrs.get(`cursor.api.request.${field}`));
  const tool = ['mcp_tool_call', 'tool_result', 'tool_decision'].includes(kind)
    ? identifier(recordAttrs.get('cursor.tool.name'))
    : null;
  const requestId = identifier(recordAttrs.get('cursor.request.id'));
  const detail = kind === 'api_error' ? 'Cursor 模型错误日志' : inference ? 'Cursor 模型请求日志' : 'Cursor Action Recording';

  return {
    id,
    at,
    source: inference ? 'inference' : 'action',
    title: tool ? `${baseTitle} · ${tool}` : baseTitle,
    route: null,
    agent: identifier(recordAttrs.get('cursor.conversation.id') ?? resourceAttrs.get('cursor.conversation.id')),
    status: action
      ? actionStatus(kind, recordAttrs.get(outcomeKey), bot)
      : kind === 'api_error' ? 'failed' : 'done',
    latencyMs: durationKey ? count(bot(durationKey)) : null,
    inputTokens: kind === 'api_request' ? requestUsage('input_tokens') : null,
    outputTokens: kind === 'api_request' ? requestUsage('output_tokens') : null,
    cacheReadTokens: kind === 'api_request' ? requestUsage('cache_read_tokens') : null,
    cacheWriteTokens: kind === 'api_request' ? requestUsage('cache_creation_tokens') : null,
    actualUsd: null,
    baselineUsd: null,
    model: inference ? providerModel(recordAttrs.get('cursor.model.name') ?? resourceAttrs.get('cursor.model.name')) : null,
    detail,
    turnId: identifier(bot('turn.id')),
    requestId,
  };
}

export function parseOtlp(payload) {
  const events = [];
  const seen = new Set();
  let skipped = 0;
  let sequence = 0;
  for (const group of list(payload?.resourceLogs)) {
    const resourceAttrs = attributes(group?.resource?.attributes);
    for (const scope of list(group?.scopeLogs)) {
      for (const record of list(scope?.logRecords)) {
        sequence += 1;
        if (sequence > 50_000) throw new Error(tr('单次最多支持导入 50,000 条记录。', 'Import up to 50,000 records at a time.'));
        const attrs = attributes(record?.attributes);
        const surface = attrs.get('cursor.surface') ?? resourceAttrs.get('cursor.surface');
        const kind = EVENT_KINDS.get(record?.eventName);
        const at = timestamp(record?.timeUnixNano) ?? timestamp(record?.observedTimeUnixNano);
        const officialId = identifier(attrs.get('cursor.event.id'));
        if (surface !== 'grok_bot' || !kind || !at || (officialId && seen.has(officialId))) {
          skipped += 1;
          continue;
        }
        if (officialId) seen.add(officialId);
        const id = officialId ? `otlp:${officialId}` : `otlp-row:${sequence}`;
        events.push(toEvent(attrs, resourceAttrs, kind, at, id));
      }
    }
  }
  return { events, skipped, costLabel: '未提供账单金额' };
}
