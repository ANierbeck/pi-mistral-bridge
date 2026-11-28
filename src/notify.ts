/**
 * One output channel for bridge warnings and anomalies.
 *
 * A Pi extension that writes to `process.stderr` while the interactive TUI is
 * rendering paints over it (the raw terminal write lands between TUI frames).
 * Before a session exists there is nowhere else to go, so the headless sink
 * stays stderr; once `session_start` hands over the extension context, the
 * warning goes to `ctx.ui.notify`, which Pi renders as a proper transcript
 * entry. Print/RPC modes (`hasUI: false`) keep the stderr sink.
 *
 * Pattern taken from pi-antigravity (`emitCommandOutput`): pick exactly one
 * channel per mode instead of writing to the raw terminal in TUI mode.
 */

/** Notification types Pi's `ui.notify` accepts. */
export type BridgeMessageType = 'info' | 'warning' | 'error';

/** The minimal slice of Pi's `ExtensionContext` the notifier needs. */
export interface NotifySession {
  hasUI: boolean;
  ui: { notify(message: string, type?: BridgeMessageType): void };
}

export interface SessionNotifier {
  /** Binds the session context (on `session_start`) or clears it (on shutdown). */
  attach(session: NotifySession | null): void;
  /** Emits one warning on the current channel. */
  warn(message: string): void;
}

export interface CreateNotifierOptions {
  /** Headless sink; defaults to stderr with the bridge prefix. */
  write?: ((text: string) => void) | undefined;
}

/** Creates the per-extension notifier (see the module doc for the channel rule). */
export function createSessionNotifier(options: CreateNotifierOptions = {}): SessionNotifier {
  const write = options.write ?? ((text: string): void => void process.stderr.write(text));
  let session: NotifySession | null = null;
  return {
    attach(next: NotifySession | null): void {
      session = next;
    },
    warn(message: string): void {
      const current = session;
      if (current?.hasUI) {
        current.ui.notify(message, 'warning');
        return;
      }
      write(`pi-mistral-bridge: ${message}\n`);
    },
  };
}
