export const ASR_PROTOCOL_VERSION = 1;
export const TARGET_SAMPLE_RATE = 16_000;

export type AsrStatus =
  | 'unsupported'
  | 'offline'
  | 'connecting'
  | 'loading-model'
  | 'ready'
  | 'listening'
  | 'processing'
  | 'error';

export interface AsrModelInfo {
  name: string;
  device: string;
  computeType: string;
}

export interface AsrServerMessage {
  type: string;
  protocol?: number;
  status?: string;
  model?: string;
  device?: string;
  computeType?: string;
  text?: string;
  decodeMs?: number;
  startedAtMs?: number;
  error?: string | null;
  message?: string;
  recoverable?: boolean;
}

export function asrWebSocketUrl(location: Pick<Location, 'protocol' | 'host'>): string {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${location.host}/ws/asr`;
}

export function parseServerMessage(value: string): AsrServerMessage | null {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || !("type" in parsed)) return null;
    return parsed as AsrServerMessage;
  } catch {
    return null;
  }
}
