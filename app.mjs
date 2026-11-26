import {parseImport, localizeImportedEvents} from './data.mjs';
import {parseOtlp} from './otlp.mjs';
import {createLiveUpdates, createRunContinuity, orderBotCards, refreshChanges, refreshRunMessage, showsRunMotion} from './live-updates.mjs';
import {createEventStore, mergeEventLog, formatHandoff} from './event-store.mjs';
import {createRoutingControls} from './routing-controls.mjs';
import {routingEventDetail} from './routing.mjs';
import {currentLanguage, localizeDocument, setLanguage, tr} from './i18n.mjs';
import {summarizeWeeklyQuota} from './weekly-quota.mjs';

const byId = (id) => document.getElementById(id);
const languageKey = 'grok-radar-language';
function browserLanguage() {
  try {
    const savedLanguage = localStorage.getItem(languageKey);
    if (savedLanguage === 'en' || savedLanguage === 'zh-CN') return savedLanguage;
  } catch {}
  return /^zh\b/i.test(navigator.language) ? 'zh-CN' : 'en';
}
setLanguage(window.grokWorkbenchLanguage ?? browserLanguage());

const money = new Intl.NumberFormat('en-US', {style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 10});
const amount = (value) => value == null ? '—' : money.format(value);
let formatters;
function setFormatters() {
  const locale = tr('zh-CN', 'en-US');
  const hoursAndMinutes = {hour: '2-digit', minute: '2-digit', hourCycle: 'h23'};
  formatters = {
    number: new Intl.NumberFormat(locale),
    percent: new Intl.NumberFormat(locale, {maximumFractionDigits: 1}),
    time: new Intl.DateTimeFormat(locale, hoursAndMinutes),
    checkedTime: new Intl.DateTimeFormat(locale, {...hoursAndMinutes, second: '2-digit'}),
    dayTime: new Intl.DateTimeFormat(locale, {month: '2-digit', day: '2-digit', ...hoursAndMinutes}),
    weekdayTime: new Intl.DateTimeFormat(locale, {weekday: 'short', ...hoursAndMinutes}),
    fullTime: new Intl.DateTimeFormat(locale, {dateStyle: 'long', timeStyle: 'medium'}),
  };
}
setFormatters();
const count = (value) => value == null ? '—' : formatters.number.format(value);
const statusLabels = {
  ignored: ['已忽略', 'Ignored'], done: ['已完成', 'Completed'], draft: ['待交接', 'Pending handoff'],
  dispatching: ['正在打开', 'Opening'], 'handed-off': ['待镜像确认', 'Awaiting confirmation'],
  confirmed: ['已确认', 'Confirmed'], observed: ['已同步', 'Synced'], rejected: ['已驳回', 'Rejected'],
  failed: ['失败', 'Failed'], running: ['运行中', 'Running'], 'waiting-reply': ['等待回复', 'Awaiting reply'],
  'waiting-followup': ['等待后续', 'Awaiting follow-up'], 'waiting-input': ['等你处理', 'Needs your input'],
  'completion-unconfirmed': ['结束待确认', 'Completion unconfirmed'], unknown: ['未记录', 'Unrecorded'],
};
const sourceStyles = {
  webhook: ['Webhook', 'hook', '#f6a7c8', '#352238'],
  deploy: ['部署', 'deploy', '#f1bd8a', '#342a24'],
  github: ['GitHub', 'code', '#bcb6ff', '#2b2945'],
  email: ['邮件', 'mail', '#a2c9ff', '#223450'],
  billing: ['账单', 'bars'],
  inference: ['模型请求', 'bars'],
  action: ['工具动作', 'fix'],
  'local-turn': ['Grok Bot', 'list'],
  workbench: ['工作台', 'logo'],
  imported: ['导入记录', 'upload'],
};
const sourceLabels = {
  deploy: ['发布通知', 'Releases'], email: ['邮件', 'Email'], billing: ['账单', 'Billing'],
  inference: ['模型请求', 'Model requests'], action: ['工具动作', 'Tool activity'],
  workbench: ['工作台', 'Workbench'], imported: ['导入记录', 'Imports'],
};
const agentStyles = {
  TRIAGE: ['TRIAGE', 'searchfile', '#86efdb', '#193c3a'],
  FIXER: ['FIXER', 'fix', '#f1bd8a', '#342a24'],
  REVIEWER: ['REVIEWER', 'review', '#bcb6ff', '#2b2945'],
  WRITER: ['WRITER', 'pen', '#a2c9ff', '#223450'],
};
const defaultRoleNames = {
  TRIAGE: '运营助手',
  FIXER: '软件架构师',
  REVIEWER: '测试',
  WRITER: '润色师',
};
const escape = (value) => String(value ?? '—').replace(/[&<>"']/g, (char) => (
  {'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[char]
));
const icon = (name) => `<svg aria-hidden="true"><use href="#i-${name}"></use></svg>`;
const pageSize = 12;
const relay = (variant = '') => `<span class="relay-orb ${variant}" aria-hidden="true"><span class="relay-orb__ticks"></span><span class="relay-orb__case"><span class="relay-orb__seam"></span><span class="relay-orb__panel"><i></i><i></i><b></b></span></span></span>`;
const native = window.grokWorkbenchNative === true;
const liveUpdates = createLiveUpdates();
const runContinuity = createRunContinuity();
let local = {status: 'waiting', events: [], bots: []};
let activity = runContinuity.update(local);
let recentByBot = new Map();
let flowMarkup = '';
let operations = createEventStore();
let account = null;
let ledgerEpoch = 0;
let ledgerReady = false;
let ledgerQueue = Promise.resolve();
let saved = null;
let displayEvents = [];
let focusId = null;
let lastObservedId = null;
let pulseIds = new Set();
let replyPulseIds = new Set();
let newBotPulses = new Set();
let pulseVersion = 0;
let pulseTimer;
let syncFeedbackTimer;
let page = 0;
let days = 0;
let flowFilter = null;
let chartData = [];
let tempoData = null;
const dialogOpeners = new WeakMap();
let detailId = null;
let waitingNoticeId = null;

const displaySource = (key) => Object.hasOwn(sourceLabels, key) ? tr(...sourceLabels[key]) :
  (Object.hasOwn(sourceStyles, key) ? sourceStyles[key][0] : key) ?? '—';
const displayStatus = (key) => tr(...(Object.hasOwn(statusLabels, key) ? statusLabels[key] : statusLabels.unknown));
const latency = (value) => value == null ? '—' : value < 1000 ? `${count(value)} ms` : `${(value / 1000).toFixed(2)} s`;
const tokenFields = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'];
const sum = (items, getValue) => {
  let total = null;
  for (const item of items) {
    const value = getValue(item);
    if (value != null) total = (total ?? 0) + value;
  }
  return total;
};
const tokens = (row) => sum(tokenFields, (field) => row[field]);
const optionalDate = (value, formatter = formatters.dayTime) => Number.isFinite(Date.parse(value)) ? formatter.format(new Date(value)) : '—';
function displayEventTitle(row) {
  if (row.origin !== 'grok') return row.title;
  if (row.title === '用户发起的回合') return tr(row.title, 'User-initiated turn');
  if (row.title === 'Bot 间对话回合') return tr(row.title, 'Bot-to-bot turn');
  if (row.title === 'Grok Bot 对话回合') return tr(row.title, 'Grok Bot turn');
  return row.title;
}
const boundBotFor = (role) => (local.bots ?? []).find((bot) => bot.key === operations.getBindings()[role]);
const suggestedBot = (row) => row.origin === 'workbench' && row.status === 'draft' ? boundBotFor(row.agent) : undefined;
const assignedName = (row) => row.targetName ?? suggestedBot(row)?.name ?? row.agent;
const botKey = (row) => row.targetKey ?? row.agentKey ?? suggestedBot(row)?.key ?? (row.agent ? 'role:' + row.agent : null);
const sourceKey = (row) => row.origin === 'import' ? 'imported' : row.source;
function rowActivity(row) {
  if (row.origin === 'grok') return activity.byRun.get(row.id);
  if (row.origin !== 'workbench') return undefined;
  const linked = activity.byRun.get(row.observedId);
  return linked?.handoffId === row.id && linked.agentKey === row.targetKey ? linked : undefined;
}
const rowStatus = (row) => rowActivity(row)?.status ?? (row.origin === 'grok' ? 'observed' : row.status ?? 'unknown');
const rowMatches = (row, id) => !!id && (row.id === id || row.liveObservedId === id);
const isAwaiting = (row) => row.status === 'dispatching' || row.status === 'handed-off';
const pendingEvents = () => operations.events().filter((row) => row.status === 'draft');
const readyToRoute = () => native && ledgerReady && local.status === 'connected' && !!account;

function firstRoleBindings() {
  const result = {};
  for (const [role, name] of Object.entries(defaultRoleNames)) {
    const matches = (local.bots ?? []).filter((bot) => bot.name === name);
    if (matches.length === 1) result[role] = matches[0].key;
  }
  return result;
}

function withinPeriod() {
  if (!days) return displayEvents;
  const now = Date.now();
  const start = now - days * 86_400_000;
  return displayEvents.filter((item) => {
    const value = Date.parse(item.at);
    return value >= start && value <= now;
  });
}

function report(message = '', type = '', eventId = null) {
  waitingNoticeId = eventId;
  const notice = byId('workbench-notice');
  notice.textContent = message;
  notice.dataset.type = type;
  notice.hidden = !message;
}

function bridge(name, message) {
  const handler = window.webkit?.messageHandlers?.[name];
  if (!handler) throw new Error(tr('请在 Mac 工作台连接 Grok Bot 后再试。', "Connect to Grok Bot in the Mac app, then try again."));
  return handler.postMessage(message);
}

async function refreshSync(event) {
  const button = event.currentTarget;
  if (button.disabled) return;
  const label = button.querySelector('span');
  const feedback = byId('sync-feedback');
  const runResult = byId('sync-run-result');
  const dataResult = byId('sync-data-result');
  const before = local;
  clearTimeout(syncFeedbackTimer);
  feedback.hidden = true;
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  label.textContent = tr('刷新中', "Refreshing…");
  try {
    const result = await bridge('workbenchRefresh', {});
    if (!result?.ok) throw new Error(result?.error || tr('刷新失败，请再试一次。', "Refresh failed. Try again."));
    if (result.status !== 'connected' || local.status !== 'connected') {
      throw new Error(tr('暂时读不到 Grok Bot 的本机数据。打开 Grok Bot 确认账号后，可以再刷新。', "Local Grok Bot data is unavailable. Open Grok Bot, check the active account, and refresh."));
    }
    const change = refreshChanges(before, local);
    const events = change.events ? tr('事件已更新', "Events updated") : tr('事件暂无更新', "No new events");
    const quota = change.quota === 'updated' ? tr('额度已更新', "Quota updated") : change.quota === 'unavailable' ? tr('额度暂未同步', "Quota unavailable") :
      tr(`额度仍是 ${optionalDate(local.weeklyQuota.updatedAt)} 的数据`, `Quota as of ${optionalDate(local.weeklyQuota.updatedAt)}`);
    runResult.textContent = refreshRunMessage(local);
    dataResult.textContent = tr(`已检查 ${optionalDate(local.checkedAt, formatters.checkedTime)} · ${events}，${quota}`, `Checked ${optionalDate(local.checkedAt, formatters.checkedTime)} · ${events} · ${quota}`);
    const needsPermission = local.desktopActivity?.access === 'permission';
    feedback.dataset.type = needsPermission ? 'permission' : '';
    if (!needsPermission) syncFeedbackTimer = setTimeout(() => { feedback.hidden = true; }, 5000);
  } catch (failure) {
    runResult.textContent = failure.message;
    dataResult.textContent = '';
    feedback.dataset.type = 'error';
  } finally {
    feedback.hidden = false;
    button.disabled = false;
    button.removeAttribute('aria-busy');
    label.textContent = tr('刷新', "Refresh");
  }
}

async function openOfficialUsage(event) {
  const button = event.currentTarget;
  const feedback = byId('official-usage-error');
  if (button.disabled) return;
  feedback.hidden = true;
  button.disabled = true;
  try {
    const result = await bridge('workbenchOpenUsage', {});
    if (!result?.ok) throw new Error(result?.error || tr('请在 Grok Bot 的「设置 → 用量与账单」中查看。', "Open Settings → Usage & Billing in Grok Bot."));
  } catch (failure) {
    feedback.textContent = failure.message;
    feedback.hidden = false;
  } finally {
    button.disabled = false;
  }
}

async function connectRunStatus(event) {
  const button = event.currentTarget;
  const note = byId('run-access-note');
  button.disabled = true;
  try {
    const result = await bridge('workbenchRunAccess', {});
    note.textContent = result?.enabled ? tr('正在读取 Grok Bot 侧栏的运行状态。', "Reading live status from the Grok Bot sidebar.") :
      tr('请在「系统设置 → 隐私与安全性 → 辅助功能（设备控制和数据访问）」里允许 Grok Radar。', "Allow Grok Radar under System Settings → Privacy & Security → Accessibility (or Device Control and Data Access).");
  } catch {
    note.textContent = tr('暂时无法连接运行状态，请再试一次。', "Live status is unavailable. Try again.");
  } finally {
    note.hidden = local.desktopActivity?.access === 'ready';
    button.disabled = false;
  }
}

function editLedger(update) {
  if (!readyToRoute()) return Promise.reject(new Error(tr('请等待 Grok Bot 连接和事件账本加载。', "Wait for Grok Bot to connect and the event ledger to load.")));
  const key = account;
  const revision = ledgerEpoch;
  const stillCurrent = () => account === key && ledgerEpoch === revision && readyToRoute();
  const run = ledgerQueue.then(async () => {
    if (!stillCurrent()) throw new Error(tr('Grok Bot 连接已变化，请重新打开事件。', "The Grok Bot connection changed. Reopen the event."));
    const candidate = createEventStore(operations.serialize(), {resumeInterrupted: false});
    const changed = update(candidate);
    if (changed === false) return false;
    const savedState = await bridge('workbenchLedger', {op: 'save', accountKey: key, data: candidate.serialize()});
    if (!savedState?.ok) throw new Error(savedState?.error || tr('本机事件账本保存失败。', "Could not save the local event ledger."));
    if (!stillCurrent()) throw new Error(tr('Grok Bot 连接已变化，请重新打开事件。', "The Grok Bot connection changed. Reopen the event."));
    operations = candidate;
    render();
    return changed;
  });
  ledgerQueue = run.catch(() => {});
  return run;
}

function reconcileMirror(events = local.events) {
  if (!readyToRoute() || !operations.events().some((row) => row.targetKey)) return;
  const revision = ledgerEpoch;
  void editLedger((store) => store.reconcile(events))
    .then(() => {
      const confirmed = operations.events().find((row) => row.id === waitingNoticeId && row.status === 'confirmed');
      if (ledgerEpoch === revision && confirmed) report(tr(`已从镜像确认 ${confirmed.targetName} 的事件。`, `The local cache confirmed the handoff to ${confirmed.targetName}.`));
    })
    .catch((failure) => { if (ledgerEpoch === revision) report(failure.message, 'error'); });
}

const pulsesFor = (row, pulses) => pulses.has(row.id) || pulses.has(row.liveObservedId);

function clearPulses() {
  pulseIds.clear();
  replyPulseIds.clear();
  newBotPulses.clear();
}

function highlight(ids, {replies = [], bots = []} = {}) {
  if (ids.length) focusId = ids[0];
  pulseIds = new Set(ids);
  replyPulseIds = new Set(replies);
  newBotPulses = new Set(bots);
  pulseVersion++;
  clearTimeout(pulseTimer);
  pulseTimer = setTimeout(() => {
    clearPulses();
    if (local.events.some((row) => row.id === focusId)) focusId = lastObservedId;
    const items = withinPeriod();
    renderFlow(items);
    renderRows(items);
  }, 5000);
}

async function dispatchEvent(id, targetKey) {
  const selectedBot = local.bots?.find((item) => item.key === targetKey);
  if (!selectedBot) throw new Error(tr('所选 Bot 已不在当前名册，请重新选择。', "This bot is no longer in the roster. Choose another bot."));
  const key = account;
  const revision = ledgerEpoch;
  const event = await editLedger((store) => store.reserve(id, {targetKey, targetName: selectedBot.name}));
  if (account !== key || ledgerEpoch !== revision || !readyToRoute()) return;
  let receipt;
  try {
    receipt = await bridge('workbenchHandoff', {accountKey: key, targetKey, eventId: id, text: formatHandoff(event)});
  } catch {
    receipt = {ok: false, uncertain: true};
  }
  if (account !== key || ledgerEpoch !== revision || !readyToRoute()) return;
  await editLedger((store) => receipt?.uncertain || typeof receipt?.ok !== 'boolean'
    ? store.markUncertain(id)
    : store.complete(id, receipt));
  reconcileMirror();
  if (receipt?.ok) {
    const confirmed = operations.events().some((row) => row.id === id && row.status === 'confirmed');
    report(confirmed ? tr(`已从镜像确认 ${selectedBot.name} 的事件。`, `The local cache confirmed the handoff to ${selectedBot.name}.`) : tr(`已打开 ${selectedBot.name}，等待 Grok Bot 镜像确认。`, `Opened ${selectedBot.name}. Waiting for the local cache to confirm.`), '', confirmed ? null : id);
  } else if (receipt?.uncertain || typeof receipt?.ok !== 'boolean') {
    report(tr('本次交接结果待镜像确认。', "Waiting for the local cache to confirm this handoff."), 'error', id);
  } else {
    throw new Error(receipt?.error || tr('Grok Bot 打开失败。', "Could not open Grok Bot."));
  }
}

const routingControls = createRoutingControls({
  async addEvent(kind, input) {
    const event = await editLedger((store) => store.add(kind, input));
    highlight([event.id]);
    flowFilter = null;
    days = 0;
    page = 0;
    byId('search').value = '';
    byId('status').value = '';
    report(event.route === 'ignored' ? tr('事件已记录，规则判断无需交接。', "Event logged. No handoff is needed.") : tr('事件已记录，可在待交接队列选择 Bot。', "Event logged. Choose a bot in Pending handoffs."));
    render();
  },
  getPending: pendingEvents,
  getBots: () => readyToRoute() ? (local.bots ?? []) : [],
  getBindings: () => operations.getBindings(),
  saveBindings: (bindings) => editLedger((store) => {
    const validTargets = new Set((local.bots ?? []).map((bot) => bot.key));
    if (Object.values(bindings).some((key) => key && !validTargets.has(key))) {
      throw new Error(tr('所选 Bot 已不在当前名册，请重新选择。', "This bot is no longer in the roster. Choose another bot."));
    }
    return store.setBindings(bindings);
  }),
  dispatchEvent,
  rejectEvent: (id) => editLedger((store) => store.reject(id)),
});


function tickBars(rows, segments = 10) {
  if (!rows.length) return '';
  const times = rows.map((row) => Date.parse(row.at)).filter(Number.isFinite);
  if (!times.length) return '';
  const start = times.reduce((left, right) => Math.min(left, right));
  const end = times.reduce((left, right) => Math.max(left, right));
  const counts = Array(segments).fill(0);
  for (const at of times) {
    const index = start === end ? segments - 1 : Math.min(segments - 1, Math.floor((at - start) / (end - start) * segments));
    counts[index]++;
  }
  const peak = Math.max(...counts);
  return counts.map((hits) => `<i style="--height:${hits ? (18 + hits / peak * 82).toFixed(0) : '10'}%"${hits ? '' : ' class="quiet"'}></i>`).join('');
}

function quotaDuration(milliseconds) {
  const minutes = Math.ceil(milliseconds / 60_000);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor(minutes / 60) % 24;
  const remainder = minutes % 60;
  const parts = [
    days && tr(`${count(days)} 天`, `${count(days)}d`),
    hours && tr(`${count(hours)} 小时`, `${count(hours)}h`),
    !days && remainder && tr(`${count(remainder)} 分钟`, `${count(remainder)}m`),
  ];
  return parts.filter(Boolean).join(' ');
}

function quotaForecast(quota) {
  switch (quota.forecast) {
    case 'depleted': return tr('本周额度已用完', 'Weekly quota used up');
    case 'until-reset': return tr('预计够用到重置', 'On track until reset');
    case 'outdated': return tr('等额度更新后再估算', 'Waiting for newer quota data');
    case 'estimate': {
      const left = quotaDuration(quota.estimatedMs);
      return tr(`约 ${left}后用完`, `About ${left} left at this pace`);
    }
    default: return '—';
  }
}

function renderQuota() {
  const card = byId('weekly-quota');
  card.hidden = !native;
  if (!native) return;
  const checkedAt = Date.parse(local.checkedAt);
  const quota = local.status === 'connected' ?
    summarizeWeeklyQuota(local.weeklyQuota, Number.isFinite(checkedAt) ? checkedAt : Date.now()) : null;
  const timing = byId('weekly-quota-time');
  byId('weekly-quota-body').hidden = timing.hidden = !quota;
  byId('weekly-quota-empty').hidden = !!quota;
  if (!quota) return;

  const meter = byId('weekly-quota-meter');
  meter.setAttribute('aria-valuenow', String(quota.remainingPercent));
  meter.style.setProperty('--quota-fill', `${quota.remainingPercent * 2.7}deg`);
  meter.dataset.low = String(quota.remainingPercent < 15);
  const remaining = formatters.percent.format(quota.remainingPercent);
  byId('weekly-quota-value').textContent = remaining;
  const countdown = byId('weekly-quota-countdown');
  countdown.hidden = quota.untilResetMs === null;
  const balance = tr(`剩余 ${remaining}%`, `${remaining}% remaining`);
  if (!countdown.hidden) {
    const left = quotaDuration(quota.untilResetMs);
    countdown.textContent = tr(`${left}后重置`, `Reset in ${left}`);
  }
  meter.setAttribute('aria-valuetext', countdown.hidden ? balance : `${balance}${tr('，', ', ')}${countdown.textContent}`);

  const marker = byId('weekly-quota-marker');
  marker.hidden = quota.expectedRemainingPercent === null;
  if (!marker.hidden) {
    marker.style.setProperty('--quota-marker-angle', `${225 + quota.expectedRemainingPercent * 2.7}deg`);
    const expected = formatters.percent.format(quota.expectedRemainingPercent);
    marker.title = tr(`按均匀预算，此时应剩 ${expected}%`, `Even budget at the last update: ${expected}% remaining`);
  }
  const pace = quota.pacePercent;
  const badge = byId('weekly-quota-pace-badge');
  badge.hidden = pace === null;
  badge.dataset.tone = pace > 100 ? 'warning' : '';
  badge.textContent = pace > 100 ? tr('偏快', 'Fast') : pace === 100 ? tr('持平', 'On pace') : tr('偏慢', 'Slow');
  byId('weekly-quota-pace').textContent = pace === null ? '—' : pace > 999 ? '>999%' : `${count(pace)}%`;

  const reset = byId('weekly-quota-reset');
  reset.textContent = quota.resetAt === null ? '—' : formatters.weekdayTime.format(quota.resetAt);
  reset.title = quota.resetAt === null ? '' : formatters.fullTime.format(quota.resetAt);
  reset.dataset.tone = quota.resetAt === null ? 'muted' : '';
  const forecast = byId('weekly-quota-forecast');
  forecast.textContent = quotaForecast(quota);
  forecast.dataset.tone = ['estimate', 'depleted'].includes(quota.forecast) ? 'warning' : 'muted';
  const updated = formatters.dayTime.format(quota.updatedAt);
  timing.textContent = tr(`更新于 ${updated}`, `Updated ${updated}`);
}

function renderMetrics(items) {
  const ignored = items.filter((row) => row.status === 'ignored');
  const waiting = items.filter((row) => {
    const run = rowActivity(row);
    return row.status === 'draft' || isAwaiting(row) || (run && run.status !== 'completion-unconfirmed');
  });
  const confirmed = items.filter((row) => row.origin === 'grok' || row.status === 'confirmed');
  const cards = [
    [tr('事件', "Events"), items, 'plain'], [tr('已忽略', "Ignored"), ignored, 'quiet'],
    [tr('Grok 已观测', "Observed by Grok"), confirmed, 'green'], [tr('待处理', "Pending"), waiting, 'red'],
  ];
  byId('metrics').innerHTML = cards.map(([label, rows, tone]) => `
    <div class="metric tone-${tone}"><span class="metric-label">${label}</span>
      <strong class="metric-value">${count(rows.length)}</strong>
      <span class="metric-bars" aria-hidden="true">${tickBars(rows)}</span></div>`).join('');
  byId('board-timeline').innerHTML = tickBars(items, 24);
}

function currentEvent(items) {
  return items.find((row) => rowMatches(row, focusId)) ??
    items.reduce((latest, row) => !latest || (row.lastReplyAt ?? row.at) > (latest.lastReplyAt ?? latest.at) ? row : latest, null);
}

const specialistNotes = {
  TRIAGE: ['部署分诊', 'Release triage'], FIXER: ['修复分析', 'Fix investigation'],
  REVIEWER: ['变更审查', 'Change review'], WRITER: ['撰写草稿', 'Drafting'], TEST: ['连通性测试', 'Connectivity test'],
};
const sourceNotes = {
  webhook: ['回调与探测', 'Callbacks and probes'], deploy: ['发布事件', 'Release events'],
  github: ['PR 事件', 'Pull request events'], email: ['邮件事件', 'Email events'],
  'local-turn': ['本机镜像同步', 'Local cache sync'], workbench: ['连通性测试', 'Connectivity tests'],
  imported: ['按源文件显示', 'From imported files'],
};

function updateFlowSelection(root) {
  for (const button of root.querySelectorAll('[data-flow-field], [data-ignore]')) {
    const {flowField, flowKey} = button.dataset;
    const selected = flowField ? flowFilter?.field === flowField && flowFilter?.key === flowKey : flowFilter?.field === 'status';
    if (button.getAttribute('aria-pressed') !== String(selected)) button.setAttribute('aria-pressed', String(selected));
  }
}

function renderFlow(items) {
  const root = byId('flow');
  const rate = byId('flow-rate');
  const recent = currentEvent(items);
  const recentBot = recent ? botKey(recent) : null;
  const recentSource = recent ? sourceKey(recent) : null;
  const arriving = recent && pulsesFor(recent, pulseIds);
  const replying = recent && pulsesFor(recent, replyPulseIds);
  const previousAgentStack = root.querySelector('.agent-stack');
  const priorLiveLeader = previousAgentStack?.querySelector('[data-activity]')?.dataset.flowKey;
  const priorAgentScroll = previousAgentStack?.scrollTop;
  const priorAgent = previousAgentStack?.querySelector('.is-current')?.dataset.flowKey;
  const previousSourceStack = root.querySelector('.source-stack');
  const priorLiveSource = !!previousSourceStack?.querySelector('[data-activity]');
  const priorSourceScroll = previousSourceStack?.scrollTop;
  const priorSource = previousSourceStack?.querySelector('.is-current')?.dataset.flowKey;
  const active = root.contains(document.activeElement) ? document.activeElement : null;
  const activeKey = active?.dataset.flowKey;
  const activeField = active?.dataset.flowField;

  byId('flow-title').textContent = tr('事件流转', "Event flow");
  const access = local.desktopActivity?.access;
  byId('flow-subtitle').textContent = access === 'permission' ? tr('授权读取 Grok Bot 的实时状态后，流光会随任务开始和停止。', "Allow live Grok Bot status to see when tasks start and stop.") :
    access === 'unavailable' ? tr('暂时读不到 Grok Bot 的实时状态，连接恢复后会自动更新。', "Live Grok Bot status is unavailable. It will update when the connection returns.") : tr('事件进入工作台，专项任务确认后交给已连接的 Grok Bot。', "Events enter the dashboard. Confirm a handoff to pass work to a connected bot.");
  rate.classList.add('latest-recipient');

  const sourceCounts = new Map();
  const agentCounts = new Map();
  const agentNames = new Map((local.bots ?? []).map((bot) => [bot.key, bot.name]));
  const pulsingAgents = new Set(newBotPulses);
  const pulsingSources = new Set(newBotPulses.size ? ['local-turn'] : []);
  for (const row of items) {
    const source = sourceKey(row);
    const bot = botKey(row);
    sourceCounts.set(source, (sourceCounts.get(source) ?? 0) + 1);
    if (bot) {
      agentCounts.set(bot, (agentCounts.get(bot) ?? 0) + 1);
      if (!agentNames.has(bot)) agentNames.set(bot, assignedName(row));
    }
    if (pulsesFor(row, pulseIds)) {
      pulsingSources.add(source);
      if (bot) pulsingAgents.add(bot);
    }
  }
  const candidates = ['local-turn', 'webhook', 'deploy', 'github', 'email', 'workbench', 'imported'];
  const sourceNodes = candidates.filter((key) => (key !== 'imported' && key !== 'workbench') || sourceCounts.has(key)).map((key) => ({
    key, title: displaySource(key), mark: sourceStyles[key][1], note: tr(...sourceNotes[key]), total: sourceCounts.get(key) ?? 0,
  }));
  const roster = [...agentNames].filter(([key]) => !key.startsWith('role:'))
    .sort((left, right) => String(left[1]).localeCompare(String(right[1]), 'zh-CN'));
  const specialists = Object.keys(specialistNotes).filter((key) => key !== 'TEST' || agentCounts.has('role:TEST'))
    .map((key) => ['role:' + key, key]);
  const rosterCards = [...roster, ...specialists].map(([key, title], index) => ({
    key, title, mark: Object.hasOwn(agentStyles, title) ? agentStyles[title][1] : 'logo',
    total: agentCounts.get(key) ?? 0,
    tone: index % 4,
    note: key.startsWith('role:') ? tr(...specialistNotes[title]) + (boundBotFor(title) ? ' · ' + boundBotFor(title).name : tr(' · 待指定', ' · Unassigned')) : tr('本机 Bot', 'Local bot'),
  }));
  const agents = orderBotCards(rosterCards, activity.byBot, recentByBot);
  const liveLeader = agents.find(({key}) => activity.byBot.has(key));
  const newBot = agents.find(({key}) => newBotPulses.has(key));
  const focusBot = arriving ? recentBot : newBot?.key ?? recentBot;
  const focusSource = arriving ? recentSource : newBot ? 'local-turn' : recentSource;
  const inViewActivity = !!liveLeader || !!newBot || !!arriving;
  const liveStatus = activity.byBot.get(liveLeader?.key)?.status;
  const moving = showsRunMotion(liveStatus);
  const liveCount = [...activity.byBot.values()].filter(({status}) => status === liveStatus).length;
  const liveRecipient = liveCount > 1 ? tr(`${count(liveCount)} 个 Bot`, `${count(liveCount)} bots`) : liveLeader?.title;
  const activityText = liveStatus ? displayStatus(liveStatus) : '';
  rate.classList.toggle('is-arrival', !liveLeader && (!!arriving || !!newBot));
  rate.dataset.activity = liveStatus ?? '';
  rate.hidden = !liveLeader && !newBot && !recent;
  rate.textContent = liveLeader ? `${activityText} · ${liveRecipient}` :
    !arriving && newBot ? tr(`新加入 · ${newBot.title}`, `New bot · ${newBot.title}`) :
    recent ? `${replying ? tr('有新回复', "New reply") : arriving ? tr('刚更新', "Just updated") : tr('最近', "Latest")} · ${assignedName(recent) ?? displaySource(recentSource)}` : '';
  rate.title = rate.textContent;

  const tasks = agents.flatMap(({key, title}) => {
    const run = activity.byBot.get(key);
    if (!run) return [];
    const event = displayEvents.find((row) => rowMatches(row, run.eventId));
    if (!event) return [];
    const sender = agentNames.get(run.sourceAgentKey);
    const label = sender ? tr(`${sender} 交给 ${title}`, `${sender} → ${title}`) : title;
    const hint = run.status === 'completion-unconfirmed' ? tr('尚未确认任务是否结束。点击查看事件。', "Completion is unconfirmed. Open the event for details.") : tr('查看这条事件', "Open event");
    return `<button type="button" class="flow-task" data-live-event="${escape(event.id)}" title="${hint}">
      <span class="flow-task-text"><strong>${escape(label)}</strong>${run.task ? `<small>${escape(run.task)}</small>` : ''}</span>
      <span class="flow-task-state">${displayStatus(run.status)} ${icon('chevron')}</span></button>`;
  }).join('');

  const makeNodes = (nodes, field, side, current, pulsing) => nodes.map((item, index) => {
    const state = side === 'agent' ? activity.byBot.get(item.key)?.status : (item.key === 'local-turn' ? liveStatus : null);
    const arrived = pulsing.has(item.key);
    const note = side === 'agent' && newBotPulses.has(item.key) ? tr('新加入', "New") : item.note;
    return `<button class="flow-node ${side === 'agent' ? 'exchange-node' : 'event-node'}${current === item.key ? ' is-current' : ''}${arrived ? ' is-arrival' : ''}"
      type="button" data-flow-field="${field}" data-flow-key="${escape(item.key)}" data-side="${side}" data-node="${index}"
      ${state ? `data-activity="${state}"` : ''}${arrived ? ` data-pulse="${pulseVersion}"` : ''} data-tone="${item.tone ?? index % 4}" aria-pressed="false" title="${escape(item.title)}">
      <span class="node-icon">${icon(item.mark)}</span><span class="node-copy"><strong class="node-name">${escape(item.title)}</strong>
      ${state && side === 'agent' ? `<small class="node-activity"><i aria-hidden="true"></i>${displayStatus(state)}</small>` : `<small>${escape(note)}</small>`}</span>
      <span class="node-count">${count(item.total)}</span></button>`;
  }).join('');

  const pending = pendingEvents().length;
  const waiting = operations.events().filter(isAwaiting).length;
  const confirmed = operations.events().filter((row) => row.status === 'confirmed').length;
  const ignored = items.filter((row) => row.status === 'ignored').length;
  const relayNote = liveLeader ? liveRecipient : !arriving && newBot ? tr('Grok Bot 名册', 'Grok Bot roster') : recent?.sourceAgentKey && agentNames.has(recent.sourceAgentKey)
    ? tr(`来源 · ${agentNames.get(recent.sourceAgentKey)}`, `From ${agentNames.get(recent.sourceAgentKey)}`)
    : recent?.origin === 'grok' ? tr('Grok Bot 本机事件', "Local Grok Bot events") : (recent ? displayStatus(rowStatus(recent)) : tr('等待数据', "Waiting for data"));
  const markup = `<div class="flow-plot">
    <svg class="flow-edges" aria-hidden="true"></svg>
    <div class="flow-column sources"><h3>${tr('事件来源', 'Event sources')}</h3><div class="node-stack source-stack">${makeNodes(sourceNodes, 'source', 'source', focusSource, pulsingSources)}</div></div>
    <div class="flow-column relay-column"><h3>${tr('事件路由', 'Routing')}</h3><div class="relay-state" data-activity="${liveStatus ?? ''}">${activityText || (replying ? tr('回复已同步', "Reply synced") : newBot && !arriving ? tr('名册已同步', "Roster synced") : recent?.origin === 'grok' ? tr('同步', "Synced") : recent?.origin === 'workbench' ? tr('工作台', "Workbench") : tr('记录', "Log"))}</div>
      <div class="router">${relay(moving ? 'relay-orb--running' : !liveLeader && inViewActivity ? 'relay-orb--active' : '')}</div>
      <p class="relay-note" title="${escape(relayNote)}">${escape(relayNote)}</p></div>
    <div class="flow-column specialists"><h3>${tr('处理角色与 Bot', 'Roles and bots')}</h3><div class="node-stack agent-stack">${makeNodes(agents, 'recipient', 'agent', focusBot, pulsingAgents)}</div></div>
    </div>${tasks ? `<section class="flow-tasks" aria-label="${tr('当前任务', 'Current tasks')}">${tasks}</section>` : ''}<div class="guard-rack">
      <button class="rack-tile ignored-tile" type="button" data-ignore aria-pressed="false">
        <span class="activity-pips" aria-hidden="true">${Array.from({length: 24}, (_, i) => `<i${i < ignored ? ' class="is-filled"' : ''}></i>`).join('')}</span>
        <span class="rack-title">${tr('已忽略', 'Ignored')} <b>${count(ignored)}</b></span>
      </button>
      <button class="rack-tile guard-tile" id="routing-approval-open" type="button" ${readyToRoute() ? '' : 'disabled'}>
        <span class="rack-icon">${icon('shield')}</span><span><strong>${tr('待交接事件', 'Pending handoffs')}</strong><small>${tr(`${count(pending)} 条可选 Bot`, `${count(pending)} to assign`)}</small></span>${icon('chevron')}
      </button>
      <div class="rack-tile human-tile"><span class="rack-icon">${icon('logo')}</span>
        <span><strong>${tr('真实交接', 'Handoffs')}</strong><small>${tr(`待确认 ${count(waiting)} · 已确认 ${count(confirmed)}`, `${count(waiting)} awaiting · ${count(confirmed)} confirmed`)}</small></span></div>
    </div>`;
  if (markup === flowMarkup) {
    updateFlowSelection(root);
    return;
  }
  flowMarkup = markup;
  // Keep looping motion in phase when progress causes the diagram to be redrawn.
  root.style.setProperty('--flow-clock', `-${performance.now()}ms`);
  root.innerHTML = markup;
  updateFlowSelection(root);

  for (const [side, key, scroll, previousKey, revealLive] of [
    ['source', focusSource, priorSourceScroll, priorSource, liveLeader && !priorLiveSource],
    ['agent', focusBot, priorAgentScroll, priorAgent, liveLeader && liveLeader.key !== priorLiveLeader],
  ]) {
    const stack = root.querySelector('.' + side + '-stack');
    if (scroll != null) stack.scrollTop = scroll;
    const selected = stack.querySelector('.is-current');
    if (revealLive) {
      stack.scrollTop = 0;
    } else if (!liveLeader && selected && (scroll == null || key !== previousKey || arriving || newBot)) {
      const distance = selected.getBoundingClientRect().top - stack.getBoundingClientRect().top;
      stack.scrollTop = Math.max(0, stack.scrollTop + distance - 6);
    }
    stack.addEventListener('scroll', drawFlow, {passive: true});
  }
  drawFlow();

  for (const button of root.querySelectorAll('[data-live-event]')) {
    const id = button.dataset.liveEvent;
    if (id === active?.dataset.liveEvent) button.focus({preventScroll: true});
    button.addEventListener('click', () => {
      const event = displayEvents.find((row) => row.id === id);
      if (event) openDetail(event, button);
    });
  }

  const filters = root.querySelectorAll('[data-flow-field]');
  const ignore = root.querySelector('[data-ignore]');
  for (const filter of filters) {
    const field = filter.dataset.flowField;
    const item = (filter.dataset.side === 'source' ? sourceNodes : agents)[Number(filter.dataset.node)];
    if (activeKey === item.key && activeField === field) filter.focus({preventScroll: true});
    filter.addEventListener('click', () => {
      flowFilter = flowFilter?.field === field && flowFilter?.key === item.key ? null : {field, key: item.key, label: item.title};
      updateFlowSelection(root);
      page = 0;
      renderRows(withinPeriod());
    });
  }
  ignore.addEventListener('click', () => {
    flowFilter = flowFilter?.field === 'status' ? null : {field: 'status', key: 'ignored', label: tr('已忽略', "Ignored")};
    updateFlowSelection(root);
    page = 0;
    renderRows(withinPeriod());
  });
  const approval = byId('routing-approval-open');
  approval.addEventListener('click', (event) => routingControls.openApproval(event.currentTarget));
  if (active?.matches('[data-ignore]')) ignore.focus({preventScroll: true});
  if (active?.id === approval.id) approval.focus({preventScroll: true});
}


function drawFlow() {
  const plot = byId('flow').querySelector('.flow-plot');
  if (!plot || !plot.clientWidth) return;
  const edges = plot.querySelector('.flow-edges');
  const relayNode = plot.querySelector('.relay-orb__case');
  const board = plot.getBoundingClientRect();
  const relayRect = relayNode.getBoundingClientRect();
  const midY = (box) => box.top + box.height / 2 - board.top;
  const paths = [...plot.querySelectorAll('.flow-node')].map((node) => {
    const rect = node.getBoundingClientRect();
    const stack = node.parentElement.getBoundingClientRect();
    if (midY(rect) + board.top <= stack.top || midY(rect) + board.top >= stack.bottom) return '';
    const incoming = node.dataset.side === 'source';
    const [start, end] = incoming ? [rect, relayRect] : [relayRect, rect];
    const x1 = start.right - board.left;
    const x2 = end.left - board.left;
    const y1 = midY(start);
    const y2 = midY(end);
    const mid = (x1 + x2) / 2;
    const current = node.classList.contains('is-current');
    const running = node.dataset.activity;
    const arrival = node.classList.contains('is-arrival');
    const path = `M ${x1} ${y1} C ${mid} ${y1} ${mid} ${y2} ${x2} ${y2}`;
    const pinX = incoming ? x1 : x2;
    const pinY = incoming ? y1 : y2;
    return `<path class="board-wire${current ? ' is-current' : ''}"${running ? ` data-activity="${running}"` : ''} d="${path}"/>
      ${current || running ? `<circle class="board-terminal"${running ? ` data-activity="${running}"` : ''} cx="${pinX}" cy="${pinY}" r="3"/>` : ''}
      ${showsRunMotion(running) ? `<path class="running-signal" data-activity="${running}" pathLength="100" d="${path}"/>` :
        arrival ? `<path class="exchange-signal" pathLength="100" d="${path}"/>` : ''}`;
  }).join('');
  if (edges.dataset.geometry === paths) return;
  edges.dataset.geometry = paths;
  edges.style.setProperty('--flow-clock', `-${performance.now()}ms`);
  edges.innerHTML = paths;
}


function renderUsage(items) {
  const priced = items.filter((row) => row.origin === 'import' && row.actualUsd != null);
  const actual = sum(priced, (row) => row.actualUsd);
  chartData = priced.sort((a, b) => a.at.localeCompare(b.at));
  byId('usage-title').textContent = priced.length ? tr('导入用量', "Imported usage") : tr('事件趋势', "Event trends");
  byId('cost-caption').textContent = priced.length ? tr('仅统计文件里有记录的金额', "Totals include charges recorded in imported files") : tr('按事件时间统计', "Events by time");
  byId('cost-unit').hidden = !priced.length;
  byId('usage-summary').hidden = !priced.length;
  byId('usage-summary').innerHTML = priced.length ? `<strong>${amount(actual)}</strong>` : '';
  byId('chart-wrap').hidden = !priced.length;
  byId('chart-legend').hidden = true;
  renderTempo(priced.length ? [] : items);
  byId('sync-details').hidden = false;
  const fields = [
    [tr('已连接 Bot', "Connected bots"), count(local.bots?.length ?? 0)],
    [tr('本机事件更新', "Local events updated"), optionalDate(local.sourceUpdatedAt)],
    [tr('最近检查', "Last checked"), optionalDate(local.checkedAt, formatters.checkedTime)],
  ];
  byId('sync-details').innerHTML = fields.map(([name, value]) => `<dt>${name}</dt><dd>${escape(value)}</dd>`).join('');
  if (priced.length) {
    byId('chart').setAttribute('aria-label', tr(`导入记录用量 ${amount(actual)}`, `Imported usage ${amount(actual)}`));
    drawChart();
  }
}


function chartContext(canvas) {
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (!width || !height) return null;
  const scale = window.devicePixelRatio || 1;
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.scale(scale, scale);
  ctx.font = '11px system-ui';
  const styles = getComputedStyle(document.documentElement);
  const color = (name) => styles.getPropertyValue(name).trim();
  const colors = {
    muted: color('--muted'), grid: color('--grid'), surface: color('--surface'),
    primary: color('--chart-primary'), secondary: color('--chart-secondary'),
    tempoBase: color('--tempo-base'),
  };
  return {ctx, width, height, colors};
}

function drawChartGrid(ctx, colors, plot, labels) {
  const {left, right, top, bottom} = plot;
  ctx.fillStyle = colors.muted;
  ctx.strokeStyle = colors.grid;
  for (const [fraction, label] of labels) {
    const y = bottom - fraction * (bottom - top);
    ctx.beginPath();
    ctx.moveTo(left, y);
    ctx.lineTo(right, y);
    ctx.stroke();
    ctx.fillText(label, 2, y + 4);
  }
}

function drawChartTimeAxis(ctx, colors, {left, right, bottom}, start, end) {
  const crossesDate = end - start >= 86_400_000 || new Date(start).getDate() !== new Date(end).getDate();
  const formatter = crossesDate ? formatters.dayTime : formatters.time;
  const min = formatter.format(start);
  const max = formatter.format(end);
  ctx.fillStyle = colors.muted;
  if (min === max) {
    ctx.fillText(min, (left + right - ctx.measureText(min).width) / 2, bottom + 16);
    return;
  }
  ctx.fillText(min, left, bottom + 16);
  ctx.fillText(max, right - ctx.measureText(max).width, bottom + 16);
  if (right - left >= 310) {
    const mid = formatter.format(start + (end - start) / 2);
    if (mid !== min && mid !== max) {
      ctx.fillText(mid, (left + right - ctx.measureText(mid).width) / 2, bottom + 16);
    }
  }
}

function renderTempo(items) {
  const panel = byId('tempo');
  if (!panel) return;
  const timestamps = items.map((row) => Date.parse(row.at)).filter(Number.isFinite);
  panel.hidden = !timestamps.length;
  if (panel.hidden) {
    tempoData = null;
    return;
  }
  const start = timestamps.reduce((min, timestamp) => Math.min(min, timestamp));
  const end = timestamps.reduce((max, timestamp) => Math.max(max, timestamp));
  const span = end - start;
  const buckets = Array(span === 0 ? 1 : 20).fill(0);
  for (const timestamp of timestamps) {
    const index = span === 0 ? 0 : Math.min(buckets.length - 1, Math.floor((timestamp - start) / span * buckets.length));
    buckets[index]++;
  }
  const peak = Math.max(...buckets);
  tempoData = {start, end, buckets, peak};
  byId('tempo-range').textContent = span === 0 ? tr(`${count(peak)} 个回合`, `${count(peak)} ${peak === 1 ? 'turn' : 'turns'}`) : tr(`峰值 ${count(peak)}`, `Peak ${count(peak)}`);
  byId('tempo-chart').setAttribute('aria-label', span === 0
    ? tr(`${formatters.fullTime.format(start)}，${count(peak)} 个回合`, `${formatters.fullTime.format(start)}, ${count(peak)} ${peak === 1 ? 'turn' : 'turns'}`)
    : tr(`从 ${formatters.fullTime.format(start)} 到 ${formatters.fullTime.format(end)} 分为 ${buckets.length} 段，共 ${count(timestamps.length)} 个回合，单段最多 ${count(peak)} 个`, `From ${formatters.fullTime.format(start)} to ${formatters.fullTime.format(end)}. ${count(timestamps.length)} turns across ${buckets.length} intervals, with a peak of ${count(peak)}.`));
  drawTempo();
}

function drawTempo() {
  if (!tempoData) return;
  const frame = chartContext(byId('tempo-chart'));
  if (!frame) return;
  const {ctx, width, height, colors} = frame;
  const {start, end, buckets, peak} = tempoData;
  const plot = {left: ctx.measureText(count(peak)).width + 12, right: width - 3, top: 9, bottom: height - 21};
  const {left, right, top, bottom} = plot;
  if (right - left < 30 || bottom <= top) return;
  const half = Math.floor(peak / 2);
  const labels = [[0, '0'], [1, count(peak)]];
  if (half) labels.splice(1, 0, [half / peak, count(half)]);
  drawChartGrid(ctx, colors, plot, labels);
  drawChartTimeAxis(ctx, colors, plot, start, end);
  const bucketWidth = (right - left) / buckets.length;
  const barWidth = Math.min(25, Math.max(1, bucketWidth * .58));
  const fill = ctx.createLinearGradient(0, top, 0, bottom);
  fill.addColorStop(0, colors.primary);
  fill.addColorStop(1, colors.tempoBase);
  ctx.fillStyle = fill;
  for (const [index, total] of buckets.entries()) {
    if (!total) continue;
    const barHeight = total / peak * (bottom - top);
    const x = left + (index + .5) * bucketWidth - barWidth / 2;
    ctx.fillRect(x, bottom - barHeight, barWidth, barHeight);
  }
}

function drawChart() {
  if (!chartData.length) return;
  const frame = chartContext(byId('chart'));
  if (!frame) return;
  const {ctx, width, height, colors} = frame;
  const fields = ['baselineUsd', 'actualUsd'].filter((field) => chartData.some((row) => row[field] != null));
  const highest = Math.max(...fields.map((field) => sum(chartData, (row) => row[field])));
  const roughStep = highest / 3 || highest;
  const magnitude = 10 ** Math.floor(Math.log10(roughStep));
  const step = highest ? ([1, 2, 2.5, 5, 10].find((value) => value * magnitude >= roughStep) ?? 1) * magnitude || highest : 0;
  const tickCount = step ? Math.ceil(highest / step) : 0;
  const maximum = tickCount * step;
  const precision = step > 0 ? Math.min(10, Math.max(2, 1 - Math.floor(Math.log10(step)))) : 2;
  const dollars = new Intl.NumberFormat('en-US', {style: 'currency', currency: 'USD', maximumFractionDigits: precision, minimumFractionDigits: 0});
  const amountLabel = (value) => value > 0 && value < 1e-10 ? `$${value.toExponential(1)}` : dollars.format(value);
  const chartLabels = Array.from({length: tickCount + 1}, (_, index) => [tickCount ? index / tickCount : 0, amountLabel(index * step)]);
  const plot = {left: ctx.measureText(amountLabel(maximum)).width + 12, right: width - 6, top: 10, bottom: height - 22};
  const {left, right, top, bottom} = plot;
  if (right - left < 30 || bottom <= top) return;
  const start = Date.parse(chartData[0].at);
  const end = Date.parse(chartData.at(-1).at);
  drawChartGrid(ctx, colors, plot, chartLabels);
  drawChartTimeAxis(ctx, colors, plot, start, end);
  for (const field of fields) {
    const actual = field === 'actualUsd';
    const color = actual ? colors.primary : colors.secondary;
    let cumulative = 0;
    const points = [[left, bottom]];
    for (const row of chartData) {
      if (row[field] == null) continue;
      cumulative += row[field];
      const ratio = start === end ? 1 : (Date.parse(row.at) - start) / (end - start);
      const value = maximum ? cumulative / maximum : 0;
      points.push([left + ratio * (right - left), bottom - value * (bottom - top)]);
    }
    const [x, y] = points.at(-1);
    if (actual && cumulative > 0) {
      ctx.beginPath();
      ctx.moveTo(...points[0]);
      for (const point of points.slice(1)) ctx.lineTo(...point);
      ctx.lineTo(x, bottom);
      ctx.closePath();
      ctx.globalAlpha = .12;
      ctx.fillStyle = color;
      ctx.fill();
      ctx.globalAlpha = 1;
    }
    ctx.beginPath();
    ctx.moveTo(...points[0]);
    for (const point of points.slice(1)) ctx.lineTo(...point);
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    if (!actual) ctx.setLineDash([5, 4]);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.arc(x, y, 3.2, 0, 2 * Math.PI);
    ctx.fillStyle = colors.surface;
    ctx.fill();
    ctx.stroke();
  }
}

function statusBadge(row) {
  const status = rowStatus(row);
  const kind = Object.hasOwn(statusLabels, status) ? status : 'unknown';
  const received = (kind === 'observed' || kind === 'confirmed') && row.lastReplyAt;
  const label = received ? tr('已收到回复', "Reply received") : displayStatus(kind);
  const hint = kind === 'completion-unconfirmed' || received ? tr(' title="已同步可见回复。任务结束状态以 Grok Bot 为准。"', " title=\"Visible replies synced. See Grok Bot for completion status.\"") : '';
  return `<span class="status status-${kind}"${hint}>${label}</span>`;
}

function matchesFlowFilter(row) {
  if (!flowFilter) return true;
  const {field, key} = flowFilter;
  if (field === 'source') return sourceKey(row) === key;
  if (field === 'recipient') return botKey(row) === key;
  if (field === 'status') return rowStatus(row) === key;
  return false;
}

function renderRows(items) {
  const query = byId('search').value.trim().toLowerCase();
  const status = byId('status').value;
  const rows = items.filter((row) => {
    if (status && (status === 'awaiting' ? !isAwaiting(row) : rowStatus(row) !== status)) return false;
    if (!matchesFlowFilter(row)) return false;
    return !query || [row.title, displayEventTitle(row), row.agent, assignedName(row), row.id, displaySource(sourceKey(row))]
      .some((value) => value?.toLowerCase().includes(query));
  }).sort((a, b) => b.at.localeCompare(a.at));
  const pages = Math.max(1, Math.ceil(rows.length / pageSize));
  page = Math.min(page, pages - 1);
  const start = page * pageSize;
  const shown = rows.slice(start, start + pageSize);
  const selected = currentEvent(items);
  byId('results-count').textContent = count(rows.length);

  const root = byId('rows');
  const priorRow = root.contains(document.activeElement) ? document.activeElement.dataset.eventId : null;
  root.innerHTML = shown.length ? shown.map((row, index) => {
    const latest = row.id === selected?.id;
    const fresh = pulsesFor(row, pulseIds);
    const replying = pulsesFor(row, replyPulseIds);
    return `<tr class="${latest ? 'latest-row' : ''}${fresh ? ' is-arrival' : ''}">
      <td class="time">${optionalDate(row.at)}</td>
      <td><button class="row-button" type="button" data-row="${index}" data-event-id="${escape(row.id)}">${escape(displayEventTitle(row))}</button>
      ${latest || fresh ? `<span class="latest-label">${replying ? tr('有新回复', "New reply") : fresh ? tr('刚更新', "Just updated") : tr('最新', "Latest")}</span>` : ''}</td>
      <td>${escape(displaySource(sourceKey(row)))}</td>
      <td>${escape(assignedName(row))}</td>
      <td>${statusBadge(row)}</td>
      <td class="number"${row.latencyMs == null ? tr(' title="没有可用的起止时间"', " title=\"Timing unavailable\"") : row.origin !== 'import' ? tr(' title="记录的输入到首个可见回复"', " title=\"From the recorded input to the first visible reply\"") : ''}>${latency(row.latencyMs)}</td>
      <td class="number"${tokens(row) == null ? tr(' title="源数据未提供 Token"', " title=\"Source did not include token counts\"") : ''}>${count(tokens(row))}</td>
      <td class="number"${row.actualUsd == null ? tr(' title="源数据未提供费用"', " title=\"Source did not include costs\"") : ''}>${amount(row.actualUsd)}</td>
    </tr>`;
  }).join('') : tr('<tr><td class="empty-row" colspan="8">当前没有匹配事件。</td></tr>', "<tr><td class=\"empty-row\" colspan=\"8\">No matching events.</td></tr>");
  for (const button of root.querySelectorAll('[data-row]')) {
    if (button.dataset.eventId === priorRow) button.focus({preventScroll: true});
    button.addEventListener('click', () => openDetail(shown[Number(button.dataset.row)], button));
  }
  const chip = byId('active-filter');
  chip.hidden = !flowFilter;
  if (flowFilter) {
    chip.innerHTML = `<button type="button"><span>${escape(flowFilter.label)}</span>${icon('close')}<span class="sr-only">${tr('清除此筛选', 'Clear this filter')}</span></button>`;
    chip.firstElementChild.addEventListener('click', () => {
      flowFilter = null;
      page = 0;
      render();
      byId('search').focus();
    });
  }
  byId('page-summary').textContent = shown.length ? tr(`显示 ${count(start + 1)}–${count(start + shown.length)} 条，共 ${count(rows.length)} 条`, `Showing ${count(start + 1)}–${count(start + shown.length)} of ${count(rows.length)}`) : tr('共 0 条', "0 events");
  byId('previous').disabled = page === 0;
  byId('next').disabled = page >= pages - 1;
}

function renderRunAccess() {
  byId('run-access').hidden = !native || local.desktopActivity?.access !== 'permission';
  if (local.desktopActivity?.access !== 'permission') byId('run-access-note').hidden = true;
}

function render() {
  displayEvents = mergeEventLog(local.status === 'connected' ? local.events : [], operations.events(), localizeImportedEvents(saved));
  if (detailId && !displayEvents.some((row) => row.id === detailId && row.status === 'handed-off')) {
    byId('detail-content').querySelector('.handoff-recovery')?.remove();
  }
  byId('dataset').dataset.sync = local.status;
  byId('dataset-label').textContent = !native ? tr('Mac App 可连接 Grok Bot', "Connect to Grok Bot in the Mac app") :
    local.status === 'connected' ? tr('Grok Bot 已连接', "Grok Bot connected") : local.status === 'unavailable' ? tr('Grok Bot 暂不可用', "Grok Bot unavailable") : tr('等待 Grok Bot 同步', "Waiting for Grok Bot to sync");
  byId('route-add').disabled = !readyToRoute();
  byId('routing-bindings-open').disabled = !readyToRoute();
  byId('route-add').title = readyToRoute() ? '' : tr('等待已连接的 Grok Bot 和本机事件账本', "Waiting for Grok Bot and the local event ledger");
  byId('overview-copy').textContent = native ? optionalDate(local.sourceUpdatedAt, formatters.time) : tr('事件记录', "Event records");
  renderRunAccess();
  byId('privacy-note').textContent = tr('本机事件账本', "Local event ledger");
  for (const button of byId('periods').querySelectorAll('button')) {
    button.setAttribute('aria-pressed', String(Number(button.dataset.range) === days));
  }
  const items = withinPeriod();
  renderQuota();
  renderMetrics(items);
  renderFlow(items);
  renderUsage(items);
  renderRows(items);
}

function openDetail(row, trigger) {
  detailId = row.id;
  byId('detail-heading').textContent = displayEventTitle(row);
  byId('detail-time').textContent = optionalDate(row.at, formatters.fullTime);
  const list = (entries) => `<dl>${entries.map(([label, value]) => `<dt>${label}</dt><dd>${escape(value)}</dd>`).join('')}</dl>`;
  const details = [[tr('事件 ID', "Event ID"), row.originalId ?? row.id], [tr('来源', "Source"), displaySource(sourceKey(row))], [tr('状态', "Status"), displayStatus(rowStatus(row))]];
  if (row.origin === 'workbench' && row.agent) details.push([tr('路由角色', "Routing role"), row.agent]);
  if (row.targetName || row.origin !== 'workbench' && row.agent) details.push([tr('处理者', "Assigned to"), row.targetName ?? row.agent]);
  if (suggestedBot(row)) details.push([tr('预选 Bot', "Suggested bot"), suggestedBot(row).name]);
  if (row.route) details.push([tr('路由决议', "Routing decision"), row.route === 'ignored' ? tr('忽略', "Ignored") : tr('分派', "Assigned")]);
  if (row.confirmedAt) details.push([tr('镜像确认', "Cache confirmation"), optionalDate(row.confirmedAt, formatters.fullTime)]);
  if (row.lastReplyAt) details.push([tr('回复状态', "Reply status"), tr('已回复', "Replied")]);
  if (row.replyAt) details.push([tr('首次回复时间', "First reply time"), optionalDate(row.replyAt, formatters.fullTime)]);
  if (row.origin !== 'import' && row.latencyMs != null) details.push([tr('首次回复用时', "Time to first reply"), latency(row.latencyMs)]);
  const description = row.details || (row.origin !== 'grok' ? routingEventDetail(row) : null);
  const imported = row.origin === 'import' && [tokens(row), row.actualUsd, row.latencyMs].some((value) => value != null);
  const canCopy = row.origin === 'workbench' && row.status === 'handed-off';
  const observedId = row.origin === 'grok' ? row.id : row.origin === 'workbench' ? row.observedId : null;
  const conversationBot = row.origin === 'grok' ? row.agentKey : row.targetKey;
  const canReadConversation = native && account && observedId && conversationBot;
  const canAcknowledge = rowActivity(row)?.status === 'completion-unconfirmed';
  byId('detail-content').innerHTML = `
    ${canReadConversation ? tr('<section class="detail-section"><h3>对话</h3><div id="detail-conversation"><p role="status">正在读取本机对话…</p></div></section>', "<section class=\"detail-section\"><h3>Conversation</h3><div id=\"detail-conversation\"><p role=\"status\">Loading local conversation…</p></div></section>") : ''}
    <section class="detail-section"><h3>${tr('事件信息', 'Event information')}</h3>${list(details)}</section>
    ${canAcknowledge ? tr('<section class="detail-section"><button type="button" class="button" id="dismiss-run-animation">我已确认结束</button></section>', "<section class=\"detail-section\"><button type=\"button\" class=\"button\" id=\"dismiss-run-animation\">Mark as finished</button></section>") : ''}
    ${description ? `<section class="detail-section"><h3>${tr('事件说明', 'Description')}</h3><p>${escape(description)}</p></section>` : ''}
    ${canCopy ? `<section class="detail-section handoff-recovery"><h3>${tr('交接原文', 'Handoff text')}</h3>
      <p>${tr('在目标 Bot 的私聊里核对本次事件标记。如果会话里还没有这条消息，可原样复制并提交一次。', 'Check the event marker in the target bot’s chat. If the message is absent, copy and send it once.')}</p>
      <textarea id="handoff-text" rows="5" readonly aria-label="${tr('同一事件的交接原文', 'Handoff text for this event')}">${escape(formatHandoff(row))}</textarea>
      <button class="button" type="button" id="copy-handoff">${tr('复制交接原文', 'Copy handoff text')}</button>
      <p id="copy-handoff-status" role="status" hidden></p></section>` : ''}
    ${imported ? `<section class="detail-section"><h3>${tr('导入用量', 'Imported usage')}</h3>${list([
      [tr('输入 Token', "Input tokens"), count(row.inputTokens)], [tr('输出 Token', "Output tokens"), count(row.outputTokens)],
      [tr('缓存读取', "Cache reads"), count(row.cacheReadTokens)], [tr('缓存写入', "Cache writes"), count(row.cacheWriteTokens)],
      [tr('用时', "Duration"), latency(row.latencyMs)], [tr('费用', "Cost"), amount(row.actualUsd)],
    ])}</section>` : ''}`;
  byId('copy-handoff')?.addEventListener('click', (event) => {
    const status = byId('copy-handoff-status');
    status.hidden = false;
    if (!displayEvents.some((item) => item.id === row.id && item.status === 'handed-off')) {
      status.textContent = tr('事件状态已更新，请在日志中查看结果。', "Event status changed. Check the event log.");
      event.currentTarget.disabled = true;
      return;
    }
    const text = byId('handoff-text');
    text.focus();
    text.select();
    let copied = false;
    try {
      copied = document.execCommand('copy');
    } catch {}
    status.textContent = copied ? tr('已复制同一事件的交接文案。', "Handoff text copied.") : tr('文案已选中，按 ⌘C 复制。', "Handoff text selected. Press ⌘C to copy.");
  });
  byId('dismiss-run-animation')?.addEventListener('click', () => {
    if (!runContinuity.acknowledge(row.liveObservedId ?? row.id)) return;
    activity = runContinuity.update(local);
    byId('detail-dialog').close();
    render();
  });
  const dialog = byId('detail-dialog');
  dialogOpeners.set(dialog, trigger);
  dialog.showModal();
  byId('detail-content').scrollTop = 0;
  if (canReadConversation) void showConversation(row.id, observedId, conversationBot, row.origin === 'workbench');
}

async function showConversation(eventId, observedId, targetKey, isHandoff) {
  const pane = byId('detail-conversation');
  const accountKey = account;
  const revision = ledgerEpoch;
  const stillOpen = () => pane.isConnected && byId('detail-dialog').open && detailId === eventId &&
    account === accountKey && ledgerEpoch === revision;
  const notice = document.createElement('p');
  notice.className = 'conversation-notice';
  notice.setAttribute('role', 'status');
  try {
    const result = await bridge('workbenchConversation', {accountKey, botKey: targetKey, observedId});
    if (!stillOpen()) return;
    if (!result?.ok) throw new Error(result?.error || tr('本机镜像暂时无法读取这条对话。', "This conversation is unavailable in the local cache."));
    const messages = Array.isArray(result.messages) ? result.messages.filter((message) =>
      (message?.role === 'user' || message?.role === 'assistant') && typeof message.text === 'string') : [];
    if (!messages.length) {
      notice.textContent = tr('本机镜像中没有这条事件的可见对话。', "The local cache has no visible messages for this event.");
      pane.replaceChildren(notice);
      return;
    }
    const thread = document.createElement('div');
    thread.className = 'conversation-list';
    for (const message of messages) {
      const block = document.createElement('article');
      block.className = 'conversation-message';
      block.dataset.role = message.role;
      const head = document.createElement('header');
      const speaker = document.createElement('strong');
      speaker.textContent = message.role === 'assistant' ? tr('Bot 回答', "Bot reply") : isHandoff ? tr('交接内容', "Handoff") : tr('用户提问', "User message");
      head.append(speaker);
      if (message.at) {
        const timestamp = document.createElement('time');
        timestamp.dateTime = message.at;
        timestamp.textContent = optionalDate(message.at, formatters.fullTime);
        head.append(timestamp);
      }
      const body = document.createElement('pre');
      body.textContent = message.text;
      block.append(head, body);
      thread.append(block);
    }
    pane.replaceChildren(thread);
    if (result.truncated) {
      notice.textContent = tr('这条对话较长，部分内容未显示。', "Only part of this conversation is shown.");
      pane.append(notice);
    }
  } catch (error) {
    if (!stillOpen()) return;
    notice.textContent = error.message;
    pane.replaceChildren(notice);
  }
}


function openStorage() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('grok-bot-workbench', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('datasets');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function withStorage(mode, operation) {
  const db = await openStorage();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction('datasets', mode);
      const request = operation(tx.objectStore('datasets'));
      tx.oncomplete = () => resolve(request.result);
      tx.onabort = () => reject(tx.error);
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

function refreshImportInfo() {
  byId('active-dataset').textContent = saved?.name ? tr(`当前导入文件 · ${saved.name}`, `Imported file · ${saved.name}`) : tr('导入记录会并入事件日志。', "Imported records appear in the event log.");
}

function openImport(event) {
  refreshImportInfo();
  if (!byId('file-input').disabled) setImportStatus('');
  const dialog = byId('import-dialog');
  dialogOpeners.set(dialog, event.currentTarget);
  dialog.showModal();
}

function setImportStatus(message, error = false) {
  const element = byId('import-status');
  element.hidden = !message;
  element.textContent = message;
  element.dataset.error = String(error);
}

function readRecords(content, filename) {
  if (/\.json$/i.test(filename)) {
    const payload = JSON.parse(content.replace(/^\uFEFF/, ''));
    if (payload && typeof payload === 'object' && Object.hasOwn(payload, 'resourceLogs')) {
      return {...parseOtlp(payload), kind: 'otlp'};
    }
  }
  return {...parseImport(content, filename, {trackDisplayDefaults: true}), kind: /\.csv$/i.test(filename) ? 'billing' : 'workflow'};
}

async function importFile(event) {
  const input = event.currentTarget;
  const file = input.files[0];
  if (!file) return;
  input.disabled = true;
  setImportStatus(tr('正在读取文件…', "Reading file…"));
  try {
    if (file.size > 10 * 1024 * 1024) throw new Error(tr('文件超过 10 MB，请缩小导出时间范围后重试。', "This file exceeds 10 MB. Export a shorter date range and try again."));
    const result = readRecords(await file.text(), file.name);
    if (!result.events.length) throw new Error(tr('文件中没有可显示的记录。', "This file has no records to display."));
    const next = {...result, name: file.name};
    let persisted = true;
    try {
      await withStorage('readwrite', (store) => store.put(next, 'imported'));
    } catch {
      persisted = false;
    }
    saved = next;
    page = 0;
    render();
    refreshImportInfo();
    const skipped = result.skipped ? tr(`，跳过 ${count(result.skipped)} 条不适用或无法读取的记录`, `, skipped ${count(result.skipped)}`) : '';
    const total = count(result.events.length);
    const imported = tr(`已导入 ${total} 条记录${skipped}。`, `Imported ${total} ${result.events.length === 1 ? 'record' : 'records'}${skipped}.`);
    setImportStatus(imported + (persisted ? '' : tr(' 导入文件仅在当前页面有效。', ' This import is available only until you close or reload this page.')));
  } catch (error) {
    setImportStatus(error instanceof SyntaxError ? tr('JSON 格式有误，请检查文件后重试。', "Invalid JSON. Check the file and try again.") : error.message || tr('读取文件失败。', "Could not read the file."), true);
  } finally {
    input.value = '';
    input.disabled = false;
  }
}

byId('periods').addEventListener('click', (event) => {
  const button = event.target.closest('[data-range]');
  if (!button) return;
  days = Number(button.dataset.range);
  page = 0;
  render();
});
for (const [id, type] of [['search', 'input'], ['status', 'change']]) {
  byId(id).addEventListener(type, () => {
    page = 0;
    renderRows(withinPeriod());
  });
}
for (const [id, delta] of [['previous', -1], ['next', 1]]) {
  byId(id).addEventListener('click', () => {
    page += delta;
    renderRows(withinPeriod());
  });
}
const languageButtons = [...byId('language-control').querySelectorAll('button[data-language]')];
function updateLanguageButtons() {
  for (const button of languageButtons) {
    button.setAttribute('aria-pressed', String(button.dataset.language === currentLanguage()));
  }
}

localizeDocument(document);
updateLanguageButtons();
function changeLanguage(event) {
  const choice = event.currentTarget.dataset.language;
  if (choice === currentLanguage()) return;
  const language = setLanguage(choice);
  setFormatters();
  localizeDocument(document);
  updateLanguageButtons();
  try { localStorage.setItem(languageKey, language); } catch {}
  const preference = window.webkit?.messageHandlers?.workbenchSetLanguage;
  if (preference) preference.postMessage({language}).catch(() => {});
  if (flowFilter?.field === 'source') flowFilter.label = displaySource(flowFilter.key);
  else if (flowFilter?.field === 'status') flowFilter.label = displayStatus(flowFilter.key);
  clearTimeout(syncFeedbackTimer);
  byId('sync-feedback').hidden = true;
  byId('run-access-note').hidden = true;
  byId('official-usage-error').hidden = true;
  report('', '', waitingNoticeId);
  render();
}
for (const button of languageButtons) button.addEventListener('click', changeLanguage);

byId('import-open').addEventListener('click', openImport);
byId('sync-refresh').hidden = !native;
byId('sync-refresh').addEventListener('click', refreshSync);
byId('run-access').addEventListener('click', connectRunStatus);
byId('official-usage').addEventListener('click', openOfficialUsage);
byId('file-input').addEventListener('change', importFile);
byId('route-add').addEventListener('click', (event) => { if (readyToRoute()) routingControls.openEvent(event.currentTarget); });
byId('routing-bindings-open').addEventListener('click', (event) => {
  if (readyToRoute()) routingControls.openBindings(event.currentTarget);
});
for (const dialog of document.querySelectorAll('dialog')) {
  dialog.querySelector('.dialog-close').addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => {
    if (dialog.open) return;
    let trigger = dialogOpeners.get(dialog);
    dialogOpeners.delete(dialog);
    if (dialog === byId('detail-dialog')) {
      if (!trigger?.isConnected && detailId) {
        trigger = [...byId('rows').querySelectorAll('[data-event-id]')].find((button) => button.dataset.eventId === detailId);
      }
      detailId = null;
      byId('detail-content').replaceChildren();
    }
    trigger?.focus({preventScroll: true});
  });
}

byId('board-emblem').innerHTML = relay('relay-orb--compact');
new ResizeObserver(drawChart).observe(byId('chart-wrap'));
new ResizeObserver(drawTempo).observe(byId('tempo'));
new ResizeObserver(drawFlow).observe(byId('flow'));
new IntersectionObserver(([entry]) => entry.target.classList.toggle('is-visible', entry.isIntersecting)).observe(byId('flow'));
render();

async function loadLedger(key, revision) {
  try {
    const state = await bridge('workbenchLedger', {op: 'load', accountKey: key});
    if (account !== key || ledgerEpoch !== revision) return;
    if (!state?.ok) throw new Error(state?.error || tr('读取本机事件账本失败。', "Could not read the local event ledger."));
    const candidate = createEventStore(state.data);
    if (!candidate.hasBindings()) {
      const bindings = firstRoleBindings();
      if (Object.keys(bindings).length) {
        candidate.setBindings(bindings);
        const persisted = await bridge('workbenchLedger', {op: 'save', accountKey: key, data: candidate.serialize()});
        if (account !== key || ledgerEpoch !== revision) return;
        if (!persisted?.ok) throw new Error(persisted?.error || tr('无法保存角色默认绑定。', "Could not save role bindings."));
      }
    }
    operations = candidate;
    ledgerReady = true;
    render();
    reconcileMirror();
  } catch (failure) {
    if (account === key && ledgerEpoch === revision) report(failure.message, 'error');
  }
}

if (native) {
  let desktopView = '';
  const activityView = () => JSON.stringify([local.desktopActivity?.access, [...activity.byBot]]);
  const renderLiveActivity = (force = false) => {
    activity = runContinuity.update(local);
    const nextView = activityView();
    if (!force && nextView === desktopView) return;
    desktopView = nextView;
    const feedback = byId('sync-feedback');
    if (feedback.dataset.type === 'permission' && local.desktopActivity?.access !== 'permission') feedback.hidden = true;
    renderRunAccess();
    const items = withinPeriod();
    renderFlow(items);
    renderRows(items);
  };
  window.grokWorkbenchPauseMonitoring = (scope) => {
    if (scope < local.desktopScope) return;
    local = {...local, desktopScope: scope, desktopActivity: undefined};
    clearPulses();
    clearTimeout(pulseTimer);
    renderLiveActivity(true);
  };
  window.grokWorkbenchDesktopUpdate = (scope, sample) => {
    if (local.status !== 'connected' || scope !== local.desktopScope ||
        !sample || sample.sampledAt <= (local.desktopActivity?.sampledAt ?? -Infinity)) return;
    local = {...local, desktopActivity: sample};
    renderLiveActivity();
  };
  window.grokWorkbenchUpdate = (payload) => {
    if (!payload || !['waiting', 'unavailable', 'connected'].includes(payload.status) ||
        !Array.isArray(payload.events) || payload.desktopScope < local.desktopScope) return;
    const syncFeedback = byId('sync-feedback');
    if (payload.status === 'connected' && local.accountKey === payload.accountKey &&
        local.desktopScope === payload.desktopScope && local.desktopActivity &&
        (!payload.desktopActivity || local.desktopActivity.sampledAt > payload.desktopActivity.sampledAt)) {
      payload.desktopActivity = local.desktopActivity;
    }
    local = payload;
    activity = runContinuity.update(payload);
    desktopView = activityView();
    const nextAccount = local.status === 'connected' && typeof local.accountKey === 'string' ? local.accountKey : null;
    const changedAccount = account !== nextAccount;
    if (changedAccount || (syncFeedback.dataset.type === 'permission' && payload.desktopActivity?.access !== 'permission') ||
        (payload.status === 'connected' && syncFeedback.dataset.type === 'error' && !byId('sync-refresh').disabled)) {
      syncFeedback.hidden = true;
    }
    const update = liveUpdates.update(payload);
    recentByBot = update.recentByBot;
    const previousObserved = lastObservedId;
    lastObservedId = update.latestId;
    if (changedAccount) {
      account = nextAccount;
      ledgerEpoch++;
      operations = createEventStore();
      ledgerReady = false;
      focusId = update.latestId;
      clearPulses();
      clearTimeout(pulseTimer);
      flowFilter = null;
      page = 0;
      days = 0;
      byId('search').value = '';
      byId('status').value = '';
      byId('live-announcement').textContent = '';
      routingControls.closeApprovals();
      if (byId('detail-dialog').open) byId('detail-dialog').close();
      byId('detail-heading').textContent = tr('事件详情', "Event details");
      byId('detail-time').textContent = '';
      byId('detail-content').replaceChildren();
      report();
      if (account) void loadLedger(account, ledgerEpoch);
    } else if (update.arrivals.length || update.replies.length || update.newBots.length) {
      const ids = new Set([...update.arrivals, ...update.replies].map((row) => row.id));
      const changed = ids.delete(update.latestId) ? [update.latestId, ...ids] : [...ids];
      highlight(changed, {
        replies: update.replies.map((row) => row.id), bots: update.newBots.map((bot) => bot.key),
      });
      byId('live-announcement').textContent = update.replies.length ? tr(`Grok Bot 同步了 ${count(update.replies.length)} 个事件的新回复。`, `Grok Bot synced new replies for ${count(update.replies.length)} events.`) :
        update.arrivals.length ? tr(`Grok Bot 同步了 ${count(update.arrivals.length)} 条事件。`, `Grok Bot synced ${count(update.arrivals.length)} events.`) :
          tr(`Grok Bot 名册新增 ${count(update.newBots.length)} 个 Bot。`, `${count(update.newBots.length)} new bots in the Grok Bot roster.`);
    } else if (!pulseIds.size && (!focusId || focusId === previousObserved || !payload.events.some((row) => row.id === focusId) &&
        !operations.events().some((row) => rowMatches(row, focusId)))) {
      focusId = update.latestId;
    }
    render();
    if (detailId && !displayEvents.some((row) => row.id === detailId)) {
      byId('detail-dialog').close();
      byId('detail-content').replaceChildren();
    }
    if (!changedAccount) reconcileMirror();
  };
}
withStorage('readonly', (store) => store.get('imported')).then((last) => {
  if (!last || saved) return;
  saved = last;
  render();
  if (byId('import-dialog').open) refreshImportInfo();
}).catch(() => {});

