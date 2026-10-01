import assert from 'node:assert/strict';
import test from 'node:test';
import { emptyState, reduceEvent } from './state.ts';
import type { ConsoleEvent } from '../shared/types.ts';

function transcript(id: number, text: string, role: 'user' | 'assistant' = 'assistant'): ConsoleEvent {
  return { type: 'transcript', id: String(id), role, text, startMs: id * 100, endMs: (id + 1) * 100 };
}

test('keeps the latest text when a continuous transcript exceeds the limit', () => {
  let state = emptyState();
  for (let i = 0; i < 21; i++) state = reduceEvent(state, transcript(i, String(i % 10).repeat(1000)));
  assert.equal(state.transcript.length, 1);
  assert.equal(state.transcript[0].text.length, 20000);
  assert.ok(state.transcript[0].text.endsWith('0'.repeat(1000)));
  assert.equal(state.clipped, true);
  state = reduceEvent(state, transcript(21, 'latest'));
  assert.equal(state.transcript[0].text.length, 20000);
  assert.ok(state.transcript[0].text.endsWith('latest'));
});

test('bounds a single oversized event without dropping it', () => {
  const state = reduceEvent(emptyState(), transcript(0, 'x'.repeat(20001) + 'last'));
  assert.equal(state.transcript.length, 1);
  assert.equal(state.transcript[0].text.length, 20000);
  assert.ok(state.transcript[0].text.endsWith('last'));
  assert.equal(state.clipped, true);
});

test('continues evicting oldest groups when the group limit is reached', () => {
  let state = emptyState();
  for (let i = 0; i < 101; i++)
    state = reduceEvent(state, transcript(i, 'text', i % 2 ? 'user' : 'assistant'));
  assert.equal(state.transcript.length, 100);
  assert.equal(state.transcript[0].id, '1');
  assert.equal(state.transcript.at(-1)?.id, '100');
  assert.equal(state.clipped, true);
});
