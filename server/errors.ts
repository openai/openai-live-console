import type { ConsoleEvent } from '../shared/types.ts';
import { record } from './protocol.ts';

export class SampleError extends Error {
  status: number;
  code: string;
  action: string;
  constructor(status: number, code: string, message: string, action = 'Review the settings and try again.') {
    super(message);
    this.status = status;
    this.code = code;
    this.action = action;
  }
}
export function publicError(error: unknown): Extract<ConsoleEvent, { type: 'error' }> {
  if (error instanceof SampleError)
    return { type: 'error', code: error.code, message: error.message, action: error.action };
  const e = record(error);
  const status = typeof e.status === 'number' ? e.status : 0;
  const code = typeof e.code === 'string' ? e.code : '';
  if (status === 401)
    return {
      type: 'error',
      code: 'authentication_failed',
      message: 'OpenAI rejected the server API key.',
      action: 'Check OPENAI_API_KEY on the server, then restart it.',
    };
  if (code === 'live_api_access_denied')
    return {
      type: 'error',
      code,
      message: 'This project does not have access to Live.',
      action: 'Use an API key from a project with Live access.',
    };
  if (
    status === 403 ||
    status === 404 ||
    ['live_api_access_denied', 'invalid_model', 'model_not_found'].includes(code)
  )
    return {
      type: 'error',
      code: 'access_unavailable',
      message: 'This project cannot access the requested model or service.',
      action: 'Check the API key’s project and model permissions.',
    };
  if (status === 429 && code === 'insufficient_quota')
    return {
      type: 'error',
      code: 'quota_exhausted',
      message: 'The API project has exhausted its available quota.',
      action:
        'Check API billing and project spend limits before trying again. ChatGPT subscriptions do not provide API credits.',
    };
  if (status === 429)
    return {
      type: 'error',
      code: 'rate_or_quota_limit',
      message: 'OpenAI reported a rate or quota limit.',
      action: 'Check project limits before trying again.',
    };
  if (status === 400 || status === 422)
    return {
      type: 'error',
      code: 'contract_rejected',
      message: 'OpenAI rejected the session or backend configuration.',
      action: 'Check the session configuration and model access for your API project.',
    };
  return {
    type: 'error',
    code: 'upstream_failed',
    message: 'The connection or backend request did not complete.',
    action: 'Check your network and proxy settings, then try again.',
  };
}
