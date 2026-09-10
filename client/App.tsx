import { useEffect, useReducer, useRef, useState } from 'react';
import type { ConsoleConfig, ConsoleEvent, Mode, Phase } from '../shared/types.ts';
import { BrowserSession } from './session.ts';
import { emptyState, reduceEvent } from './state.ts';
import type { ViewState } from './state.ts';

const modeNames: Record<Mode, string> = { responses: 'Managed by Live', client: 'Managed by app' };
const phaseLabels: Record<Phase, string> = {
  idle: '',
  connecting: 'Connecting…',
  live: 'Listening…',
  closing: 'Ending session…',
  closed: 'Ended',
  incomplete: '',
  error: '',
};
function clock(seconds: number) {
  return `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
}
function limitLabel(seconds: number) {
  return seconds % 60 === 0 ? `${seconds / 60}-minute session limit` : `${seconds}-second session limit`;
}
const object = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
type Notice = { message: string; action?: string; code?: string };

export function App() {
  const [config, setConfig] = useState<ConsoleConfig>();
  const [phase, setPhase] = useState<Phase>('idle');
  const [mode, setMode] = useState<Mode>('responses');
  const [view, dispatch] = useReducer(
    (state: ViewState, action: ConsoleEvent | { type: 'reset' }) =>
      action.type === 'reset' ? emptyState() : reduceEvent(state, action),
    undefined,
    emptyState,
  );
  const [error, setError] = useState<Notice>();
  const [muted, setMuted] = useState(false);
  const [speakerMuted, setSpeakerMuted] = useState(false);
  const [volume, setVolume] = useState(80);
  const [level, setLevel] = useState(0);
  const [blocked, setBlocked] = useState(false);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [inputDevice, setInputDevice] = useState('');
  const [outputDevice, setOutputDevice] = useState('');
  const [startedAt, setStartedAt] = useState<number>();
  const [now, setNow] = useState(Date.now());
  const [newText, setNewText] = useState(false);
  const [copied, setCopied] = useState(false);
  const audio = useRef<HTMLAudioElement>(null);
  const session = useRef<BrowserSession | undefined>(undefined);
  const transcript = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const audioSettings = useRef<HTMLDialogElement>(null);
  const details = useRef<HTMLDialogElement>(null);
  const active = ['connecting', 'live', 'closing'].includes(phase);
  const elapsed = startedAt ? Math.max(0, (now - startedAt) / 1000) : 0;
  const running = view.activities.filter((a) => a.status === 'running').length;
  const hasTranscript = view.transcript.length > 0;
  const hasUsage = Boolean(
    view.seconds || view.inputTokens || view.outputTokens || view.final || phase === 'incomplete',
  );
  const notice: Notice | undefined =
    phase === 'incomplete'
      ? {
          message: 'We couldn’t confirm the session ended. Final usage is unavailable.',
          action: 'Check API usage before starting another conversation.',
          code: error?.code,
        }
      : config && !config.configured
        ? { message: 'Set OPENAI_API_KEY in .env, then restart the server.' }
        : error;

  const refreshDevices = () => {
    void navigator.mediaDevices
      ?.enumerateDevices()
      .then(setDevices)
      .catch(() => undefined);
  };
  useEffect(() => {
    let current = true;
    void fetch('/api/config', { credentials: 'same-origin', cache: 'no-store' })
      .then(async (response) => {
        if (!response.ok) throw new Error('Could not read the server configuration.');
        const value = (await response.json()) as ConsoleConfig;
        if (current) setConfig(value);
      })
      .catch((e) => {
        if (current)
          setError({ message: e.message, action: 'Start the local server, then reload this page.' });
      });
    refreshDevices();
    navigator.mediaDevices?.addEventListener('devicechange', refreshDevices);
    const controller = new BrowserSession(audio.current!, {
      phase: (value) => {
        setPhase(value);
        if (value === 'live') refreshDevices();
      },
      event: (value) => {
        dispatch(value);
        if (value.type === 'ready') setStartedAt(value.startedAt);
        if (value.type === 'error')
          setError({ message: value.message, action: value.action, code: value.code });
      },
      error: (message, action, code) => setError({ message, action, code }),
      level: setLevel,
      playbackBlocked: setBlocked,
    });
    session.current = controller;
    return () => {
      current = false;
      controller.dispose();
      session.current = undefined;
      navigator.mediaDevices?.removeEventListener('devicechange', refreshDevices);
    };
  }, []);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  useEffect(() => {
    const pane = transcript.current;
    if (!pane || !hasTranscript) return;
    if (following.current) {
      pane.scrollTop = pane.scrollHeight;
      setNewText(false);
    } else setNewText(true);
  }, [view.transcript, hasTranscript]);
  useEffect(() => {
    if (audio.current) audio.current.volume = volume / 100;
  }, [volume]);
  const start = () => {
    if (!config || !session.current) return;
    setError(undefined);
    dispatch({ type: 'reset' });
    setMuted(false);
    setStartedAt(undefined);
    setNewText(false);
    following.current = true;
    void session.current.start(config, mode, inputDevice, outputDevice);
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(
        view.transcript.map((t) => `${t.role === 'user' ? 'You' : 'Live'}: ${t.text}`).join('\n\n'),
      );
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      setError({ message: 'Could not copy the transcript.' });
    }
  };
  const startButton = (
    <button className="primary-button" disabled={!config?.configured} onClick={start}>
      {hasTranscript ? 'Start new conversation' : 'Start conversation'}
    </button>
  );
  const disclosure = (
    <div className="preflight">
      <span>{config ? limitLabel(config.maxSessionSeconds) : 'Loading configuration…'}</span>
      <p>Audio is sent to OpenAI. API charges apply.</p>
      <button className="text-button" onClick={() => details.current?.showModal()}>
        Data & permissions
      </button>
    </div>
  );

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span>OpenAI</span>
          <h1>Live console</h1>
        </div>
        <button className="text-button" onClick={() => details.current?.showModal()}>
          Session details
        </button>
      </header>
      <div className="toolbar">
        <div className="delegation-control">
          <label htmlFor="delegation-mode">Delegation</label>
          <select
            id="delegation-mode"
            value={mode}
            disabled={active}
            onChange={(e) => setMode(e.target.value as Mode)}
          >
            <option value="responses">Managed by Live</option>
            <option value="client">Managed by app</option>
          </select>
        </div>
        <p className="mode-help">
          {mode === 'responses'
            ? 'Live supplies context to Responses.'
            : 'Your server builds context and calls Responses.'}
        </p>
        <button
          className="secondary-button audio-settings-button"
          onClick={() => {
            refreshDevices();
            audioSettings.current?.showModal();
          }}
        >
          Audio settings
        </button>
      </div>
      <main className="workspace">
        <section className="conversation pane" aria-labelledby="conversation-heading">
          <div className="pane-heading">
            <h2 id="conversation-heading">Conversation</h2>
            {hasTranscript && (
              <button className="text-button" onClick={() => void copy()}>
                {copied ? 'Copied' : 'Copy transcript'}
              </button>
            )}
          </div>
          {notice && (
            <div className="notice error-notice" role="alert">
              <strong>{notice.message}</strong>
              {notice.action && <p>{notice.action}</p>}
              {notice.code && (
                <details>
                  <summary>Technical details</summary>
                  <code>{notice.code}</code>
                </details>
              )}
            </div>
          )}
          {blocked && (
            <div className="notice playback-notice" role="alert">
              <p>Audio playback is blocked.</p>
              <button className="secondary-button" onClick={() => void session.current?.resumePlayback()}>
                Enable audio
              </button>
            </div>
          )}
          <div
            className="transcript"
            ref={transcript}
            tabIndex={0}
            aria-label="Conversation transcript"
            onScroll={(e) => {
              const pane = e.currentTarget;
              following.current = pane.scrollHeight - pane.scrollTop - pane.clientHeight < 48;
              if (following.current) setNewText(false);
            }}
          >
            {!hasTranscript ? (
              <div className="conversation-empty">
                {active ? (
                  <p className="empty-hint">
                    {phase === 'connecting'
                      ? 'Allow microphone access if prompted.'
                      : phase === 'live'
                        ? 'Your transcript will appear here.'
                        : ''}
                  </p>
                ) : (
                  <div className="start-prompt">
                    <h3>Ask about the sample backpack catalog.</h3>
                    <p className="example">Try: “Find a weekend backpack under $120.”</p>
                    {startButton}
                    {disclosure}
                  </div>
                )}
              </div>
            ) : (
              <>
                {view.clipped && <p className="clipped-note">Older transcript text was removed.</p>}
                {view.transcript.map((t) => (
                  <article className={`utterance ${t.role}`} key={t.id}>
                    <strong>{t.role === 'user' ? 'You' : 'GPT Live'}</strong>
                    <p>{t.text}</p>
                  </article>
                ))}
              </>
            )}
          </div>
          {newText && (
            <div className="jump-row">
              <button
                className="secondary-button"
                onClick={() => {
                  const pane = transcript.current;
                  if (pane) pane.scrollTop = pane.scrollHeight;
                  following.current = true;
                  setNewText(false);
                }}
              >
                Jump to latest
              </button>
            </div>
          )}
          {(active || hasTranscript || phase === 'closed') && (
            <footer className="call-controls">
              {phaseLabels[phase] && (
                <div className="call-status" role="status">
                  {phase === 'live' && (
                    <span
                      className="mic-level"
                      aria-label={muted ? 'Microphone muted' : 'Microphone input level'}
                    >
                      <i style={{ height: `${muted ? 3 : 3 + level * 17}px` }} />
                      <i style={{ height: `${muted ? 3 : 5 + level * 22}px` }} />
                      <i style={{ height: `${muted ? 3 : 3 + level * 14}px` }} />
                    </span>
                  )}
                  <span>{phase === 'live' && muted ? 'Mic muted · Session active' : phaseLabels[phase]}</span>
                  {active && startedAt && (
                    <time>
                      {clock(elapsed)} / {clock(config?.maxSessionSeconds || 180)}
                    </time>
                  )}
                </div>
              )}
              {active && phase !== 'closing' ? (
                <div className="call-actions">
                  {phase === 'live' && (
                    <>
                      <button
                        className="secondary-button"
                        aria-pressed={muted}
                        disabled={phase !== 'live'}
                        onClick={() => {
                          session.current?.setMuted(!muted);
                          setMuted(!muted);
                        }}
                      >
                        {muted ? 'Unmute mic' : 'Mute mic'}
                      </button>
                      <button
                        className="secondary-button"
                        aria-pressed={speakerMuted}
                        disabled={phase !== 'live'}
                        onClick={() => {
                          session.current?.setSpeakerMuted(!speakerMuted);
                          setSpeakerMuted(!speakerMuted);
                        }}
                      >
                        {speakerMuted ? 'Unmute speaker' : 'Mute speaker'}
                      </button>
                    </>
                  )}
                  <button className="end-button" onClick={() => void session.current?.stop()}>
                    End conversation
                  </button>
                </div>
              ) : !active && hasTranscript ? (
                <div className="restart">
                  {startButton}
                  {disclosure}
                </div>
              ) : null}
            </footer>
          )}
        </section>
        <aside className="activity pane" aria-labelledby="activity-heading">
          <div className="pane-heading">
            <h2 id="activity-heading">Activity</h2>
            {running > 0 && <span className="working-count">{running} active</span>}
          </div>
          <div className="activity-scroll">
            <p className="catalog-scope">Sample catalog · Read-only</p>
            {!view.activities.length ? (
              <p className="activity-empty">Tool calls will appear here.</p>
            ) : (
              view.activities.map((a) => (
                <article className="activity-group" key={a.id}>
                  <header>
                    <strong>{modeNames[a.mode]}</strong>
                    <span className={`activity-status ${a.status}`}>
                      {a.status === 'running' ? 'Working' : a.status === 'completed' ? 'Done' : 'Failed'}
                    </span>
                  </header>
                  {a.tools.map((t) => (
                    <div className="tool-result" key={t.id}>
                      <div className="tool-name">
                        <code>{t.name}</code>
                        {t.status === 'failed' && <span className="failed">Rejected</span>}
                      </div>
                      <p>{toolSummary(t.result)}</p>
                      <details>
                        <summary>Arguments & result</summary>
                        <pre>{JSON.stringify({ arguments: t.arguments, result: t.result }, null, 2)}</pre>
                      </details>
                    </div>
                  ))}
                  {a.text && (
                    <div className="backend-answer">
                      <span>Backend answer</span>
                      <p>{a.text}</p>
                    </div>
                  )}
                  {a.status === 'failed' && !a.tools.length && (
                    <p className="failed">The backend request failed.</p>
                  )}
                </article>
              ))
            )}
          </div>
          {hasUsage && (
            <details className="usage">
              <summary>
                Usage
                <span>
                  {view.final ? 'Live duration final' : phase === 'incomplete' ? 'Incomplete' : 'So far'}
                </span>
              </summary>
              <dl>
                <div>
                  <dt>Live duration</dt>
                  <dd>{view.seconds === null ? 'Unavailable' : `${view.seconds.toFixed(1)}s`}</dd>
                </div>
                <div>
                  <dt>Backend input</dt>
                  <dd>{view.inputTokens.toLocaleString()} tokens</dd>
                </div>
                <div>
                  <dt>Backend output</dt>
                  <dd>{view.outputTokens.toLocaleString()} tokens</dd>
                </div>
              </dl>
              <p>Live duration and backend tokens are billed separately.</p>
            </details>
          )}
        </aside>
      </main>
      <audio ref={audio} autoPlay playsInline hidden />
      <dialog ref={audioSettings} className="settings-dialog" aria-labelledby="audio-title">
        <div className="dialog-heading">
          <h2 id="audio-title">Audio settings</h2>
          <button
            className="close-button"
            onClick={() => audioSettings.current?.close()}
            aria-label="Close audio settings"
          >
            ×
          </button>
        </div>
        <label>
          Microphone
          <select value={inputDevice} disabled={active} onChange={(e) => setInputDevice(e.target.value)}>
            <option value="">System microphone</option>
            {devices
              .filter((d) => d.kind === 'audioinput' && d.deviceId && d.deviceId !== 'default')
              .map((d, i) => (
                <option key={d.deviceId} value={d.deviceId}>
                  {d.label || `Microphone ${i + 1}`}
                </option>
              ))}
          </select>
        </label>
        <label>
          Speaker
          <select
            value={outputDevice}
            disabled={active || !audio.current || !('setSinkId' in audio.current)}
            onChange={(e) => setOutputDevice(e.target.value)}
          >
            <option value="">System speaker</option>
            {devices
              .filter((d) => d.kind === 'audiooutput' && d.deviceId && d.deviceId !== 'default')
              .map((d, i) => (
                <option key={d.deviceId} value={d.deviceId}>
                  {d.label || `Speaker ${i + 1}`}
                </option>
              ))}
          </select>
        </label>
        {audio.current && !('setSinkId' in audio.current) && (
          <p className="hint">This browser uses the system speaker.</p>
        )}
        {devices.some((d) => d.kind === 'audioinput' && !d.label) && (
          <p className="hint">Device names appear after microphone permission.</p>
        )}
        {active && <p className="hint">End the conversation to change devices.</p>}
        <label className="volume-label">
          Volume
          <input
            type="range"
            min="0"
            max="100"
            value={volume}
            onChange={(e) => setVolume(Number(e.target.value))}
          />
        </label>
      </dialog>
      <dialog ref={details} className="details-dialog" aria-labelledby="details-title">
        <div className="dialog-heading">
          <h2 id="details-title">Session details</h2>
          <button
            className="close-button"
            onClick={() => details.current?.close()}
            aria-label="Close session details"
          >
            ×
          </button>
        </div>
        <dl className="model-list">
          <div>
            <dt>Voice model</dt>
            <dd>{config?.model || 'Loading…'}</dd>
          </div>
          <div>
            <dt>Backend model</dt>
            <dd>{config?.backendModel || 'Loading…'}</dd>
          </div>
          <div>
            <dt>Session limit</dt>
            <dd>{config ? clock(config.maxSessionSeconds) : '—'}</dd>
          </div>
        </dl>
        <h3>How delegation works</h3>
        <p>
          <strong>Managed by Live:</strong> Live supplies context to Responses. This server executes tools and
          continues the response.
        </p>
        <p>
          <strong>Managed by app:</strong> This server builds context from the transcript, runs a
          Responses/tool loop, and returns the answer to Live.
        </p>
        <h3>Data & permissions</h3>
        <p>
          Audio is sent to OpenAI. This app does not save audio or transcripts to disk. Your API key stays on
          the local server; OpenAI’s API data policies still apply.
        </p>
        <p>
          Tools only read the fictional catalog. They cannot make purchases, run commands, or access your
          files.
        </p>
        <p>
          Live duration and backend tokens are billed separately. Muting does not end a session. Finalization
          can extend beyond the session limit. See{' '}
          <a href="https://openai.com/api/pricing/" target="_blank" rel="noopener noreferrer">
            API pricing
          </a>
          .
        </p>
      </dialog>
    </div>
  );
}
function toolSummary(result: unknown) {
  const r = object(result);
  if (r.error) return 'The tool request was rejected.';
  const products = Array.isArray(r.products) ? r.products : r.product ? [r.product] : [];
  if (!products.length) return 'No products matched.';
  return products
    .map((p) => {
      const item = object(p);
      return `${String(item.name)} · $${String(item.price)}`;
    })
    .join(' / ');
}
