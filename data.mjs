import {currentLanguage, tr} from './i18n.mjs';
import {localizeOtlpEvent} from './otlp.mjs';

const MAX_IMPORT_LENGTH = 12 * 1024 * 1024;
const MAX_EVENTS = 50_000;
const MAX_CSV_COLUMNS = 128;
const ROUTES = new Set(['ignored', 'dispatched']);
const STATUSES = new Set(['ignored', 'done', 'draft', 'failed', 'running']);
const SOURCES = new Set(['webhook', 'deploy', 'github', 'email', 'billing']);
const CURSOR_COST_TYPES = new Map([['included', '订阅内用量'], ['free', '免费用量']]);
const ZONED_TIME = /^(\d{4}-\d\d-\d\d)[T ](?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,9})?)?(?:Z|[+-]\d\d:\d\d)$/i;

function shortText(value, limit) {
  return typeof value === 'string' ? value.trim().slice(0, limit) || null : null;
}

function enumValue(value, options) {
  const key = shortText(value, 32)?.toLowerCase();
  return options.has(key) ? key : null;
}

function isoTime(value) {
  const time = typeof value === 'string' ? value.trim() : '';
  const match = time.match(ZONED_TIME);
  if (!match) return null;

  const calendarDay = Date.parse(`${match[1]}T00:00:00Z`);
  if (!Number.isFinite(calendarDay) || new Date(calendarDay).toISOString().slice(0, 10) !== match[1]) return null;

  const parsed = Date.parse(time.replace(' ', 'T'));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function nonnegative(value) {
  return Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER ? Math.abs(value) : null;
}

function tokenCount(value) {
  return Number.isSafeInteger(value) ? nonnegative(value) : null;
}

function normalizeEvent(record, trackDisplayDefaults = false) {
  const at = isoTime(record.at);
  if (!at) return null;
  const source = enumValue(record.source, SOURCES) ?? shortText(record.source, 80);
  const title = shortText(record.title, 240);

  return {
    id: shortText(record.id, 160),
    at,
    source: source ?? '未标注来源',
    title: title ?? '未命名事件',
    ...(trackDisplayDefaults && (!source || !title) ? {displayDefaults: {source: !source, title: !title}} : {}),
    route: enumValue(record.route, ROUTES),
    agent: shortText(record.agent, 100),
    status: enumValue(record.status, STATUSES),
    latencyMs: nonnegative(record.latencyMs),
    inputTokens: tokenCount(record.inputTokens),
    outputTokens: tokenCount(record.outputTokens),
    cacheReadTokens: tokenCount(record.cacheReadTokens),
    cacheWriteTokens: tokenCount(record.cacheWriteTokens),
    actualUsd: nonnegative(record.actualUsd),
    baselineUsd: nonnegative(record.baselineUsd),
    model: shortText(record.model, 160),
    detail: shortText(record.detail, 600),
    turnId: shortText(record.turnId, 160),
    requestId: shortText(record.requestId, 160),
  };
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function collectEvents(rows, makeEvent, costLabel) {
  if (rows.length > MAX_EVENTS) throw new Error(tr("单次最多支持导入 50,000 条记录。", "Import up to 50,000 records at a time."));

  const events = [];
  const ids = new Set();
  const nextSuffix = new Map();
  for (const [index, row] of rows.entries()) {
    const event = makeEvent(row);
    if (!event) continue;

    const base = event.id ?? `event-${index + 1}`;
    let id = base;
    let suffix = nextSuffix.get(base) ?? 2;
    while (ids.has(id)) {
      id = `${base} (${suffix})`;
      suffix += 1;
    }
    nextSuffix.set(base, suffix);
    ids.add(id);
    events.push({ ...event, id });
  }
  return { events, skipped: rows.length - events.length, costLabel };
}

function parseJsonImport(text, trackDisplayDefaults) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(tr("无法读取 JSON。请检查文件语法。", "Could not read the JSON file. Check its syntax."));
  }
  const rows = Array.isArray(parsed) ? parsed : parsed?.events;
  if (!Array.isArray(rows)) throw new Error(tr("JSON 应为事件数组，或包含 events 数组的对象。", "Use a JSON array of events or an object with an events array."));
  return collectEvents(rows, (row) => isObject(row) ? normalizeEvent(row, trackDisplayDefaults) : null, '实际费用（USD）');
}

function parseCsvRows(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuote = false;
  let afterQuote = false;

  function endField() {
    row.push(field);
    if (row.length > MAX_CSV_COLUMNS) throw new Error(tr("CSV 的列数超出导入上限。", "The CSV exceeds the column limit."));
    field = '';
    afterQuote = false;
  }

  function endRow() {
    endField();
    if (row.some((value) => value.trim())) rows.push(row);
    if (rows.length > MAX_EVENTS + 1) throw new Error(tr("单次最多支持导入 50,000 条记录。", "Import up to 50,000 records at a time."));
    row = [];
  }

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (inQuote) {
      if (char !== '"') {
        field += char;
      } else if (text[i + 1] === '"') {
        field += '"';
        i += 1;
      } else {
        inQuote = false;
        afterQuote = true;
      }
    } else if (char === ',') {
      endField();
    } else if (char === '\r' || char === '\n') {
      if (char === '\r' && text[i + 1] === '\n') i += 1;
      endRow();
    } else if (afterQuote && (char === ' ' || char === '\t')) {
      continue;
    } else if (char === '"' && !afterQuote && !field.trim()) {
      field = '';
      inQuote = true;
    } else if (char === '"' || afterQuote) {
      throw new Error(tr("CSV 中有无效的引号。请重新导出原始文件。", "The CSV contains invalid quotes. Export the file again."));
    } else {
      field += char;
    }
  }

  if (inQuote) throw new Error(tr("CSV 中有未闭合的引号。请重新导出原始文件。", "The CSV contains an unclosed quote. Export the file again."));
  endRow();
  return rows;
}

function csvNumber(value, { integer = false, dollar = false } = {}) {
  if (typeof value === 'number') return integer ? tokenCount(value) : nonnegative(value);
  let text = typeof value === 'string' ? value.trim() : '';
  if (!text || text.length > 80) return null;
  if (dollar && text.startsWith('$')) text = text.slice(1).trim();
  if (!/^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/.test(text)) return null;
  if (integer && text.includes('.')) return null;
  const number = Number(text.replaceAll(',', ''));
  return integer ? tokenCount(number) : nonnegative(number);
}

function usageObject(value) {
  if (!value) return {};
  try {
    const usage = JSON.parse(value);
    return isObject(usage) ? usage : {};
  } catch {
    return {};
  }
}

function billingEvent(values) {
  return normalizeEvent({
    source: 'billing',
    title: 'Grok Bot 用量',
    ...values,
  });
}

function grokBillingEvent(get) {
  if (get('product').toLowerCase() !== 'grok-bot') return null;

  const usage = usageObject(get('usage'));
  const usageType = get('usage type').toLowerCase();
  const currency = get('pricing currency').toUpperCase();
  const plan = usageType === 'included' ? '订阅内用量' : usageType === 'on_demand' ? '按量计费' : null;
  const foreignCurrency = /^[A-Z]{3}$/.test(currency) && currency !== 'USD';
  const detail = [plan, foreignCurrency ? `账单币种 ${currency}` : null].filter(Boolean).join(' · ');
  return billingEvent({
    id: get('billing item id'),
    at: get('event time'),
    inputTokens: csvNumber(usage['prompt-text-tokens'], { integer: true }),
    outputTokens: csvNumber(usage['completion-text-tokens'], { integer: true }),
    cacheReadTokens: csvNumber(usage['cached-prompt-text-tokens'], { integer: true }),
    cacheWriteTokens: csvNumber(usage['cache-write-text-tokens'], { integer: true }),
    actualUsd: currency === 'USD' ? csvNumber(get('pricing contracted'), { dollar: true }) : null,
    model: /^grok[-_]?bot(?:[-_.:]|$)/i.test(get('model')) ? null : get('model'),
    detail,
  });
}

function cursorBillingEvent(get) {
  const label = get('model');
  if (!/^grok-bot(?:-[a-z0-9][a-z0-9_-]*)?$/i.test(label)) return null;
  const product = get('product').toLowerCase();
  if (product && product !== 'grok-bot') return null;

  const cost = get('cost');
  const billingType = CURSOR_COST_TYPES.get(cost.toLowerCase());
  return billingEvent({
    at: get('date'),
    inputTokens: csvNumber(get('input (w/o cache write)'), { integer: true }),
    outputTokens: csvNumber(get('output tokens'), { integer: true }),
    cacheReadTokens: csvNumber(get('cache read'), { integer: true }),
    cacheWriteTokens: csvNumber(get('input (w/ cache write)'), { integer: true }),
    actualUsd: csvNumber(cost, { dollar: true }),
    detail: [`Cursor 标记：${shortText(label, 160)}`, billingType].filter(Boolean).join(' · '),
  });
}

function parseCsvImport(text) {
  const [header, ...rows] = parseCsvRows(text);
  if (!header) throw new Error(tr("CSV 文件为空。", "The CSV file is empty."));
  const columns = new Map();
  for (const [index, value] of header.entries()) {
    const name = value.trim().toLowerCase();
    if (name && columns.has(name)) throw new Error(tr("CSV 存在重复列名。请使用原始导出文件。", "The CSV has duplicate column names. Use the original export."));
    if (name) columns.set(name, index);
  }

  const isGrokExport = columns.has('event time') && columns.has('product');
  const isCursorExport = columns.has('date') && columns.has('model') &&
    ['cost', 'output tokens', 'cache read', 'input (w/o cache write)', 'input (w/ cache write)'].some((column) => columns.has(column));
  if (!isGrokExport && !isCursorExport) {
    throw new Error(tr("未识别 CSV 表头。请选择 Grok.com 用量导出，或带 Grok Bot 标记的 Cursor 用量导出。", "CSV headers were not recognized. Use a Grok.com usage export or a Cursor usage export with Grok Bot entries."));
  }

  const makeEvent = isGrokExport ? grokBillingEvent : cursorBillingEvent;
  const costLabel = isGrokExport ? 'Grok.com · Pricing Contracted（USD）' : 'Cursor CSV · Cost（USD）';
  const billingIds = new Set();
  const result = collectEvents(rows, (row) => {
    if (row.length !== header.length) return null;
    const event = makeEvent((column) => row[columns.get(column)]?.trim() ?? '');
    if (!isGrokExport || !event?.id) return event;
    if (billingIds.has(event.id)) return null;
    billingIds.add(event.id);
    return event;
  }, costLabel);
  if (!result.events.length) {
    throw new Error(tr("未找到可导入的 Grok Bot 行。请确认文件包含 Grok Bot 产品标识及带时区的时间。", "No supported Grok Bot rows were found. Check for Grok Bot product labels and timestamps with a time zone."));
  }
  return result;
}

export function parseImport(text, filename = '', {trackDisplayDefaults = false} = {}) {
  if (typeof text !== 'string') throw new Error(tr("导入内容应为文本文件。", "Choose an import file in text format."));
  if (text.length > MAX_IMPORT_LENGTH) throw new Error(tr("导入文件过大，最多支持 12 MiB 的文本。", "The import file is too large. The limit is 12 MiB of text."));
  const content = text.replace(/^\uFEFF/, '').trim();
  if (!content) throw new Error(tr("导入文件为空。", "The import file is empty."));

  if (/\.json$/i.test(filename) || (!filename && /^[\[{]/.test(content))) return parseJsonImport(content, trackDisplayDefaults);
  if (/\.csv$/i.test(filename) || !filename) return parseCsvImport(content);
  throw new Error(tr("请选择 .csv 或 .json 文件。", "Choose a .csv or .json file."));
}

const englishBillingNotes = {
  '订阅内用量': 'Included use',
  '免费用量': 'Free use',
  '按量计费': 'On-demand usage',
};
const englishImports = new WeakMap();

function localizeBillingEvent(event) {
  const detail = event.detail?.split(' · ').map(note => {
    if (Object.hasOwn(englishBillingNotes, note)) return englishBillingNotes[note];
    return note.replace(/^账单币种 ([A-Z]{3})$/, 'Billing currency $1').replace(/^Cursor 标记：/, 'Cursor label: ');
  }).join(' · ');
  return {...event, title: 'Grok Bot usage', detail: detail ?? null};
}

function localizeWorkflowEvent(event) {
  if (!event.displayDefaults) return event;
  return {
    ...event,
    title: event.displayDefaults.title ? 'Untitled event' : event.title,
    source: event.displayDefaults.source ? 'Unspecified source' : event.source,
  };
}

export function localizeImportedEvents(dataset) {
  const events = dataset?.events ?? [];
  if (!dataset || currentLanguage() !== 'en') return events;
  const localize = dataset.kind === 'billing' ? localizeBillingEvent :
    dataset.kind === 'otlp' ? localizeOtlpEvent : localizeWorkflowEvent;
  if (!englishImports.has(dataset)) englishImports.set(dataset, events.map(localize));
  return englishImports.get(dataset);
}
