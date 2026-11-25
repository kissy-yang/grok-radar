import {tr} from './i18n.mjs';

const MAX_ROTATED_IDS = 32_768;
const RECENT_REPLY_MS = 30_000;
const formatEnglishList = new Intl.ListFormat('en');

function eventEvidence(snapshot) {
  return JSON.stringify([
    snapshot.latestEventAt,
    snapshot.bots?.map(({key, name}) => [key, name]),
    snapshot.events?.map(({id, at, replyAt, lastReplyAt, latencyMs, trigger, hasBotOutput, handoffId, sourceAgentKey}) =>
      [id, at, replyAt, lastReplyAt, latencyMs, trigger, hasBotOutput, handoffId, sourceAgentKey]),
    snapshot.activeRuns?.map(({id, at}) => [id, at]),
  ]);
}

export function refreshChanges(before, after) {
  const sameAccount = before.status === 'connected' && before.accountKey === after.accountKey;
  const events = !sameAccount || eventEvidence(before) !== eventEvidence(after);
  const currentQuota = after.weeklyQuota;
  const previousQuota = before.weeklyQuota;
  const currentTime = Date.parse(currentQuota?.updatedAt);
  const previousTime = Date.parse(previousQuota?.updatedAt);
  if (!Number.isFinite(currentTime)) return {events, quota: 'unavailable'};
  const updated = !sameAccount || !Number.isFinite(previousTime) || currentTime > previousTime ||
    (currentTime === previousTime && (currentQuota.remainingPercent !== previousQuota.remainingPercent ||
      currentQuota.resetAt !== previousQuota.resetAt));
  return {events, quota: updated ? 'updated' : 'unchanged'};
}

export function refreshRunMessage({bots = [], desktopActivity}) {
  if (desktopActivity?.access === 'permission') {
    return tr('请在「系统设置 → 隐私与安全性 → 辅助功能（设备控制和数据访问）」中允许「Grok Radar」读取 Bot 的运行状态',
      'Enable Grok Radar in System Settings → Privacy & Security → Accessibility (Device Control and Data Access) to read bot status');
  }
  const states = desktopActivity?.access === 'ready' ? desktopActivity.states : null;
  const running = [];
  const waiting = [];
  let checked = 0;
  for (const {key, name} of bots) {
    const state = states?.[key];
    if (state === 'working') running.push(name);
    else if (state === 'waiting') waiting.push(name);
    else if (state !== 'idle') continue;
    checked++;
  }
  if (!checked) return tr('暂时读不到 Bot 的运行状态，请打开 Grok Bot 窗口后再刷新', 'Open the Grok Bot window, then refresh to check bot status');
  const messages = [];
  const englishNames = names => formatEnglishList.format(names.map(name => `“${name}”`));
  if (running.length) messages.push(tr(`「${running.join('」、「')}」正在运行`,
    `${englishNames(running)} ${running.length === 1 ? 'is' : 'are'} running`));
  else if (checked === bots.length) messages.push(tr('当前没有 Bot 在运行', 'No bots are running'));
  if (waiting.length) messages.push(tr(`「${waiting.join('」、「')}」正在等你处理`,
    `${englishNames(waiting)} ${waiting.length === 1 ? 'is' : 'are'} waiting for you`));
  if (checked < bots.length) messages.push(tr('部分 Bot 的运行状态暂时无法确认', 'Some bot statuses could not be confirmed'));
  return messages.join(tr('。', '. '));
}

function collect(events, latestReplyTime = Infinity) {
  const records = new Map();
  for (const event of events) {
    if (typeof event?.id !== 'string' || !event.id || typeof event.at !== 'string') continue;
    const time = Date.parse(event.at);
    if (!Number.isFinite(time)) continue;
    const replyAt = Date.parse(event.lastReplyAt);
    const replyTime = replyAt >= time && replyAt <= latestReplyTime ? replyAt : -Infinity;
    const previous = records.get(event.id);
    if (!previous || time > previous.time || (time === previous.time && replyTime > previous.replyTime)) {
      records.set(event.id, {event, time, replyTime, activityTime: Math.max(time, replyTime)});
    }
  }
  return records;
}

function newestActivityFirst(left, right) {
  return right.activityTime - left.activityTime || (left.event.id < right.event.id ? -1 : 1);
}

export function liveBotActivity(snapshot) {
  const byRun = new Map();
  const byBot = new Map();
  if (snapshot.status !== 'connected') return {byRun, byBot};
  const bots = new Set(snapshot.bots?.map(({key}) => key));
  const observed = collect(snapshot.events);
  for (const [status, runs] of [
    ['running', snapshot.activeRuns], ['waiting-reply', snapshot.waitingRuns], ['waiting-followup', snapshot.followupRuns],
    ['completion-unconfirmed', snapshot.unconfirmedRuns],
  ]) {
    if (!Array.isArray(runs)) continue;
    const basedOnReply = status === 'waiting-followup' || status === 'completion-unconfirmed';
    for (const run of runs) {
      const record = observed.get(run?.id);
      const time = Date.parse(run?.at);
      if (!record || !bots.has(run.agentKey) || record.event.agentKey !== run.agentKey ||
          !Number.isFinite(time) || byRun.has(run.id) ||
          (basedOnReply && time !== record.replyTime)) continue;
      const activity = {status, time, eventId: run.id, agentKey: run.agentKey,
        handoffId: record.event.handoffId, sourceAgentKey: record.event.sourceAgentKey,
        task: typeof run.task === 'string' ? run.task : ''};
      byRun.set(run.id, activity);
      const previous = byBot.get(run.agentKey);
      if (!previous || (previous.status === status && time > previous.time)) byBot.set(run.agentKey, activity);
    }
  }
  return {byRun, byBot};
}

export function orderBotCards(bots, byBot, recentByBot = new Map()) {
  const priority = {running: 0, 'waiting-reply': 1, 'waiting-followup': 1, 'waiting-input': 2, 'completion-unconfirmed': 2};
  return [...bots].sort((left, right) => {
    const a = byBot.get(left.key);
    const b = byBot.get(right.key);
    return (priority[a?.status] ?? 3) - (priority[b?.status] ?? 3) ||
      (b?.time ?? recentByBot.get(right.key) ?? 0) - (a?.time ?? recentByBot.get(left.key) ?? 0);
  });
}

// Only a matched official working state warrants continuous motion.
export const showsRunMotion = status => status === 'running';

export function createRunContinuity() {
  let account;
  let lastSample;
  const tracking = new Map();
  const stopped = new Set();

  function rememberStopped(id) {
    if (!id) return;
    stopped.add(id);
    if (stopped.size > MAX_ROTATED_IDS) stopped.delete(stopped.values().next().value);
  }

  function acknowledge(eventId) {
    for (const [key, item] of tracking) {
      if (item.state.eventId !== eventId || item.state.status !== 'completion-unconfirmed') continue;
      tracking.delete(key);
      rememberStopped(eventId);
      return true;
    }
    return false;
  }

  function update(snapshot) {
    const result = {byBot: new Map(), byRun: new Map()};
    if (snapshot.status !== 'connected') {
      lastSample = undefined;
      for (const item of tracking.values()) {
        item.idleReads = 0;
        item.state = {...item.state, status: 'completion-unconfirmed'};
      }
      return result;
    }
    if (account !== snapshot.accountKey) {
      account = snapshot.accountKey;
      lastSample = undefined;
      tracking.clear();
      stopped.clear();
    }
    const events = collect(snapshot.events);
    const roster = new Set(snapshot.bots?.map(({key}) => key));
    const mirror = liveBotActivity(snapshot);
    const latestInputs = new Map();
    for (const record of events.values()) {
      const {agentKey, trigger, sourceAgentKey} = record.event;
      if (trigger !== 'person' && !(trigger === 'bot' && sourceAgentKey)) continue;
      if (record.time > (latestInputs.get(agentKey)?.time ?? -Infinity)) latestInputs.set(agentKey, record);
    }
    for (const key of tracking.keys()) if (!roster.has(key)) tracking.delete(key);

    const desktopActivity = snapshot.desktopActivity;
    const sampledAt = desktopActivity?.sampledAt;
    const newSample = !Number.isFinite(sampledAt) || sampledAt !== lastSample;
    lastSample = sampledAt;
    const states = desktopActivity?.access === 'ready' ? desktopActivity.states : null;
    for (const key of roster) {
      const desktop = states && Object.hasOwn(states, key) ? states[key] : null;
      const newestInput = latestInputs.get(key);
      const latest = newestInput && !stopped.has(newestInput.event.id) ? newestInput : null;
      let hint = mirror.byBot.get(key);
      let item = tracking.get(key);
      if (hint && (stopped.has(hint.eventId) || (newestInput && newestInput.time > events.get(hint.eventId).time))) hint = null;
      if (item && ((latest && latest.event.id !== item.state.eventId && latest.time > item.startedAt) ||
          (hint && hint.eventId !== item.state.eventId))) {
        tracking.delete(key);
        item = null;
      }
      if (!hint && !item && desktop !== 'working') continue;
      // An old unanswered mirror entry must not keep the card on screen forever.
      if (!hint && !desktop) {
        if (item?.seenWorking) {
          item.idleReads = 0;
          item.state = {...item.state, status: 'completion-unconfirmed'};
        } else {
          tracking.delete(key);
        }
        continue;
      }
      const workingInput = desktop === 'working' ? latest : null;
      const record = events.get(hint?.eventId) ?? events.get(item?.state.eventId) ?? workingInput;
      const eventId = record?.event.id ?? item?.state.eventId ?? null;
      const seenWorking = desktop === 'working' || item?.seenWorking === true;
      const canConfirmIdle = seenWorking || Number.isFinite(record?.replyTime) || hint?.status === 'running';
      const idleReads = desktop === 'idle' && canConfirmIdle ? (item?.idleReads ?? 0) + Number(newSample) : 0;
      if (idleReads >= 2) {
        tracking.delete(key);
        rememberStopped(eventId);
        for (const [id, cached] of mirror.byRun) if (cached.agentKey === key) rememberStopped(id);
        continue;
      }
      if (desktop === 'idle' && !hint && !canConfirmIdle) {
        tracking.delete(key);
        continue;
      }

      let status = hint?.status ?? 'completion-unconfirmed';
      if (status === 'running') status = 'completion-unconfirmed';
      if (desktop === 'waiting') status = 'waiting-input';
      if (desktop === 'working' || (idleReads === 1 && item?.state.status === 'running')) status = 'running';
      const state = {
        status, eventId, agentKey: key,
        time: hint?.time ?? record?.activityTime ?? item?.state.time ?? 0,
        task: hint?.task || item?.state.task || '',
        handoffId: record?.event.handoffId ?? item?.state.handoffId,
        sourceAgentKey: record?.event.sourceAgentKey ?? item?.state.sourceAgentKey,
      };
      tracking.set(key, {state, seenWorking, idleReads, startedAt: record?.time ?? item?.startedAt ?? -Infinity});
      result.byBot.set(key, state);
      if (eventId) result.byRun.set(eventId, state);
    }
    return result;
  }

  return {update, acknowledge};
}

export function createLiveUpdates() {
  let initialized = false;
  let accountKey = null;
  let latestId = null;
  let highWater = -Infinity;
  let highWaterId = null;
  let visible = new Set();
  const rotated = new Set();
  const seenReplies = new Map();
  let roster = null;
  const joinedAt = new Map();

  function reset() {
    initialized = false;
    accountKey = null;
    latestId = null;
    highWater = -Infinity;
    highWaterId = null;
    visible.clear();
    rotated.clear();
    seenReplies.clear();
    roster = null;
    joinedAt.clear();
  }

  function remember(records) {
    for (const id of visible) {
      if (!records.has(id)) rotated.add(id);
    }
    for (const id of records.keys()) rotated.delete(id);
    const oldest = rotated.values();
    while (rotated.size > MAX_ROTATED_IDS) {
      const id = oldest.next().value;
      rotated.delete(id);
      seenReplies.delete(id);
    }
    visible = new Set(records.keys());
  }

  function update(snapshot) {
    const key = typeof snapshot.accountKey === 'string' && snapshot.accountKey ? snapshot.accountKey : null;
    if (snapshot.status !== 'connected') {
      // Only an explicitly identified account can resume its baseline after a gap.
      if (!accountKey || (key && key !== accountKey)) reset();
      latestId = null;
      return {latestId, arrivals: [], replies: [], newBots: [], recentByBot: new Map()};
    }

    if (initialized && key !== accountKey) reset();
    const checkedAt = Date.parse(snapshot.checkedAt);
    const records = collect(snapshot.events, Number.isFinite(checkedAt) ? checkedAt + 1000 : Infinity);
    const newBots = [];
    if (Array.isArray(snapshot.bots)) {
      const next = new Map(snapshot.bots.filter((bot) => typeof bot?.key === 'string' && bot.key).map((bot) => [bot.key, bot]));
      if (roster) {
        for (const [botKey, bot] of next) {
          if (roster.has(botKey)) continue;
          newBots.push(bot);
          joinedAt.set(botKey, Number.isFinite(checkedAt) ? checkedAt : 0);
        }
      }
      for (const botKey of joinedAt.keys()) if (!next.has(botKey)) joinedAt.delete(botKey);
      roster = next;
    }
    if (records.get(highWaterId)?.time < highWater) {
      // Replica updates can add an earlier entry to the same round.
      highWater = -Infinity;
      highWaterId = null;
      for (const {event, time} of records.values()) {
        if (time > highWater && (visible.has(event.id) || rotated.has(event.id))) {
          highWater = time;
          highWaterId = event.id;
        }
      }
    }
    const arrivals = [];
    const replies = [];
    const recentByBot = new Map(joinedAt);
    let newest = null;
    let newestStart = null;
    for (const record of records.values()) {
      const {event, time, replyTime, activityTime} = record;
      const {id, agentKey} = event;
      if (!newest || newestActivityFirst(record, newest) < 0) newest = record;
      if (!newestStart || time > newestStart.time) newestStart = record;
      if (roster?.has(agentKey) && activityTime > (recentByBot.get(agentKey) ?? -Infinity)) {
        recentByBot.set(agentKey, activityTime);
      }
      if (replyTime > (seenReplies.get(id) ?? -Infinity)) {
        seenReplies.set(id, replyTime);
        if (initialized && roster?.has(agentKey) && replyTime >= checkedAt - RECENT_REPLY_MS) {
          replies.push(record);
        }
      }
      if (initialized && time >= highWater && !visible.has(id) && !rotated.has(id)) arrivals.push(record);
    }

    arrivals.sort(newestActivityFirst);
    replies.sort(newestActivityFirst);
    const newestChange = [arrivals[0], replies[0]].filter(Boolean).sort(newestActivityFirst)[0];
    if (newestChange) {
      latestId = newestChange.event.id;
    } else if (!newest || records.get(latestId)?.activityTime !== newest.activityTime) {
      latestId = newest?.event.id ?? null;
    }
    if (newestStart && newestStart.time > highWater) {
      highWater = newestStart.time;
      highWaterId = newestStart.event.id;
    }
    remember(records);
    accountKey = key;
    initialized = true;
    return {latestId, arrivals: arrivals.map(({event}) => event), replies: replies.map(({event}) => event), newBots, recentByBot};
  }

  return {update};
}
