import {tr} from './i18n.mjs';

export const connectionCheckInstruction = '请只回复 OK，不使用工具，不执行任何其他操作。';

const rules = [
  {
    id: 'connection-check', source: 'workbench', label: '连通性测试', labelEn: 'Connection test', agent: 'TEST',
    detail: '发出最小连通性请求，核对 Bot 回复与事件回执。',
    detailEn: 'Send a minimal request and check the bot reply and event receipt.',
    draftTitle: '连通性测试请求',
    draftBody: connectionCheckInstruction,
  },
  {
    id: 'webhook-ping', source: 'webhook', label: 'Webhook 心跳', labelEn: 'Webhook heartbeat', agent: null,
    detail: '例行心跳，状态没有变化。',
    detailEn: 'Routine heartbeat. Status is unchanged.',
  },
  {
    id: 'invoice-error', source: 'webhook', label: '发票回调失败', labelEn: 'Invoice callback failure', agent: 'FIXER',
    detail: '发票回调失败，需要检查重试处理。',
    detailEn: 'The invoice callback failed. Check retry handling.',
    draftTitle: '发票重试修复提案',
    draftBody: '复核失败样本和幂等键。拟在测试分支补充退避和重试覆盖，并用重复回调验证账目只记录一次。',
  },
  {
    id: 'deploy-success', source: 'deploy', label: '部署成功', labelEn: 'Deployment succeeded', agent: null,
    detail: '发布已成功，无需跟进。',
    detailEn: 'The release succeeded and needs no follow-up.',
  },
  {
    id: 'deploy-failure', source: 'deploy', label: '部署失败', labelEn: 'Deployment failed', agent: 'TRIAGE',
    detail: '发布报告失败，需要归类并定位失败步骤。',
    detailEn: 'The release failed. Identify the failing step and classify the issue.',
    draftTitle: '部署失败分诊记录',
    draftBody: '标记发布失败，检查失败阶段、首条报错和影响范围。待负责人核对后决定是否需要重新发布。',
  },
  {
    id: 'pr-label', source: 'github', label: 'PR 标签更新', labelEn: 'PR labels updated', agent: null,
    detail: '只有 PR 标签变动，无需重新审阅。',
    detailEn: 'Only the pull request labels changed. No new review is needed.',
  },
  {
    id: 'pr-opened', source: 'github', label: '新 PR', labelEn: 'New pull request', agent: 'REVIEWER',
    detail: '发现新 PR，需要审阅改动和测试覆盖。',
    detailEn: 'Review changes and test coverage for the new pull request.',
    draftTitle: 'PR 审阅评论草稿',
    draftBody: '请核对受影响的入口、异常处理和回归覆盖。建议补充验证关键路径的测试结果，再由作者确认。',
  },
  {
    id: 'newsletter', source: 'email', label: '订阅邮件', labelEn: 'Newsletter', agent: null,
    detail: '订阅资讯，无需回复。',
    detailEn: 'No reply is needed.',
  },
  {
    id: 'customer-email', source: 'email', label: '客户邮件', labelEn: 'Customer email', agent: 'WRITER',
    detail: '客户来信需要回复，交由撰写人准备草稿。',
    detailEn: 'The customer email needs a response draft.',
    draftTitle: '客户邮件回复草稿',
    draftBody: '您好，已收到您的邮件。我们会先核对您反馈的情况，并尽快给出下一步安排。感谢您的耐心。',
  },
];

export const routingExamples = Object.freeze(rules.map(({id, source, label}) => Object.freeze({id, source, label})));
export const routingRates = Object.freeze({router: 0.002, agent: 0.05});

const ruleById = new Map(rules.map((rule) => [rule.id, rule]));

export function routingExampleLabel({id, label}) {
  return tr(label, ruleById.get(id)?.labelEn ?? label);
}

export function routingEventDetail({exampleId, detail}) {
  const rule = ruleById.get(exampleId);
  return rule && detail === rule.detail ? tr(detail, rule.detailEn) : detail;
}

const dispatchedCost = Number((routingRates.router + routingRates.agent).toFixed(3));

function eventTime(at) {
  if (typeof at !== 'string' && typeof at !== 'number' && !(at instanceof Date)) {
    throw new TypeError(tr("事件时间必须是有效日期。", "Enter a valid event date."));
  }
  const time = new Date(at);
  if (!Number.isFinite(time.valueOf())) throw new TypeError(tr("事件时间必须是有效日期。", "Enter a valid event date."));
  return time.toISOString();
}

function eventTitle(title, fallback) {
  if (title === undefined) return fallback;
  if (typeof title !== 'string' || !title.trim() || title.trim().length > 180) {
    throw new TypeError(tr("事件标题需要 1 至 180 个字符。", "Enter an event title of 1 to 180 characters."));
  }
  return title.trim();
}

export function createRoutingWorkspace() {
  const events = new Map();
  let sequence = 0;

  function add(exampleId, {title, at = Date.now()} = {}) {
    const rule = ruleById.get(exampleId);
    if (!rule) throw new TypeError(tr("请选择已知的事件类型。", "Choose a supported event type."));
    const timestamp = eventTime(at);
    const label = eventTitle(title, rule.label);
    const id = `routing-${++sequence}`;
    const dispatched = rule.agent !== null;
    const isConnectionCheck = rule.id === 'connection-check';
    // These prices are rehearsal estimates. Real model usage remains unknown.
    const event = Object.freeze({
      id, at: timestamp, title: label, source: rule.source,
      route: dispatched ? 'dispatched' : 'ignored',
      agent: rule.agent,
      status: dispatched ? 'draft' : 'ignored',
      actualUsd: isConnectionCheck ? null : dispatched ? dispatchedCost : routingRates.router,
      baselineUsd: isConnectionCheck ? null : routingRates.agent,
      detail: rule.detail,
      model: null, latencyMs: null,
      inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null,
      requestId: null, turnId: null,
      ...(dispatched ? {
        draftTitle: rule.draftTitle,
        draftBody: rule.draftBody,
        approval: 'pending',
      } : {}),
    });
    events.set(id, event);
    return event;
  }

  function resolve(id, decision) {
    if (decision !== 'approve' && decision !== 'reject') {
      throw new TypeError(tr("请选择批准或驳回。", "Choose Approve or Reject."));
    }
    const event = events.get(id);
    if (!event?.approval) throw new TypeError(tr("该事件没有可审批的本地草稿。", "This event has no draft to review."));
    const approval = decision === 'approve' ? 'approved' : 'rejected';
    if (event.approval === approval) return event;
    if (event.approval !== 'pending') throw new Error(tr("该草稿已作出决定。", "This draft has already been reviewed."));
    const updated = Object.freeze({
      ...event,
      status: decision === 'approve' ? 'done' : 'rejected',
      approval,
    });
    events.set(id, updated);
    return updated;
  }

  return {add, resolve, snapshot: () => [...events.values()]};
}
