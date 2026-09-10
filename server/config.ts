export interface Settings {
  apiKey: string;
  backendModel: string;
  port: number;
  origin: string;
  maxSessionSeconds: number;
  closeTimeoutMs: number;
}
export function settingsFromEnv(env: NodeJS.ProcessEnv = process.env): Settings {
  const integer = (key: string, fallback: number, min: number, max: number) => {
    const raw = env[key];
    const value = raw ? Number(raw) : fallback;
    if (!Number.isInteger(value) || value < min || value > max)
      throw new Error(`${key} must be an integer from ${min} to ${max}.`);
    return value;
  };
  const port = integer('PORT', 3000, 1024, 65535);
  const backendModel = env.OPENAI_BACKEND_MODEL?.trim() || 'gpt-5.4-mini';
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(backendModel))
    throw new Error('OPENAI_BACKEND_MODEL must be a model ID.');
  if (env.HOST && env.HOST !== '127.0.0.1')
    throw new Error('This local sample only supports HOST=127.0.0.1.');
  return {
    apiKey: env.OPENAI_API_KEY?.trim() || '',
    backendModel,
    port,
    origin: `http://127.0.0.1:${port}`,
    maxSessionSeconds: integer('MAX_SESSION_SECONDS', 180, 30, 600),
    closeTimeoutMs: 20000,
  };
}
