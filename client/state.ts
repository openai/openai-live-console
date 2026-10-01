import type { ConsoleEvent, TranscriptGroup } from '../shared/types.ts';

export interface Activity {
  id: string;
  mode: 'responses' | 'client';
  status: 'running' | 'completed' | 'failed';
  detail: string;
  text: string;
  tools: Extract<ConsoleEvent, { type: 'tool' }>[];
}
export interface ViewState {
  transcript: TranscriptGroup[];
  activities: Activity[];
  seconds: number | null;
  inputTokens: number;
  outputTokens: number;
  final: boolean;
  reason: string;
  clipped: boolean;
  seen: string[];
}
export const emptyState = (): ViewState => ({
  transcript: [],
  activities: [],
  seconds: 0,
  inputTokens: 0,
  outputTokens: 0,
  final: false,
  reason: '',
  clipped: false,
  seen: [],
});
export function reduceEvent(state: ViewState, event: ConsoleEvent): ViewState {
  if (event.type === 'transcript') {
    if (state.seen.includes(event.id)) return state;
    const transcript = [...state.transcript];
    const last = transcript.at(-1);
    // Display grouping is a heuristic, not a server-defined conversation turn.
    if (last?.role === event.role && event.startMs - last.endMs < 1800 && event.startMs >= last.startMs)
      transcript[transcript.length - 1] = {
        ...last,
        text: last.text + event.text,
        endMs: Math.max(last.endMs, event.endMs),
      };
    else
      transcript.push({
        id: event.id,
        role: event.role,
        text: event.text,
        startMs: event.startMs,
        endMs: event.endMs,
      });
    let clipped = state.clipped;
    while (transcript.length > 100 || transcript.reduce((n, t) => n + t.text.length, 0) > 20000) {
      clipped = true;
      if (transcript.length === 1) {
        transcript[0] = { ...transcript[0], text: transcript[0].text.slice(-20000) };
        break;
      }
      transcript.shift();
    }
    return { ...state, transcript, clipped, seen: [...state.seen.slice(-2047), event.id] };
  }
  if (event.type === 'delegation') {
    const previous = state.activities.find((a) => a.id === event.id);
    const activity: Activity = {
      id: event.id,
      mode: event.mode,
      status: event.status,
      detail: event.detail,
      text: previous?.text || '',
      tools: previous?.tools || [],
    };
    return {
      ...state,
      activities: previous
        ? state.activities.map((a) => (a.id === event.id ? activity : a))
        : [...state.activities.slice(-15), activity],
    };
  }
  if (event.type === 'tool')
    return {
      ...state,
      activities: state.activities.map((a) =>
        a.id === event.delegationId
          ? { ...a, tools: [...a.tools.filter((t) => t.id !== event.id), event] }
          : a,
      ),
    };
  if (event.type === 'backend_text')
    return {
      ...state,
      activities: state.activities.map((a) => (a.id === event.id ? { ...a, text: event.text } : a)),
    };
  if (event.type === 'usage')
    return {
      ...state,
      seconds: event.seconds,
      inputTokens: event.inputTokens,
      outputTokens: event.outputTokens,
    };
  if (event.type === 'closed')
    return {
      ...state,
      seconds: event.seconds,
      inputTokens: Math.max(state.inputTokens, event.inputTokens),
      outputTokens: Math.max(state.outputTokens, event.outputTokens),
      final: event.finalized,
      reason: event.reason,
    };
  return state;
}
