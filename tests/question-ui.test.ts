import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nativeQuestion, questionPageSize } from '../packages/adapters/src/question-ui.ts';
import type { QuestionChoice } from '../packages/adapters/src/question-ui.ts';

const choices: QuestionChoice[] = Array.from({ length: 8 }, (_, index) => ({ choiceId: 'choice-' + index, client: 'codex', title: 'Same title repeated', modified: '2026-11-14T10:00:00Z' }));
test('Antigravity native question preserves one-to-one selection even when titles repeat', () => {
  const ui = nativeQuestion('antigravity', '/project', choices, 0, 1);
  assert.equal(ui.tool, 'ask_question');
  const question = (ui.arguments.questions as { is_multi_select: boolean; options: string[] }[])[0];
  assert.equal(question.is_multi_select, false);
  assert.equal(new Set(question.options).size, 8);
  for (const [index, label] of question.options.entries()) assert.equal(ui.choiceMap[label], 'choice-' + index);
});
test('Claude native question respects its option limit with navigation, short labels and single-choice cancellation', () => {
  const size = questionPageSize('claude');
  const ui = nativeQuestion('claude', '/project', choices.slice(0, size), 0, 3);
  const question = (ui.arguments.questions as { options: { label: string }[] }[])[0];
  assert.equal(ui.tool, 'AskUserQuestion');
  assert.equal(question.options.length, 4);
  assert.ok(question.options.every(option => option.label.length <= 32));
  assert.equal(ui.navigation?.page, 1);
  assert.equal(ui.choiceMap[ui.navigation!.label], undefined, 'Navigation must not import a conversation');
  const only = nativeQuestion('claude', '/project', choices.slice(0, 1), 0, 1);
  assert.equal((only.arguments.questions as { options: unknown[] }[])[0].options.length, 2);
  assert.ok(only.cancelLabel);
  assert.equal(only.choiceMap[only.cancelLabel!], undefined);
});
test('Codex native question stays within three options while providing source choice mapping', () => {
  const ui = nativeQuestion('codex', '/project', choices.slice(0, questionPageSize('codex')), 0, 4);
  assert.equal(ui.tool, 'request_user_input_async');
  assert.equal((ui.arguments.questions as { options: string[] }[])[0].options.length, 3);
  assert.equal(Object.values(ui.choiceMap).length, 2);
});
