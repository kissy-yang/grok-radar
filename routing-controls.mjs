import {routingExampleLabel, routingExamples} from './routing.mjs';
import {formatHandoff} from './event-store.mjs';
import {currentLanguage, tr} from './i18n.mjs';

const sourceLabels = {
  webhook: ['Webhook', 'Webhook'], deploy: ['发布通知', 'Releases'], github: ['GitHub', 'GitHub'],
  email: ['邮件', 'Email'], workbench: ['工作台', 'Workbench'],
};
const sourceLabel = source => Object.hasOwn(sourceLabels, source) ? tr(...sourceLabels[source]) : source;
const bindingRoles = ['TRIAGE', 'FIXER', 'REVIEWER', 'WRITER'];
const testableEventTypes = new Set(['deploy-failure', 'invoice-error', 'pr-opened', 'customer-email']);

function node(tag, className, value) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (value != null) element.textContent = value;
  return element;
}

function button(label, primary = false) {
  const element = node('button', primary ? 'button button-primary' : 'button', label);
  element.type = 'button';
  return element;
}

function field(label, control) {
  const element = node('label', 'routing-field');
  element.append(node('span', null, label), control);
  return element;
}

function dialog(id, title, description) {
  const element = node('dialog', 'routing-dialog');
  element.id = id;
  const header = node('div', 'dialog-heading');
  const copy = node('div');
  const heading = node('h2', null, title);
  heading.id = id + '-heading';
  element.setAttribute('aria-labelledby', heading.id);
  copy.append(heading, node('p', null, description));
  const close = button(tr('关闭', 'Close'));
  close.addEventListener('click', () => element.close());
  header.append(copy, close);
  const content = node('div', 'import-content');
  element.append(header, content);
  document.body.append(element);
  let anchor;
  element.addEventListener('close', () => {
    const replacement = anchor?.id ? document.getElementById(anchor.id) : null;
    (anchor?.isConnected ? anchor : replacement)?.focus();
    anchor = null;
  });
  return {
    element, content,
    open(trigger, initial = close) {
      if (element.open) return;
      anchor = trigger;
      element.showModal();
      initial.focus();
    },
  };
}

function errorField() {
  const error = node('p', 'routing-error');
  error.hidden = true;
  error.setAttribute('role', 'alert');
  return error;
}

function setError(error, message = '') {
  error.textContent = message;
  error.hidden = !message;
}

function botSelect(bots, emptyLabel, value = '', required = false) {
  const select = node('select');
  const placeholder = new Option(emptyLabel, '');
  placeholder.disabled = required;
  select.required = required;
  select.append(placeholder);
  for (const bot of bots) select.append(new Option(bot.name, bot.key));
  select.value = value;
  return select;
}

export function createRoutingControls({
  addEvent, getPending, getBots, dispatchEvent, rejectEvent, getBindings = () => ({}), saveBindings,
}) {
  let intake;
  let handoff;
  let bindings;
  let renderedLanguage;

  function updateLanguage() {
    const language = currentLanguage();
    if (language === renderedLanguage) return;
    renderedLanguage = language;
    // The language picker is outside the modal dialogs.
    for (const state of [intake, handoff, bindings]) state?.modal.element.remove();
    intake = handoff = bindings = undefined;
  }

  function createIntake() {
    const modal = dialog('routing-event-dialog', tr('加入事件', 'Add event'), tr('选择事件类型，工作台会判断是否需要交给专项 Bot。', 'Choose an event type to determine whether it needs a specialist bot.'));
    const form = node('form', 'routing-form');
    const kind = node('select');
    kind.id = 'routing-event-template';
    kind.required = true;
    const placeholder = new Option(tr('选择事件类型', 'Choose an event type'), '', true, true);
    placeholder.disabled = true;
    kind.append(placeholder);
    for (const source of Object.keys(sourceLabels)) {
      const group = node('optgroup');
      group.label = sourceLabel(source);
      for (const example of routingExamples.filter((item) => item.source === source)) {
        group.append(new Option(routingExampleLabel(example), example.id));
      }
      kind.append(group);
    }
    const title = node('input');
    title.id = 'routing-event-title';
    title.required = true;
    title.maxLength = 100;
    title.placeholder = tr('例如，订单服务生产部署失败', 'Example: Production deployment failed');
    const details = node('textarea');
    details.id = 'routing-event-details';
    details.maxLength = 450;
    details.rows = 5;
    details.placeholder = tr('可填写发生时间、受影响范围和已有证据。', 'Add the time, affected systems, or available evidence.');
    const testOption = node('div');
    const testOnly = node('input');
    testOnly.id = 'routing-event-test-only';
    testOnly.type = 'checkbox';
    const testLabel = node('label');
    testLabel.append(testOnly, tr(' 仅测试连通性', ' Connection test only'));
    const testNote = node('p', 'draft-meta', tr('交接时只请 Bot 回复 OK。', 'The handoff asks the bot to reply only with OK.'));
    testNote.id = 'routing-event-test-note';
    testOnly.setAttribute('aria-describedby', testNote.id);
    testOption.append(testLabel, testNote);
    function resetTestChoice() {
      testOnly.checked = false;
      testOnly.disabled = !testableEventTypes.has(kind.value);
      testOption.hidden = testOnly.disabled;
    }
    kind.addEventListener('change', resetTestChoice);
    const error = errorField();
    const submit = button(tr('记录并路由', 'Save and route'), true);
    submit.type = 'submit';
    form.append(field(tr('事件类型', 'Event type'), kind), field(tr('标题', 'Title'), title), field(tr('说明（可选）', 'Description (optional)'), details), testOption, error, submit);
    modal.content.append(form);
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      setError(error);
      submit.disabled = true;
      try {
        await addEvent(kind.value, {
          title: title.value,
          details: details.value,
          testReplyOnly: !testOnly.disabled && testOnly.checked,
        });
        modal.element.close();
      } catch (failure) {
        setError(error, failure.message);
      } finally {
        submit.disabled = false;
      }
    });
    return {modal, form, kind, error, resetTestChoice};
  }

  function refreshQueue() {
    if (!handoff?.modal.element.open || handoff.busy) return;
    const queue = handoff;
    const {list} = queue;
    const bots = getBots();
    const botNames = new Map(bots.map(({key, name}) => [key, name]));
    const roleBindings = getBindings();
    const pending = [...getPending()].sort((a, b) => b.at.localeCompare(a.at));
    const children = pending.map((event) => {
      const entry = node('article', 'draft-item');
      const title = node('h3', null, event.title);
      const meta = node('p', 'draft-meta', [event.agent, sourceLabel(event.source),
        ...(event.testReplyOnly ? [tr('仅回复 OK', 'Reply OK only')] : []),
      ].join(' · '));
      const boundKey = bindingRoles.includes(event.agent) ? roleBindings[event.agent] : '';
      const override = queue.choices.get(event.id);
      const preferredKey = override ?? boundKey;
      const initial = botNames.has(preferredKey) ? preferredKey : '';
      const unavailableNote = preferredKey && !initial
        ? override ? tr('本条改选的 Bot 已不在当前名册，请重新选择。', 'This event’s chosen bot is unavailable. Choose another bot.') : tr('已绑定的 Bot 已不在当前名册，请重新选择。', 'The default bot is unavailable. Choose another bot.')
        : '';
      const target = botSelect(bots, tr('选择实际接收的 Bot', 'Choose the receiving bot'), initial, true);
      const bindingNote = node('p', 'draft-meta routing-binding-note');
      const preview = node('details', 'draft-details');
      preview.append(node('summary', null, tr('预览会交给 Bot 的消息', 'Preview handoff message')), node('pre', 'draft-body', formatHandoff(event)));
      const actions = node('div', 'draft-actions');
      const reject = button(tr('驳回', 'Reject'));
      const send = button(tr('确认交给 Bot', 'Confirm handoff'), true);
      function updateTarget() {
        const selected = target.value;
        send.disabled = !selected || queue.busy;
        const targetNote = boundKey
          ? (selected === boundKey ? tr('角色绑定 · ', 'Role default · ') : tr('本条改选 · ', 'Event override · ')) + botNames.get(selected) : '';
        bindingNote.textContent = selected ? targetNote : unavailableNote;
        bindingNote.hidden = !bindingNote.textContent;
      }
      updateTarget();
      target.addEventListener('change', () => {
        queue.choices.set(event.id, target.value);
        updateTarget();
      });
      async function action(operation) {
        if (queue.busy) return;
        const revision = queue.revision;
        queue.busy = true;
        setError(queue.error);
        for (const control of list.querySelectorAll('button, select')) control.disabled = true;
        try {
          await operation();
        } catch (failure) {
          if (handoff === queue && queue.revision === revision) setError(queue.error, failure.message);
        } finally {
          if (handoff === queue && queue.revision === revision) {
            queue.busy = false;
            refreshQueue();
            if (queue.modal.element.open) queue.modal.content.querySelector('select, summary')?.focus();
          }
        }
      }
      send.addEventListener('click', () => {
        if (target.value) void action(() => dispatchEvent(event.id, target.value));
      });
      reject.addEventListener('click', () => void action(() => rejectEvent(event.id)));
      if (event.handoffError) entry.append(node('p', 'draft-meta', event.handoffError));
      actions.append(reject, send);
      entry.append(title, meta, field(tr('实际接收 Bot', 'Receiving bot'), target), bindingNote, preview, actions);
      return entry;
    });
    list.replaceChildren(...(children.length ? children : [node('p', 'draft-empty', tr('暂无待交接事件。', 'No events awaiting handoff.'))]));
  }

  function createBindings() {
    const modal = dialog('routing-bindings-dialog', tr('角色绑定', 'Role bindings'), tr('待交接事件会预选绑定的 Bot。每条事件仍可改选接收者。', 'Assign a default bot to each role. You can choose another bot for individual events.'));
    const form = node('form', 'routing-form');
    const fields = node('div', 'routing-form');
    const error = errorField();
    const submit = button(tr('保存角色绑定', 'Save role bindings'), true);
    submit.id = 'routing-bindings-save';
    submit.type = 'submit';
    form.append(fields, error, submit);
    modal.content.append(form);
    const state = {modal, fields, error, submit, revision: 0};
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (submit.disabled || !modal.element.open) return;
      setError(error);
      const selects = [...fields.querySelectorAll('select[data-role]')];
      const botKeys = new Set(getBots().map(({key}) => key));
      const selected = selects.filter((select) => select.value);
      if (selected.some((select) => !botKeys.has(select.value))) {
        setError(error, tr('Bot 名册已更新，请重新打开角色绑定。', 'The bot list changed. Close and reopen Role bindings.'));
        return;
      }
      const next = Object.fromEntries(selected.map((select) => [select.dataset.role, select.value]));
      const revision = state.revision;
      submit.disabled = true;
      for (const select of selects) select.disabled = true;
      try {
        await saveBindings(next);
        if (state.revision === revision && modal.element.open) modal.element.close();
      } catch (failure) {
        if (state.revision === revision && modal.element.open) setError(error, failure.message);
      } finally {
        if (state.revision === revision) {
          submit.disabled = false;
          for (const select of selects) select.disabled = false;
        }
      }
    });
    return state;
  }

  return {
    openEvent(trigger) {
      updateLanguage();
      intake ??= createIntake();
      if (intake.modal.element.open) return;
      intake.form.reset();
      intake.resetTestChoice();
      setError(intake.error);
      intake.modal.open(trigger, intake.kind);
    },
    openApproval(trigger) {
      updateLanguage();
      if (!handoff) {
        const modal = dialog('routing-approval-dialog', tr('待交接事件', 'Events awaiting handoff'),
          tr('请核对消息和目标。确认后会通过 Grok Bot 客户端交接，客户端可能立即提交。', 'Check the message and destination. Confirming opens the official Grok Bot app to prepare the handoff.'));
        const error = errorField();
        const list = node('div', 'draft-queue');
        modal.content.append(error, list);
        handoff = {modal, error, list, busy: false, revision: 0, choices: new Map()};
      }
      if (handoff.modal.element.open) return;
      handoff.choices.clear();
      setError(handoff.error);
      handoff.modal.open(trigger);
      refreshQueue();
    },
    openBindings(trigger) {
      updateLanguage();
      bindings ??= createBindings();
      if (bindings.modal.element.open) return;
      bindings.revision++;
      bindings.submit.disabled = false;
      setError(bindings.error);
      const bots = getBots();
      const botKeys = new Set(bots.map(({key}) => key));
      const current = getBindings();
      bindings.fields.replaceChildren(...bindingRoles.map((role) => {
        const key = current[role];
        const available = botKeys.has(key);
        const label = key && !available ? tr('原绑定的 Bot 已不在当前名册', 'Previous default bot is unavailable') : tr('未绑定', 'Unassigned');
        const select = botSelect(bots, label, available ? key : '');
        select.id = 'routing-binding-' + role;
        select.dataset.role = role;
        return field(role, select);
      }));
      bindings.modal.open(trigger, bindings.fields.querySelector('select'));
    },
    closeApprovals() {
      if (intake?.modal.element.open) intake.modal.element.close();
      if (handoff) {
        handoff.revision++;
        handoff.busy = false;
        handoff.choices.clear();
        if (handoff.modal.element.open) handoff.modal.element.close();
      }
      if (bindings) {
        bindings.revision++;
        if (bindings.modal.element.open) bindings.modal.element.close();
      }
    },
  };
}
