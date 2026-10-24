import test from 'node:test';
import assert from 'node:assert/strict';
import { TranscriptLedger } from '../server/protocol.ts';

test('TranscriptLedger retains most recent text when a fragment exceeds character limit', () => {
  const ledger = new TranscriptLedger();
  const added = ledger.add('evt-1', 'user', 'x'.repeat(13000), 1000);
  assert.equal(added, true);

  const context = ledger.context();
  assert.ok(context.length > 0, 'context should not be empty');
  assert.ok(context.includes('[1.0s] user: '), 'context should format speaker and time');
  // Formatted prefix is "[1.0s] user: " (13 chars) + 12000 retained text = 12013
  assert.equal(context.length, 13 + 12000);
});

test('TranscriptLedger trims oldest text when new large fragment pushes total beyond limit', () => {
  const ledger = new TranscriptLedger();
  ledger.add('evt-1', 'user', 'x'.repeat(1000), 1000);
  ledger.add('evt-2', 'assistant', 'y'.repeat(12500), 2000);

  const context = ledger.context();
  assert.ok(context.length > 0, 'context should retain recent text');
  assert.ok(!context.includes('user: x'), 'older fragment should be evicted');
  assert.ok(context.includes('assistant: '), 'newer fragment should be retained');
  assert.equal(context.length, 18 + 12000); // "[2.0s] assistant: " (18 chars) + 12000
});

test('TranscriptLedger deduplicates seen IDs and preserves seen filter across evictions', () => {
  const ledger = new TranscriptLedger();
  assert.equal(ledger.add('evt-1', 'user', 'hello', 1000), true);
  assert.equal(ledger.add('evt-1', 'user', 'duplicate hello', 1000), false);

  // Add enough small fragments to evict evt-1 from the fragment list
  for (let i = 2; i <= 260; i++) {
    ledger.add(`evt-${i}`, 'user', `msg-${i}`, 1000 + i);
  }

  // evt-1 should still be rejected as duplicate because seen set retains history
  assert.equal(ledger.add('evt-1', 'user', 'replayed duplicate', 1000), false);
});
