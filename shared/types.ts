export type Mode = 'responses' | 'client';
export type Phase = 'idle' | 'connecting' | 'live' | 'closing' | 'closed' | 'incomplete' | 'error';
export type ActivityStatus = 'running' | 'completed' | 'failed';

export interface ConsoleConfig {
  csrf: string;
  configured: boolean;
  model: string;
  backendModel: string;
  maxSessionSeconds: number;
}

export type ConsoleEvent =
  | { type: 'ready'; mode: Mode; startedAt: number; maxSessionSeconds: number }
  | {
      type: 'transcript';
      id: string;
      role: 'user' | 'assistant';
      text: string;
      startMs: number;
      endMs: number;
    }
  | { type: 'delegation'; id: string; status: ActivityStatus; mode: Mode; detail: string }
  | {
      type: 'tool';
      id: string;
      delegationId: string;
      name: string;
      arguments: unknown;
      result: unknown;
      status: ActivityStatus;
    }
  | { type: 'backend_text'; id: string; text: string }
  | { type: 'usage'; seconds: number; inputTokens: number; outputTokens: number }
  | { type: 'closing'; reason: string }
  | {
      type: 'closed';
      finalized: boolean;
      reason: string;
      seconds: number | null;
      inputTokens: number;
      outputTokens: number;
    }
  | { type: 'error'; code: string; message: string; action: string };

export interface TranscriptGroup {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  startMs: number;
  endMs: number;
}
