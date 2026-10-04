import assert from 'node:assert/strict';
import test from 'node:test';
import { settingsFromEnv } from '../server/config.ts';
import { LiveSession } from '../server/session.ts';

async function harness(t) {
  const events = [];
  const sent = [];
  const gateway = {
    client: {},
    create: async () => ({
      session: { id: 'synthetic-session' },
      transport: { type: 'webrtc', sdp: 'v=0' },
    }),
    attach: async () => ({ send: (value) => sent.push(value), close() {} }),
    hangup: async () => {},
  };
  const session = new LiveSession('synthetic-owner', 'responses', settingsFromEnv({}), gateway);
  session.subscribe((value) => events.push(value));
  await session.start('v=0');
  t.after(() => session.receive({ type: 'session.closed', usage: { seconds: 1 } }));

  function begin(id) {
    session.receive({ type: 'session.delegation.created', delegation: { id, target: 'responses' } });
  }
  function finish(type, id, usage, responseId = `${id}-response`) {
    session.receive({
      type: 'response.event',
      delegation_id: id,
      event: { type, response: { id: responseId, usage } },
    });
  }
  return { session, events, sent, begin, finish };
}

for (const type of ['response.completed', 'response.failed', 'response.incomplete']) {
  test(`retains reported usage from ${type}`, async (t) => {
    const { session, events, sent, begin, finish } = await harness(t);
    begin('delegation');
    finish(type, 'delegation', { input_tokens: 11, output_tokens: 7 });
    const usage = events.filter((value) => value.type === 'usage').at(-1);
    assert.deepEqual(usage, { type: 'usage', seconds: 0, inputTokens: 11, outputTokens: 7 });
    const delegation = events.filter((value) => value.type === 'delegation').at(-1);
    assert.equal(delegation.status, type === 'response.completed' ? 'completed' : 'failed');
    assert.deepEqual(sent, []);
    session.receive({ type: 'session.closed', usage: { seconds: 2 } });
    assert.equal(events.at(-1).inputTokens, 11);
    assert.equal(events.at(-1).outputTokens, 7);
  });

  test(`counts duplicate ${type} events only once`, async (t) => {
    const { events, begin, finish } = await harness(t);
    begin('first');
    const usage = { input_tokens: 11, output_tokens: 7 };
    finish(type, 'first', usage);
    finish(type, 'first', usage);
    begin('second');
    finish('response.completed', 'second', { input_tokens: 3, output_tokens: 2 });
    assert.deepEqual(events.filter((value) => value.type === 'usage').at(-1), {
      type: 'usage',
      seconds: 0,
      inputTokens: 14,
      outputTokens: 9,
    });
  });
}

test('a failed response without usage leaves existing totals unchanged', async (t) => {
  const { events, begin, finish } = await harness(t);
  begin('first');
  finish('response.completed', 'first', { input_tokens: 11, output_tokens: 7 });
  begin('second');
  finish('response.failed', 'second', null);
  assert.deepEqual(events.filter((value) => value.type === 'usage').at(-1), {
    type: 'usage',
    seconds: 0,
    inputTokens: 11,
    outputTokens: 7,
  });
});
