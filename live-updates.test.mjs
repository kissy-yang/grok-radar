import {strict as assert} from 'node:assert';
import {test} from 'node:test';
import {createLiveUpdates, createRunContinuity, liveBotActivity, orderBotCards, refreshChanges, refreshRunMessage, showsRunMotion} from './live-updates.mjs';

const at = (second) => new Date(Date.UTC(2026, 10, 23, 2, 0, second)).toISOString();
const row = (id, second, agentKey = 'bot-a') => ({id, at: at(second), agentKey});
function sync(tracker, rows, accountKey = 'account-a') {
  return roundChanges(tracker.update({status: 'connected', accountKey, events: rows}));
}

const roundChanges = ({latestId, arrivals}) => ({latestId, arrivals});

test('an event refresh carrying the same desktop sample cannot confirm a stop', () => {
  const tracker = createRunContinuity();
  const key = 'bot-a';
  const event = {...row('running', 2, key), trigger: 'person'};
  const snapshot = {status: 'connected', accountKey: 'account', bots: [{key}], events: [event]};
  const sample = (state, sampledAt) => ({access: 'ready', states: {[key]: state}, sampledAt});
  const update = (desktopActivity, extra = {}) => tracker.update({...snapshot, ...extra, desktopActivity}).byBot.get(key)?.status;
  assert.equal(update(sample('working', 1)), 'running');
  assert.equal(update(sample('idle', 2)), 'running');
  assert.equal(update(sample('idle', 2), {checkedAt: at(7)}), 'running');
  assert.equal(update(sample('idle', 3)), undefined);
});

test('a new desktop run keeps its first idle confirmation while the mirror shows a finished turn', () => {
  const tracker = createRunContinuity();
  const key = 'bot-a';
  const old = {...row('old', 2, key), trigger: 'person'};
  const snapshot = {status: 'connected', accountKey: 'account', bots: [{key}], events: [old]};
  const update = (state, sampledAt) => tracker.update({...snapshot,
    desktopActivity: {access: 'ready', states: {[key]: state}, sampledAt}}).byBot.get(key);
  assert.equal(update('working', 1)?.eventId, old.id);
  assert.equal(update('idle', 2)?.status, 'running');
  assert.equal(update('idle', 3), undefined);
  assert.equal(update('working', 4)?.eventId, null);
  assert.equal(update('working', 5)?.status, 'running');
  assert.equal(update('idle', 6)?.status, 'running');
  assert.equal(update('idle', 7), undefined);
});

test('refresh names the working Bots in the current roster and separates those waiting for input', () => {
  const bots = [{key: 'a', name: '文档主编'}, {key: 'b', name: '润色师'}, {key: 'c', name: '测试'}];
  const message = states => refreshRunMessage({bots, desktopActivity: {access: 'ready', states},
    activeRuns: [{agentKey: 'c'}], unconfirmedRuns: [{agentKey: 'a'}]});
  assert.equal(message({a: 'working', b: 'working', c: 'waiting', former: 'working'}), '「文档主编」、「润色师」正在运行。「测试」正在等你处理');
  assert.equal(message({a: 'idle', b: 'idle', c: 'idle', former: 'working'}), '当前没有 Bot 在运行');
  assert.equal(message({a: 'idle', b: 'waiting', c: 'idle'}), '当前没有 Bot 在运行。「润色师」正在等你处理');
  assert.equal(message({a: 'idle', b: 'working'}), '「润色师」正在运行。部分 Bot 的运行状态暂时无法确认');
  assert.equal(message({a: 'idle', b: 'unknown'}), '部分 Bot 的运行状态暂时无法确认');
});

test('refresh reports missing permission or unreadable status without treating stale evidence as idle', () => {
  const bots = [{key: 'a', name: '文档主编'}];
  const snapshot = {bots, desktopActivity: {access: 'permission', states: {a: 'working'}}};
  assert.match(refreshRunMessage(snapshot), /系统设置.*隐私与安全性.*辅助功能.*Grok Radar/);
  for (const desktopActivity of [undefined, {access: 'unavailable', states: {a: 'idle'}}, {access: 'ready', states: {}}]) {
    assert.match(refreshRunMessage({bots, desktopActivity}), /暂时读不到 Bot 的运行状态/);
  }
  assert.match(refreshRunMessage({bots: [], desktopActivity: {access: 'ready', states: {}}}), /暂时读不到/);
});

test('marks the most recent initial row without emitting historical activity', () => {
  const tracker = createLiveUpdates();
  assert.deepEqual(sync(tracker, [row('first', 4), row('latest', 9), row('older', 1)]), {
    latestId: 'latest', arrivals: [],
  });
});

test('emits new rows across bots once, ordered by time and stable ID', () => {
  const tracker = createLiveUpdates();
  const existing = row('existing', 1);
  sync(tracker, [existing]);
  const left = row('a', 4);
  const right = row('b', 4, 'bot-b');
  const earlier = row('c', 3, 'bot-c');
  const events = [existing, right, earlier, left, right];
  assert.deepEqual(sync(tracker, events), {latestId: 'a', arrivals: [left, right, earlier]});
  assert.deepEqual(sync(tracker, [...events, {...left, title: 'updated output'}]), {
    latestId: 'a', arrivals: [],
  });
});

test('keeps a high-water mark during empty snapshots and ignores backfilled history', () => {
  const tracker = createLiveUpdates();
  const anchor = row('anchor', 8);
  sync(tracker, [anchor]);
  assert.deepEqual(sync(tracker, []), {latestId: null, arrivals: []});
  const historical = row('historical', 5);
  assert.deepEqual(sync(tracker, [historical]), {latestId: 'historical', arrivals: []});
  const tied = row('tied', 8);
  assert.deepEqual(sync(tracker, [historical, anchor, tied]), {latestId: 'tied', arrivals: [tied]});
});

test('does not replay a rotated row and falls back when the highlighted row leaves', () => {
  const tracker = createLiveUpdates();
  sync(tracker, [row('older', 6)]);
  const recent = row('recent', 9);
  assert.deepEqual(sync(tracker, [recent]), {latestId: 'recent', arrivals: [recent]});
  assert.deepEqual(sync(tracker, [row('older', 6)]), {latestId: 'older', arrivals: []});
  assert.deepEqual(sync(tracker, [recent]), {latestId: 'recent', arrivals: []});
});

test('reselects the newest row when a round start is corrected by a replica update', () => {
  const tracker = createLiveUpdates();
  sync(tracker, [row('a', 5), row('b', 3)]);
  assert.deepEqual(sync(tracker, [row('a', 1), row('b', 3)]), {latestId: 'b', arrivals: []});
  const next = row('c', 4);
  assert.deepEqual(sync(tracker, [row('a', 1), row('b', 3), next]), {latestId: 'c', arrivals: [next]});
});

test('clears a disconnected view and only resumes an explicitly matching account', () => {
  const tracker = createLiveUpdates();
  const first = row('first', 10);
  const next = row('next', 11);
  sync(tracker, [first]);
  assert.deepEqual(roundChanges(tracker.update({status: 'waiting', events: [first]})), {latestId: null, arrivals: []});
  assert.deepEqual(sync(tracker, [first, next]), {latestId: 'next', arrivals: [next]});
  assert.deepEqual(roundChanges(tracker.update({status: 'unavailable', accountKey: 'account-b', events: []})), {
    latestId: null, arrivals: [],
  });
  assert.deepEqual(sync(tracker, [row('from-new-account', 15)], 'account-b'), {
    latestId: 'from-new-account', arrivals: [],
  });
});

test('accounts that change during connected snapshots start a new baseline', () => {
  const tracker = createLiveUpdates();
  sync(tracker, [row('a', 20)]);
  assert.deepEqual(sync(tracker, [row('b', 30)], 'account-b'), {latestId: 'b', arrivals: []});
  const next = row('c', 31, 'new-bot');
  assert.deepEqual(sync(tracker, [row('b', 30), next], 'account-b'), {latestId: 'c', arrivals: [next]});
});

test('supports continuous anonymous snapshots while ignoring malformed rows', () => {
  const tracker = createLiveUpdates();
  const update = (events) => roundChanges(tracker.update({status: 'connected', events}));
  assert.deepEqual(update([null, {id: 'bad', at: 'invalid'}]), {latestId: null, arrivals: []});
  assert.deepEqual(update([row('known', 1)]), {latestId: 'known', arrivals: [row('known', 1)]});
  tracker.update({status: 'waiting', events: []});
  assert.deepEqual(update([row('later', 2)]), {latestId: 'later', arrivals: []});
});

test('pins running Bots above waiting and idle Bots without reshuffling idle peers', () => {
  const bots = ['idle-z', 'waiting', 'old', 'idle-a', 'new'].map((key) => ({key}));
  const events = [row('wait', 9, 'waiting'), row('old-work', 3, 'old'), row('new-work', 4, 'new')];
  const state = {status: 'connected', bots, events, activeRuns: events.slice(1), waitingRuns: events.slice(0, 1)};
  const live = liveBotActivity(state);
  assert.deepEqual(orderBotCards(bots, live.byBot).map(({key}) => key), ['new', 'old', 'waiting', 'idle-z', 'idle-a']);
  assert.equal(live.byRun.get('new-work').status, 'running');
  assert.equal(live.byRun.get('wait').status, 'waiting-reply');
  const idle = liveBotActivity({...state, activeRuns: [], waitingRuns: []});
  assert.deepEqual(orderBotCards(bots, idle.byBot), bots);
  assert.equal(idle.byRun.size, 0);
});

test('accepts activity only for a matched observed request and current roster Bot', () => {
  const events = [{...row('good', 4), handoffId: 'approved'}, row('wrong', 5, 'bot-b'), row('orphan', 6, 'old-bot')];
  const state = {status: 'connected', events, bots: [{key: 'bot-a'}, {key: 'bot-b'}],
    activeRuns: [events[0], {...events[1], agentKey: 'bot-a'}, events[2], row('unknown', 7), null],
    waitingRuns: [...events, {...events[0], at: at(10)}]};
  const live = liveBotActivity(state);
  assert.equal(live.byRun.get('good').status, 'running');
  assert.equal(live.byRun.get('good').handoffId, 'approved');
  assert.equal(live.byRun.get('good').agentKey, 'bot-a');
  assert.equal(live.byRun.get('wrong').status, 'waiting-reply');
  assert.equal(live.byRun.size, 2);
  const disconnected = liveBotActivity({...state, status: 'unavailable'});
  assert.equal(disconnected.byBot.size, 0);
  assert.equal(disconnected.byRun.size, 0);
});

test('keeps a round and Bot active through multiple real reply updates and returns to idle at the end', () => {
  const bot = {key: 'document-editor'};
  const event = row('round-editor', 3, bot.key);
  const base = {status: 'connected', bots: [bot], events: [event]};
  assert.equal(liveBotActivity({...base, waitingRuns: [event]}).byBot.get(bot.key)?.status, 'waiting-reply');
  for (const second of [10, 44, 50]) {
    const observed = {...event, lastReplyAt: at(second)};
    const snapshot = {...base, events: [observed], followupRuns: [{...event, at: observed.lastReplyAt}]};
    const activity = liveBotActivity(snapshot);
    assert.equal(activity.byBot.get(bot.key)?.status, 'waiting-followup');
    assert.equal(activity.byRun.get(event.id)?.status, 'waiting-followup');
    assert.equal(liveBotActivity({...snapshot, activeRuns: [event]}).byRun.get(event.id)?.status, 'running');
    assert.equal(orderBotCards([{key: 'idle'}, bot], activity.byBot)[0], bot);
  }
  assert.equal(liveBotActivity(base).byRun.size, 0);
});

test('keeps a replied round marked as unconfirmed without treating it as running', () => {
  const bots = [{key: 'editor'}, {key: 'worker'}, {key: 'quiet'}];
  const editorTurn = {...row('editor-turn', 1, 'editor'), lastReplyAt: at(30)};
  const workerTurn = row('worker-turn', 9, 'worker');
  const state = {status: 'connected', bots, events: [editorTurn, workerTurn], waitingRuns: [workerTurn],
    unconfirmedRuns: [{...editorTurn, at: at(30)}, {...workerTurn, at: at(30)}]};
  const live = liveBotActivity(state);
  assert.equal(live.byRun.get(editorTurn.id)?.status, 'completion-unconfirmed');
  assert.equal(live.byRun.get(workerTurn.id)?.status, 'waiting-reply');
  assert.deepEqual(orderBotCards(bots, live.byBot).map(({key}) => key), ['worker', 'editor', 'quiet']);
  assert.equal(liveBotActivity({...state, activeRuns: [editorTurn]}).byRun.get(editorTurn.id)?.status, 'running');
  assert.equal(liveBotActivity({...state, unconfirmedRuns: [{...editorTurn, at: at(31)}]}).byRun.has(editorTurn.id), false);
});

test('keeps one route through long silence and ends it after two connected official idle reads', () => {
  const tracker = createRunContinuity();
  const event = {...row('task', 1), trigger: 'person', lastReplyAt: at(11)};
  const snapshot = {status: 'connected', accountKey: 'account-a', events: [event], bots: [{key: 'bot-a'}]};
  const fresh = {...snapshot, unconfirmedRuns: [{...event, at: event.lastReplyAt, task: 'Search the docs'}]};
  const act = (state, input = snapshot) => tracker.update({...input, desktopActivity: state ? {access: 'ready', states: {'bot-a': state}} : {access: 'unavailable'}});
  assert.equal(act('working', fresh).byBot.get('bot-a')?.status, 'running');
  assert.equal(act('working').byRun.get(event.id)?.status, 'running');
  assert.equal(act(null).byRun.has(event.id), false);
  assert.equal(act('waiting').byRun.get(event.id)?.status, 'waiting-input');
  assert.equal(act('working').byRun.get(event.id)?.status, 'running');
  assert.equal(act('idle').byRun.has(event.id), true);
  assert.equal(act(null).byRun.has(event.id), false);
  assert.equal(act('idle').byRun.has(event.id), true);
  assert.equal(act('idle').byRun.has(event.id), false);
  assert.equal(act('idle', fresh).byRun.has(event.id), false);
  const unbound = act('working', fresh);
  assert.equal(unbound.byBot.get('bot-a')?.eventId, null);
  assert.equal(unbound.byRun.has(event.id), false);
  const next = {...row('next-task', 50), trigger: 'person'};
  const rebound = act('working', {...fresh, events: [event, next]});
  assert.equal(rebound.byBot.get('bot-a')?.eventId, next.id);
  assert.equal(rebound.byRun.has(event.id), false);
});

test('expires unsupported routes and lets you dismiss an unconfirmed record or switch accounts', () => {
  const tracker = createRunContinuity();
  const event = {...row('task', 1), trigger: 'person', lastReplyAt: at(11)};
  const snapshot = {status: 'connected', accountKey: 'account-a', events: [event], bots: [{key: 'bot-a'}]};
  const fresh = {...snapshot, followupRuns: [{...event, at: event.lastReplyAt}]};
  assert.equal(tracker.update(fresh).byRun.get(event.id)?.status, 'waiting-followup');
  assert.equal(tracker.update(snapshot).byRun.size, 0);
  assert.equal(tracker.update({...snapshot, unconfirmedRuns: [{...event, at: at(11)}]}).byRun.get(event.id)?.status, 'completion-unconfirmed');
  assert.equal(tracker.acknowledge(event.id), true);
  assert.equal(tracker.update(fresh).byRun.has(event.id), false);
  const otherEvent = {...event, id: 'other', at: at(20), lastReplyAt: at(21)};
  const other = {...snapshot, accountKey: 'account-b', events: [otherEvent], unconfirmedRuns: [{...otherEvent, at: at(21)}]};
  assert.equal(tracker.update(other).byRun.has(otherEvent.id), true);
  assert.equal(tracker.update(snapshot).byRun.size, 0);
});

test('continuous motion needs official working evidence, including when a cached stream still looks active', () => {
  const tracker = createRunContinuity();
  const event = {...row('current', 1), trigger: 'person', lastReplyAt: at(2)};
  const snapshot = {status: 'connected', accountKey: 'account-a', bots: [{key:'bot-a'}], events:[event], activeRuns:[event]};
  for (const access of ['permission', 'unavailable', 'ready']) {
    const state = tracker.update({...snapshot, desktopActivity: {access, states:{}}}).byBot.get('bot-a');
    assert.equal(showsRunMotion(state?.status), false);
  }
  for (const status of ['completion-unconfirmed', 'waiting-input', 'waiting-reply', 'waiting-followup', undefined]) {
    assert.equal(showsRunMotion(status), false);
  }
  assert.equal(showsRunMotion('running'), true);
});

test('settles an answered task when monitoring is enabled after the client is already idle', () => {
  const tracker = createRunContinuity();
  const event = {...row('task', 1), trigger: 'person', lastReplyAt: at(11)};
  const snapshot = {status: 'connected', accountKey: 'account-a', events: [event], bots: [{key: 'bot-a'}],
    unconfirmedRuns: [{...event, at: event.lastReplyAt}]};
  assert.equal(tracker.update(snapshot).byRun.has(event.id), true);
  const idle = {...snapshot, desktopActivity: {access: 'ready', states: {'bot-a': 'idle'}}};
  assert.equal(tracker.update(idle).byRun.has(event.id), true);
  assert.equal(tracker.update(idle).byRun.has(event.id), false);
  assert.equal(tracker.update(idle).byRun.has(event.id), false);
});

test('notices a roster-only addition and each newly observed reply in the same request', () => {
  const tracker = createLiveUpdates();
  const old = row('old-round', 2);
  const editor = {key: 'bot-editor', name: '文档主编'};
  const update = (second, events, added = true) => tracker.update({status: 'connected', accountKey: 'account-a',
    checkedAt: at(second), bots: [{key: 'bot-a'}, ...(added ? [editor] : [])], events});
  update(3, [old], false);
  const joined = update(4, [old]);
  assert.deepEqual(joined.newBots, [editor]);
  assert.equal(orderBotCards([{key: 'bot-a'}, editor], new Map(), joined.recentByBot)[0], editor);
  assert.deepEqual(update(5, [old]).newBots, []);
  const input = row('editor-round', 6, editor.key);
  assert.equal(update(7, [old, input]).arrivals[0].id, input.id);
  const first = {...input, lastReplyAt: at(8)};
  assert.deepEqual(update(9, [old, first]).replies, [first]);
  const second = {...input, lastReplyAt: at(11)};
  assert.deepEqual(update(12, [old, second]).replies, [second]);
  assert.deepEqual(update(13, [old, second]).replies, []);
  assert.deepEqual(update(14, [old, first]).replies, []);
  assert.deepEqual(update(15, [old, second]).replies, []);
});

test('official idle retires every stale stream for that bot and repeated snapshots cannot restart it', () => {
  const tracker = createRunContinuity();
  const a = {...row('a', 1), trigger: 'person'};
  const b = {...row('b', 2), trigger: 'person', lastReplyAt: at(8)};
  const snapshot = {status: 'connected', accountKey: 'account-a', bots: [{key: 'bot-a'}], events: [a,b], activeRuns: [a,b]};
  const check = state => tracker.update({...snapshot, desktopActivity: {access: 'ready', states: {'bot-a': state}}});
  assert.equal(check('working').byBot.get('bot-a').status, 'running');
  assert.equal(check('idle').byBot.get('bot-a').status, 'running');
  for (let i = 0; i < 3; i++) {
    const stopped = check('idle');
    assert.equal(stopped.byBot.size, 0);
    assert.equal(stopped.byRun.size, 0);
  }
  tracker.update({...snapshot, events: [], activeRuns: []});
  assert.equal(check('working').byBot.get('bot-a').eventId, null);
});

test('reconnecting to an idle client never resumes motion from before the outage', () => {
  const tracker = createRunContinuity();
  const event = {...row('run', 1), trigger: 'person'};
  const snapshot = {status:'connected', accountKey:'scope', events:[event], bots:[{key:'bot-a'}]};
  const apply = state => tracker.update({...snapshot, desktopActivity:{access:'ready', states:{'bot-a':state}}});
  assert.equal(apply('working').byRun.get(event.id).status, 'running');
  tracker.update({...snapshot,status:'unavailable'});
  assert.equal(showsRunMotion(apply('idle').byRun.get(event.id)?.status), false);
  assert.equal(apply('idle').byRun.size, 0);
});

test('orders a Bot already in the roster by its newest reply at startup without replaying history', () => {
  const tracker = createLiveUpdates();
  const bots = [{key: 'old-input'}, {key: 'last-input'}];
  const replied = {...row('existing', 9, bots[0].key), lastReplyAt: at(22)};
  const input = row('last', 18, bots[1].key);
  const update = (second, events, accountKey = 'account-a') => tracker.update({status: 'connected', accountKey,
    checkedAt: at(second), bots, events});
  const baseline = update(24, [replied, input]);
  assert.equal(baseline.latestId, replied.id);
  assert.deepEqual(baseline.replies, []);
  assert.equal(orderBotCards([...bots].reverse(), new Map(), baseline.recentByBot)[0], bots[0]);
  assert.deepEqual(update(65, [{...replied, lastReplyAt: at(25)}, input]).replies, []);
  assert.deepEqual(update(68, [{...replied, lastReplyAt: at(67)}, input], 'new-account').replies, []);
});

test('distinguishes refreshing the same cache from advancing events or official quota', () => {
  const event = {...row('editor-turn', 1), lastReplyAt: at(3)};
  const initial = {status: 'connected', accountKey: 'scope', checkedAt: at(5), latestEventAt: at(3),
    bots: [{key: 'bot-a', name: '文档主编'}], events: [event],
    weeklyQuota: {remainingPercent: 97.8, updatedAt: at(2), resetAt: at(500)}};
  const unchanged = {...initial, checkedAt: at(8), sourceUpdatedAt: at(8)};
  assert.deepEqual(refreshChanges(initial, unchanged), {events: false, quota: 'unchanged'});
  assert.deepEqual(refreshChanges(initial, {...unchanged, events: [{...event, lastReplyAt: at(7)}]}), {events: true, quota: 'unchanged'});
  assert.deepEqual(refreshChanges(initial, {...unchanged, events: [{...event, replyAt: at(2), latencyMs: 1000}]}), {events: true, quota: 'unchanged'});
  assert.deepEqual(refreshChanges(initial, {...unchanged, weeklyQuota: {...initial.weeklyQuota, updatedAt: at(7)}}), {events: false, quota: 'updated'});
  assert.deepEqual(refreshChanges(initial, {...unchanged, weeklyQuota: null}), {events: false, quota: 'unavailable'});
  assert.deepEqual(refreshChanges(initial, {...unchanged, weeklyQuota: {...initial.weeklyQuota, updatedAt: at(1)}}), {events: false, quota: 'unchanged'});
});
