import { randomUUID } from 'node:crypto';
import type { ResponseInput } from 'openai/resources/responses/responses';
import type { ConsoleEvent, Mode } from '../shared/types.ts';
import type { Settings } from './config.ts';
import type { Gateway, Sideband } from './openai.ts';
import { executeTool, toolDefinitions } from './catalog.ts';
import { publicError, SampleError } from './errors.ts';
import {
  BACKEND_INSTRUCTIONS,
  TranscriptLedger,
  boundFunctionOutputs,
  commentaryAppends,
  event,
  record,
  sessionConfiguration,
} from './protocol.ts';
import type { FunctionOutput, WireEvent } from './protocol.ts';

const MAX_DELEGATIONS = 8;
const MAX_TOOL_CALLS = 24;
const MAX_TOOL_ROUNDS = 3;
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const text = (value: unknown, max = 512) => (typeof value === 'string' ? value.slice(0, max) : '');
const number = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0;

export class LiveSession {
  readonly id = randomUUID();
  readonly owner: string;
  readonly mode: Mode;
  readonly startedAt = Date.now();
  readonly settings: Settings;
  readonly gateway: Gateway;
  private upstreamId = '';
  private creationRejected = false;
  private sideband?: Sideband;
  private sink?: (event: ConsoleEvent) => void;
  private history: ConsoleEvent[] = [];
  private ledger = new TranscriptLedger();
  private seenEvents = new Set<string>();
  private delegations = new Set<string>();
  private active = new Set<string>();
  private calls = new Set<string>();
  private responseIds = new Map<string, string>();
  private completedResponses = new Set<string>();
  private pending = new Map<string, FunctionOutput[]>();
  private rounds = new Map<string, number>();
  private jobs = new Set<Promise<void>>();
  private queue: Promise<void> = Promise.resolve();
  private abort = new AbortController();
  private starting = true;
  private closing = false;
  private terminal = false;
  private closeRequested = false;
  private seconds = 0;
  private inputTokens = 0;
  private outputTokens = 0;
  private lastHeartbeat = Date.now();
  private connected = false;
  private lifetime?: ReturnType<typeof setTimeout>;
  private heartbeat?: ReturnType<typeof setInterval>;
  private stopPromise?: Promise<Extract<ConsoleEvent, { type: 'closed' }>>;
  private resolveTerminal!: (event: Extract<ConsoleEvent, { type: 'closed' }>) => void;
  readonly done = new Promise<Extract<ConsoleEvent, { type: 'closed' }>>((resolve) => {
    this.resolveTerminal = resolve;
  });

  constructor(owner: string, mode: Mode, settings: Settings, gateway: Gateway) {
    this.owner = owner;
    this.mode = mode;
    this.settings = settings;
    this.gateway = gateway;
  }
  get rejectedBeforeCreation() {
    return this.creationRejected;
  }
  get isTerminal() {
    return this.terminal;
  }
  get isClosing() {
    return this.closing;
  }

  async start(sdp: string): Promise<string> {
    try {
      const created = await this.gateway.create(
        sessionConfiguration(this.mode, this.settings.backendModel),
        sdp,
      );
      this.upstreamId = created.session.id;
      if (this.closeRequested) {
        await this.gateway.hangup(this.upstreamId).catch(() => undefined);
        this.finish(false, 'Startup cancelled before a final event could be observed.');
        throw new SampleError(409, 'start_cancelled', 'Session startup was cancelled.');
      }
      this.sideband = await this.gateway.attach(
        this.upstreamId,
        (value) => this.receive(value),
        () => {
          if (!this.terminal) {
            this.emit(publicError(new Error('Sideband disconnected')));
            void this.stop('Backend connection lost');
          }
        },
      );
      if (this.terminal) {
        this.sideband.close();
        throw new SampleError(409, 'start_cancelled', 'Session ended during startup.');
      }
      if (this.closeRequested) {
        throw new SampleError(409, 'start_cancelled', 'Session startup was cancelled.');
      }
      this.lastHeartbeat = Date.now();
      this.emit({
        type: 'ready',
        mode: this.mode,
        startedAt: this.startedAt,
        maxSessionSeconds: this.settings.maxSessionSeconds,
      });
      this.lifetime = setTimeout(
        () => void this.stop('Session time limit reached'),
        this.settings.maxSessionSeconds * 1000,
      );
      this.heartbeat = setInterval(() => {
        if (Date.now() - this.lastHeartbeat > 15000)
          void this.stop(this.connected ? 'Browser connection lost' : 'Browser did not connect');
      }, 3000);
      return created.transport.sdp;
    } catch (error) {
      const status = record(error).status;
      this.creationRejected =
        !this.upstreamId && typeof status === 'number' && status >= 400 && status < 500 && status !== 408;
      if (this.creationRejected) {
        const code = record(error).code;
        const safeCode = typeof code === 'string' && /^[a-z_]{1,80}$/.test(code) ? code : 'unknown';
        console.warn(`Live session creation rejected (HTTP ${status}; ${safeCode}).`);
      }
      if (!this.terminal) {
        if (this.upstreamId) await this.gateway.hangup(this.upstreamId).catch(() => undefined);
        this.finish(false, 'Session setup did not complete. Final usage is unavailable.');
      }
      throw error;
    } finally {
      this.starting = false;
    }
  }

  subscribe(sink: (event: ConsoleEvent) => void) {
    if (this.sink)
      throw new SampleError(409, 'already_connected', 'This session already has a browser connection.');
    this.connected = true;
    this.lastHeartbeat = Date.now();
    this.sink = sink;
    for (const value of this.history) sink(value);
    return () => {
      if (this.sink === sink) {
        this.sink = undefined;
        if (!this.terminal) void this.stop('Browser connection closed');
      }
    };
  }
  beat() {
    this.lastHeartbeat = Date.now();
  }
  cancelStart() {
    this.closeRequested = true;
    if (this.sideband) void this.stop('Startup cancelled');
  }
  private emit(value: ConsoleEvent) {
    this.history.push(value);
    if (this.history.length > 256) this.history.shift();
    try {
      this.sink?.(value);
    } catch {
      this.sink = undefined;
    }
  }
  private send(value: WireEvent) {
    if (this.terminal || !this.sideband) throw new Error('No active sideband.');
    this.sideband.send(value);
  }
  private publishUsage() {
    this.emit({
      type: 'usage',
      seconds: this.seconds,
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
    });
  }

  // Only this trusted sideband executes tools. Primary data-channel events are
  // never forwarded back here by the browser. Reflected media is dropped first.
  receive(value: WireEvent) {
    if (
      this.terminal ||
      value.type === 'session.input_audio.append' ||
      value.type === 'session.output_audio.delta'
    )
      return;
    const id = text(value.event_id);
    if (id && this.seenEvents.has(id)) return;
    if (id) {
      this.seenEvents.add(id);
      if (this.seenEvents.size > 2048) this.seenEvents.delete(this.seenEvents.values().next().value!);
    }
    if (value.type === 'session.closed') {
      const usage = record(value.usage);
      if (typeof usage.seconds === 'number' && Number.isFinite(usage.seconds) && usage.seconds >= 0)
        this.seconds = usage.seconds;
      this.finish(
        typeof usage.seconds === 'number' && Number.isFinite(usage.seconds) && usage.seconds >= 0,
        text(value.reason) || 'Session closed',
      );
      return;
    }
    if (value.type === 'session.usage.updated') {
      this.seconds = Math.max(this.seconds, number(record(value.usage).seconds));
      this.publishUsage();
      return;
    }
    if (value.type === 'session.input_transcript.delta' || value.type === 'session.output_transcript.delta') {
      const role = value.type === 'session.input_transcript.delta' ? 'user' : 'assistant';
      const delta = text(value.delta, 4000),
        startMs = number(value.start_ms),
        endMs = number(value.end_ms);
      if (this.ledger.add(id || randomUUID(), role, delta, startMs))
        this.emit({ type: 'transcript', id: id || randomUUID(), role, text: delta, startMs, endMs });
      return;
    }
    if (value.type === 'error') {
      const e = record(value.error);
      this.emit(publicError(e));
      if (
        [
          'session_finalization_failed',
          'response_input_buffer_full',
          'function_call_outputs_required',
        ].includes(text(e.code))
      )
        void this.stop('Protocol finalization failed');
      return;
    }
    if (value.type === 'session.delegation.created') {
      const d = record(value.delegation),
        delegationId = text(d.id);
      if (!delegationId || d.target !== this.mode || this.delegations.has(delegationId)) return;
      if (this.closing || this.delegations.size >= MAX_DELEGATIONS) {
        void this.stop('Delegation limit reached');
        return;
      }
      this.delegations.add(delegationId);
      this.active.add(delegationId);
      if (typeof d.response_id === 'string') this.responseIds.set(d.response_id, delegationId);
      this.emit({
        type: 'delegation',
        id: delegationId,
        status: 'running',
        mode: this.mode,
        detail:
          this.mode === 'responses'
            ? 'Live handed work to Responses.'
            : 'Your server is building context from the conversation.',
      });
      if (this.mode === 'client') {
        // Capture the transcript at the handoff boundary. No task text is carried
        // in the delegation event. Serialize jobs but retain conversation context.
        const context = this.ledger.context();
        const job = this.queue.then(() => this.runBackend(delegationId, context));
        this.queue = job.catch(() => undefined);
        this.jobs.add(job);
        void job.finally(() => this.jobs.delete(job)).catch(() => undefined);
      }
      return;
    }
    if (value.type === 'response.event' && this.mode === 'responses') this.receiveResponse(value);
  }

  private tool(delegationId: string, callId: string, name: string, args: string): FunctionOutput | undefined {
    if (!callId || this.calls.has(callId)) return;
    this.calls.add(callId);
    let result: unknown,
      argumentsValue: unknown = {};
    try {
      if (this.calls.size > MAX_TOOL_CALLS) throw new Error('Tool-call limit reached.');
      const executed = executeTool(name, args);
      result = executed.result;
      argumentsValue = executed.arguments;
      this.emit({
        type: 'tool',
        id: callId,
        delegationId,
        name,
        arguments: argumentsValue,
        result,
        status: 'completed',
      });
    } catch {
      result = { error: 'Tool request was rejected by the sample permission or argument limits.' };
      this.emit({
        type: 'tool',
        id: callId,
        delegationId,
        name: name.slice(0, 80),
        arguments: {},
        result,
        status: 'failed',
      });
    }
    return { type: 'function_call_output', call_id: callId, output: JSON.stringify(result) };
  }

  private receiveResponse(envelope: WireEvent) {
    const inner = record(envelope.event),
      response = record(inner.response);
    const responseId = text(response.id) || text(inner.response_id);
    const delegationId = text(envelope.delegation_id) || this.responseIds.get(responseId) || '';
    if (!delegationId || !this.delegations.has(delegationId)) {
      if (inner.type === 'response.output_item.done' && record(inner.item).type === 'function_call') {
        this.emit(publicError(new Error('Uncorrelated tool call')));
        void this.stop('Cannot correlate backend tool work');
      }
      return;
    }
    if (responseId) this.responseIds.set(responseId, delegationId);
    if (inner.type === 'response.output_item.done') {
      const item = record(inner.item);
      if (item.type === 'function_call') {
        const output = this.tool(
          delegationId,
          text(item.call_id),
          text(item.name),
          text(item.arguments, 4096),
        );
        if (output) this.pending.set(delegationId, [...(this.pending.get(delegationId) || []), output]);
      }
    }
    if (inner.type === 'response.output_text.done')
      this.emit({ type: 'backend_text', id: delegationId, text: text(inner.text, 2400) });
    if (inner.type === 'response.completed') {
      if (responseId && this.completedResponses.has(responseId)) return;
      if (responseId) this.completedResponses.add(responseId);
      const usage = record(response.usage);
      this.inputTokens += number(usage.input_tokens);
      this.outputTokens += number(usage.output_tokens);
      this.publishUsage();
      const outputs = this.pending.get(delegationId) || [];
      this.pending.delete(delegationId);
      if (outputs.length) {
        const round = (this.rounds.get(delegationId) || 0) + 1;
        this.rounds.set(delegationId, round);
        if (round > MAX_TOOL_ROUNDS) {
          this.failed(delegationId);
          void this.stop('Tool-round limit reached');
          return;
        }
        try {
          for (const item of boundFunctionOutputs(outputs))
            this.send(event('response.item.create', { item }));
          // The whole function-output batch must precede the one continuation.
          this.send(event('response.create'));
        } catch {
          this.failed(delegationId);
          void this.stop('Tool continuation failed');
        }
      } else this.completed(delegationId);
    }
    if (['response.failed', 'response.incomplete', 'response.error'].includes(text(inner.type))) {
      this.failed(delegationId);
      this.emit(publicError(new Error('Backend failed')));
    }
  }

  private async runBackend(delegationId: string, context: string) {
    try {
      if (this.abort.signal.aborted || this.terminal) return;
      const input: ResponseInput = [
        {
          role: 'user',
          content: `The voice conversation so far follows. Address the user's latest unresolved request.\n\n${context}`,
        },
      ];
      for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
        const response = await this.gateway.client.responses.create(
          {
            model: this.settings.backendModel,
            instructions: BACKEND_INSTRUCTIONS,
            input,
            tools: toolDefinitions,
            tool_choice: 'auto',
            parallel_tool_calls: false,
            max_output_tokens: 512,
            store: false,
            include: ['reasoning.encrypted_content'],
          },
          { signal: this.abort.signal, timeout: 25000, maxRetries: 0 },
        );
        if (this.terminal) return;
        this.inputTokens += response.usage?.input_tokens || 0;
        this.outputTokens += response.usage?.output_tokens || 0;
        this.publishUsage();
        if (response.status !== 'completed') throw new Error('Backend response incomplete.');
        const calls = response.output.filter((item) => item.type === 'function_call');
        if (!calls.length) {
          const result = response.output_text.slice(0, 1200);
          if (!result.trim()) throw new Error('Empty backend answer.');
          this.emit({ type: 'backend_text', id: delegationId, text: result });
          for (const append of commentaryAppends(delegationId, result)) this.send(append);
          this.completed(delegationId);
          return;
        }
        if (round === MAX_TOOL_ROUNDS) throw new Error('Tool-round limit reached.');
        for (const item of response.output) {
          if (item.type === 'function_call' || item.type === 'reasoning' || item.type === 'message')
            input.push(item);
          else throw new Error('Unexpected backend output type.');
        }
        const outputs = calls
          .map((call) => this.tool(delegationId, call.call_id, call.name, call.arguments))
          .filter((item): item is FunctionOutput => Boolean(item));
        if (outputs.length !== calls.length) throw new Error('Duplicate backend tool call.');
        input.push(...boundFunctionOutputs(outputs));
      }
    } catch (error) {
      if (!this.terminal && !this.closing) {
        this.emit(publicError(error));
        try {
          for (const append of commentaryAppends(
            delegationId,
            'The catalog lookup could not be completed. Please try again or end this session.',
          ))
            this.send(append);
        } catch {
          /* stop owns final cleanup */
        }
      }
      this.failed(delegationId);
    }
  }
  private completed(id: string) {
    this.active.delete(id);
    this.emit({
      type: 'delegation',
      id,
      mode: this.mode,
      status: 'completed',
      detail: 'Backend work completed; Live can explain the result.',
    });
  }
  private failed(id: string) {
    this.active.delete(id);
    if (!this.terminal)
      this.emit({
        type: 'delegation',
        id,
        mode: this.mode,
        status: 'failed',
        detail: 'Backend work did not complete.',
      });
  }

  stop(reason = 'Stop requested') {
    this.closeRequested = true;
    if (this.terminal || this.starting) return this.done;
    if (this.stopPromise) return this.stopPromise;
    this.stopPromise = this.close(reason);
    return this.stopPromise;
  }
  private async close(reason: string) {
    this.closing = true;
    this.emit({ type: 'closing', reason });
    const drainUntil = Date.now() + 8000;
    while (this.active.size && !this.terminal && Date.now() < drainUntil) await delay(50);
    this.abort.abort();
    if (this.terminal) return this.done;
    try {
      this.send(event('session.close'));
    } catch {
      /* hangup is the bounded fallback */
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const completed = await Promise.race([
      this.done,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), this.settings.closeTimeoutMs);
      }),
    ]);
    clearTimeout(timer);
    if (completed) return completed;
    if (this.upstreamId) await this.gateway.hangup(this.upstreamId).catch(() => undefined);
    this.finish(false, `${reason}. No final session.closed event was received; usage is incomplete.`);
    return this.done;
  }
  private finish(finalized: boolean, reason: string) {
    if (this.terminal) return;
    this.terminal = true;
    this.abort.abort();
    clearTimeout(this.lifetime);
    clearInterval(this.heartbeat);
    const value: Extract<ConsoleEvent, { type: 'closed' }> = {
      type: 'closed',
      finalized,
      reason,
      seconds: finalized ? this.seconds : null,
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
    };
    this.emit(value);
    this.resolveTerminal(value);
    this.sideband?.close();
    this.active.clear();
    this.pending.clear();
  }
}
