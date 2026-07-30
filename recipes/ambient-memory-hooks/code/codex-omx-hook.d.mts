export interface AmbientEvent {
  role: string;
  content: string;
  digest: string;
}

export interface AmbientState {
  version: 1;
  session_id: string;
  updated_at: number;
  events: AmbientEvent[];
  captured: string[];
}

export function readEventName(payload: Record<string, unknown>): string | null;
export function readPrompt(payload: Record<string, unknown>): string;
export function loadState(id: string, now?: number): AmbientState | null;
export function saveState(state: AmbientState | null): void;
export function appendVisibleEvent(
  state: AmbientState | null,
  role: string,
  text: unknown,
): boolean;
export function classifyCapture(
  state: AmbientState | null,
):
  | { action: 'skip'; reason: 'no-durable-signal' | 'sensitive-signal' }
  | { action: 'capture'; body: string };
export function handlePayload(
  payload: Record<string, unknown>,
): Record<string, unknown> | null;
