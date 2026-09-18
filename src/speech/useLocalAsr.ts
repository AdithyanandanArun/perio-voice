import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SpeakerVerdict } from '../domain/types';
import { captureSeconds } from './capture';
import {
  ASR_PROTOCOL_VERSION,
  createAudioGapControl,
  LIVE_BATCH_MS,
  MAX_BUFFERED_AUDIO_BYTES,
  TARGET_SAMPLE_RATE,
  asrWebSocketUrl,
  parseServerMessage,
  readAlternatives,
  readCadence,
  readLifecycle,
  readOriginalContextVersion,
  readRecognitionPath,
  readSampleTiming,
  readSpeaker,
  readWords,
  type AsrEndpoint,
  type AsrFinal,
  type AsrModelInfo,
  type AsrPartial,
  type AsrServerMessage,
  type AsrTiming,
  type AsrStatus,
  CAPTURE_CONSTRAINTS,
  type CadenceInfo,
  type ClinicalExpectation,
  type EnrollmentState,
  type RuntimeInfo,
} from './protocol';

export interface UseLocalAsrOptions {
  onFinal: (final: AsrFinal) => void;
  /** Receives every replaceable hypothesis without affecting final delivery. */
  onPartial?: (partial: AsrPartial) => void;
  /** Receives the endpoint boundary before the corresponding final, when sent. */
  onEndpoint?: (endpoint: AsrEndpoint) => void;
  /**
   * Read at speech start, not at commit. A final that was overtaken by a change
   * of location has to be recognizable as stale by the time it arrives.
   */
  contextVersion?: () => number;
}

export interface LocalAsrController {
  supported: boolean;
  status: AsrStatus;
  listening: boolean;
  interimTranscript: string;
  error: string | null;
  model: AsrModelInfo | null;
  runtime: RuntimeInfo | null;
  audioLevel: number;
  latestDecodeMs: number | null;
  speaker: SpeakerVerdict | null;
  cadence: CadenceInfo | null;
  enrollment: EnrollmentState | null;
  enrolling: boolean;
  /** Stable for the lifetime of the current WebSocket stream. */
  streamId: string | null;
  start: () => Promise<void>;
  stop: () => void;
  retry: () => void;
  /** Tells the service what the chart is waiting for, so it can narrow the grammar. */
  declareExpectation: (expectation: ClinicalExpectation) => void;
  enroll: (seconds?: number) => Promise<void>;
  revokeEnrollment: () => Promise<void>;
}

/** Seconds of speech requested when enrolling a clinician's voice. */
export const ENROLLMENT_SECONDS = 6;


interface CaptureResources {
  stream: MediaStream;
  context: AudioContext;
  source: MediaStreamAudioSourceNode;
  worklet: AudioWorkletNode;
  mute: GainNode;
}

interface WorkletAudioMessage {
  pcm: ArrayBuffer;
  level: number;
  sampleRate?: number;
  startSample?: number;
  endSample?: number;
}

interface AudioGap {
  startSample: number;
  endSample: number;
}

interface ExpectationDeclaration {
  expect: ClinicalExpectation;
  contextVersion: number | null;
}

const AUDIO_LEVEL_INTERVAL_MS = 80;
let fallbackIdentity = 0;

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function stableIdentity(prefix: string): string {
  const cryptoApi = globalThis.crypto;
  if (typeof cryptoApi?.randomUUID === 'function') return `${prefix}-${cryptoApi.randomUUID()}`;
  fallbackIdentity += 1;
  return `${prefix}-${Date.now().toString(36)}-${fallbackIdentity.toString(36)}`;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function currentContextVersion(contextVersion: (() => number) | undefined): number | null {
  try {
    const value = finiteNumber(contextVersion?.());
    return value === null || value < 0 ? null : Math.floor(value);
  } catch {
    return null;
  }
}

function messageUtteranceId(message: AsrServerMessage): number | null {
  return finiteNumber(message.utteranceId);
}

function messageRevision(message: AsrServerMessage, fallback: number): number {
  const revision = finiteNumber(message.revision);
  return revision !== null ? Math.max(0, Math.floor(revision)) : fallback;
}

function messageStreamId(message: AsrServerMessage, fallback: string | null): string | null {
  return typeof message.streamId === 'string' && message.streamId.trim() !== ''
    ? message.streamId.trim()
    : fallback;
}

function messageTransactionId(message: AsrServerMessage, fallback: string | null): string | null {
  return typeof message.transactionId === 'string' && message.transactionId.trim() !== ''
    ? message.transactionId.trim()
    : fallback;
}

export function supportsLocalAudioCapture(): boolean {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return false;
  const Context = window.AudioContext ?? window.webkitAudioContext;
  return Boolean(
    typeof navigator.mediaDevices?.getUserMedia === 'function'
    && Context
    && typeof window.AudioWorkletNode === 'function'
    && typeof window.WebSocket === 'function',
  );
}

export function useLocalAsr({
  onFinal,
  onPartial,
  onEndpoint,
  contextVersion,
}: UseLocalAsrOptions): LocalAsrController {
  const supported = useMemo(supportsLocalAudioCapture, []);
  const [status, setStatus] = useState<AsrStatus>(supported ? 'connecting' : 'unsupported');
  const [interimTranscript, setInterimTranscript] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [model, setModel] = useState<AsrModelInfo | null>(null);
  const [captureActive, setCaptureActive] = useState(false);
  const [audioLevel, setAudioLevel] = useState(0);
  const [latestDecodeMs, setLatestDecodeMs] = useState<number | null>(null);
  const [runtime, setRuntime] = useState<RuntimeInfo | null>(null);
  const [speaker, setSpeaker] = useState<SpeakerVerdict | null>(null);
  const [cadence, setCadence] = useState<CadenceInfo | null>(null);
  const [enrollment, setEnrollment] = useState<EnrollmentState | null>(null);
  const [enrolling, setEnrolling] = useState(false);
  const [streamId, setStreamId] = useState<string | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const captureRef = useRef<CaptureResources | null>(null);
  const desiredListeningRef = useRef(false);
  const speechStartedAtRef = useRef<number | null>(null);
  const speechStartSampleRef = useRef<number | null>(null);
  const observedVersionRef = useRef<number | null>(null);
  const streamIdRef = useRef<string | null>(null);
  const utteranceIdRef = useRef<number | null>(null);
  const utteranceCounterRef = useRef(0);
  const transactionIdRef = useRef<string | null>(null);
  const revisionRef = useRef(0);
  const sampleCursorRef = useRef(0);
  const audioGapsRef = useRef<AudioGap[]>([]);
  const streamStartedRef = useRef(false);
  const transportReadyRef = useRef(false);
  const contextVersionRef = useRef(contextVersion);
  const desiredExpectationRef = useRef<ClinicalExpectation | null>(null);
  const declaredExpectationRef = useRef<ExpectationDeclaration | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const reconnectAttemptRef = useRef(0);
  const connectRef = useRef<() => void>(() => undefined);
  const mountedRef = useRef(false);
  const onFinalRef = useRef(onFinal);
  const onPartialRef = useRef(onPartial);
  const onEndpointRef = useRef(onEndpoint);
  const enrollmentCaptureRef = useRef<AbortController | null>(null);
  const levelTimerRef = useRef<number | null>(null);
  const pendingLevelRef = useRef(0);
  const lastLevelAtRef = useRef<number | null>(null);

  useEffect(() => {
    onFinalRef.current = onFinal;
    onPartialRef.current = onPartial;
    onEndpointRef.current = onEndpoint;
    contextVersionRef.current = contextVersion;
  }, [contextVersion, onEndpoint, onFinal, onPartial]);

  const publishAudioLevel = useCallback((level: number) => {
    const bounded = Math.max(0, Math.min(1, Number.isFinite(level) ? level : 0));
    pendingLevelRef.current = bounded;
    const at = now();
    const last = lastLevelAtRef.current;
    if (last === null || at - last >= AUDIO_LEVEL_INTERVAL_MS) {
      lastLevelAtRef.current = at;
      setAudioLevel(bounded);
      return;
    }
    if (levelTimerRef.current !== null) return;
    levelTimerRef.current = window.setTimeout(() => {
      levelTimerRef.current = null;
      lastLevelAtRef.current = now();
      if (mountedRef.current) setAudioLevel(pendingLevelRef.current);
    }, Math.max(0, AUDIO_LEVEL_INTERVAL_MS - (at - last)));
  }, []);

  const resetAudioLevel = useCallback(() => {
    if (levelTimerRef.current !== null) {
      window.clearTimeout(levelTimerRef.current);
      levelTimerRef.current = null;
    }
    pendingLevelRef.current = 0;
    lastLevelAtRef.current = now();
    setAudioLevel(0);
  }, []);

  const releaseCapture = useCallback((updateState = true) => {
    const capture = captureRef.current;
    captureRef.current = null;
    if (!capture) {
      if (updateState) {
        setCaptureActive(false);
        resetAudioLevel();
      }
      return;
    }
    capture.worklet.port.onmessage = null;
    capture.source.disconnect();
    capture.worklet.disconnect();
    capture.mute.disconnect();
    for (const track of capture.stream.getTracks()) track.stop();
    void capture.context.close();
    if (updateState) {
      setCaptureActive(false);
      resetAudioLevel();
    }
  }, [resetAudioLevel]);

  const expectationDeclaration = useCallback((): ExpectationDeclaration | null => {
    const expectation = desiredExpectationRef.current;
    return expectation === null
      ? null
      : { expect: expectation, contextVersion: currentContextVersion(contextVersionRef.current) };
  }, []);

  const startControl = useCallback(() => {
    const current = streamIdRef.current ?? stableIdentity('stream');
    streamIdRef.current = current;
    setStreamId(current);
    const declaration = expectationDeclaration();
    const control: {
      type: 'start';
      streamId: string;
      expect?: ClinicalExpectation;
      contextVersion?: number;
    } = { type: 'start', streamId: current };
    if (declaration?.expect !== undefined) control.expect = declaration.expect;
    if (declaration?.contextVersion !== null && declaration?.contextVersion !== undefined) {
      control.contextVersion = declaration.contextVersion;
    }
    return JSON.stringify(control);
  }, [expectationDeclaration]);

  const sendStartControl = useCallback((socket: WebSocket) => {
    if (socket.readyState !== WebSocket.OPEN) return;
    socket.send(startControl());
    streamStartedRef.current = true;
    // The server's listening acknowledgement is the barrier before PCM.
    transportReadyRef.current = false;
    const declaration = expectationDeclaration();
    if (declaration) declaredExpectationRef.current = declaration;
  }, [expectationDeclaration, startControl]);

  const utf8ByteLength = useCallback((value: string): number => {
    if (typeof TextEncoder === 'function') return new TextEncoder().encode(value).byteLength;
    return value.length;
  }, []);

  const recordAudioGap = useCallback((startSample: number, endSample: number) => {
    const start = Math.max(0, Math.floor(startSample));
    const end = Math.max(start, Math.floor(endSample));
    if (end <= start) return;
    const next: AudioGap = { startSample: start, endSample: end };
    const merged: AudioGap[] = [];
    let inserted = false;
    for (const existing of audioGapsRef.current) {
      if (existing.endSample < next.startSample) {
        merged.push(existing);
        continue;
      }
      if (next.endSample < existing.startSample) {
        if (!inserted) {
          merged.push(next);
          inserted = true;
        }
        merged.push(existing);
        continue;
      }
      // Equality is intentional: adjacent skipped ranges form one ordered
      // gap, while a sent frame flushes the pending list before the next gap.
      next.startSample = Math.min(next.startSample, existing.startSample);
      next.endSample = Math.max(next.endSample, existing.endSample);
    }
    if (!inserted) merged.push(next);
    audioGapsRef.current = merged;
  }, []);

  const flushAudioGapControl = useCallback((
    socket: WebSocket | null,
    followingAudioBytes = 0,
    force = false,
  ): boolean => {
    const gaps = audioGapsRef.current;
    if (gaps.length === 0) return true;
    if (socket?.readyState !== WebSocket.OPEN) return false;
    const streamId = streamIdRef.current ?? stableIdentity('stream');
    streamIdRef.current = streamId;
    const controls = gaps.map((gap) => JSON.stringify(createAudioGapControl(
      streamId,
      gap.startSample,
      gap.endSample,
    )));
    const controlBytes = controls.reduce((total, control) => total + utf8ByteLength(control), 0);
    const buffered = typeof socket.bufferedAmount === 'number' ? socket.bufferedAmount : 0;
    // A stop is allowed to report the final gap even when older bytes are
    // still draining. For recovery, keep the native queue bounded and defer
    // both controls and PCM until one ordered send fits.
    if (!force && buffered + controlBytes + followingAudioBytes > MAX_BUFFERED_AUDIO_BYTES) {
      return false;
    }
    try {
      for (const control of controls) socket.send(control);
    } catch {
      return false;
    }
    audioGapsRef.current = [];
    return true;
  }, [utf8ByteLength]);

  const sendAudioFrame = useCallback((frame: WorkletAudioMessage) => {
    const frameSamples = Math.max(0, Math.floor(frame.pcm.byteLength / Int16Array.BYTES_PER_ELEMENT));
    const previousCursor = sampleCursorRef.current;
    const suppliedStart = finiteNumber(frame.startSample);
    const frameStart = Math.max(0, suppliedStart ?? previousCursor);
    const suppliedEnd = finiteNumber(frame.endSample);
    const frameEnd = Math.max(frameStart, suppliedEnd ?? frameStart + frameSamples);
    if (desiredListeningRef.current && suppliedStart !== null && suppliedStart > previousCursor) {
      recordAudioGap(previousCursor, suppliedStart);
    }
    sampleCursorRef.current = Math.max(previousCursor, frameEnd);

    if (!desiredListeningRef.current) return;
    const socket = socketRef.current;
    const transportAvailable = streamStartedRef.current && transportReadyRef.current;
    if (!transportAvailable || socket?.readyState !== WebSocket.OPEN) {
      recordAudioGap(frameStart, frameEnd);
      return;
    }

    const buffered = typeof socket.bufferedAmount === 'number' ? socket.bufferedAmount : 0;
    if (buffered + frame.pcm.byteLength > MAX_BUFFERED_AUDIO_BYTES) {
      recordAudioGap(frameStart, frameEnd);
      return;
    }

    if (!flushAudioGapControl(socket, frame.pcm.byteLength)) {
      recordAudioGap(frameStart, frameEnd);
      return;
    }
    try {
      socket.send(frame.pcm);
    } catch {
      recordAudioGap(frameStart, frameEnd);
    }
  }, [flushAudioGapControl, recordAudioGap]);

  const sendContextControl = useCallback((socket: WebSocket | null, force = false): boolean => {
    const declaration = expectationDeclaration();
    if (!declaration || socket?.readyState !== WebSocket.OPEN) return false;
    const previous = declaredExpectationRef.current;
    if (!force && previous?.expect === declaration.expect
        && previous.contextVersion === declaration.contextVersion) return true;
    const control: {
      type: 'context';
      expect: ClinicalExpectation;
      contextVersion?: number;
    } = { type: 'context', expect: declaration.expect };
    if (declaration.contextVersion !== null) control.contextVersion = declaration.contextVersion;
    try {
      socket.send(JSON.stringify(control));
    } catch {
      return false;
    }
    declaredExpectationRef.current = declaration;
    return true;
  }, [expectationDeclaration]);

  const handleServerMessage = useCallback((message: AsrServerMessage) => {
    if (message.model && message.device && message.computeType) {
      setModel({ name: message.model, device: message.device, computeType: message.computeType });
    }

    const ensureIdentity = (incoming: AsrServerMessage, observedAt: number) => {
      const incomingStreamId = messageStreamId(incoming, streamIdRef.current);
      if (incomingStreamId !== null) {
        streamIdRef.current = incomingStreamId;
        setStreamId(incomingStreamId);
      }
      const incomingUtteranceId = messageUtteranceId(incoming);
      if (incomingUtteranceId !== null) {
        utteranceIdRef.current = Math.floor(incomingUtteranceId);
        utteranceCounterRef.current = Math.max(utteranceCounterRef.current, utteranceIdRef.current);
      } else if (utteranceIdRef.current === null) {
        // Older services did not attach utterance ids. Keep a deterministic
        // local sequence so all revisions of one response share an identity.
        utteranceCounterRef.current += 1;
        utteranceIdRef.current = utteranceCounterRef.current;
      }
      if (speechStartedAtRef.current === null) {
        speechStartedAtRef.current = observedAt;
        observedVersionRef.current = readOriginalContextVersion(incoming)
          ?? currentContextVersion(contextVersionRef.current)
          ?? null;
      }
      const sampleTiming = readSampleTiming(incoming);
      if (sampleTiming.startSample !== null && speechStartSampleRef.current === null) {
        speechStartSampleRef.current = sampleTiming.startSample;
      }
      const fallbackTransaction = transactionIdRef.current
        ?? `${streamIdRef.current ?? 'stream-unknown'}:${utteranceIdRef.current ?? 'utterance-unknown'}`;
      transactionIdRef.current = messageTransactionId(incoming, fallbackTransaction);
      revisionRef.current = messageRevision(incoming, revisionRef.current + 1);
      const incomingContextVersion = readOriginalContextVersion(incoming);
      if (incomingContextVersion !== null) observedVersionRef.current = incomingContextVersion;
      return {
        streamId: streamIdRef.current,
        utteranceId: utteranceIdRef.current,
        transactionId: transactionIdRef.current,
        revision: revisionRef.current,
        originalContextVersion: observedVersionRef.current,
      };
    };

    const timingFor = (incoming: AsrServerMessage, observedAt: number): AsrTiming => {
      const sampleTiming = readSampleTiming(incoming);
      const startSample = sampleTiming.startSample ?? speechStartSampleRef.current;
      const durationSamples = sampleTiming.durationSamples
        ?? (startSample !== null && sampleTiming.endSample !== null
          ? sampleTiming.endSample - startSample
          : null);
      const endSample = sampleTiming.endSample
        ?? (startSample !== null && durationSamples !== null ? startSample + durationSamples : null);
      return {
        startedAt: speechStartedAtRef.current ?? observedAt,
        observedAt,
        sampleRate: sampleTiming.sampleRate
          ?? (startSample !== null || endSample !== null || durationSamples !== null
            ? TARGET_SAMPLE_RATE
            : null),
        startSample,
        endSample,
        durationSamples,
      };
    };

    const emitEndpoint = (
      incoming: AsrServerMessage,
      existingIdentity?: ReturnType<typeof ensureIdentity>,
    ) => {
      const observedAt = now();
      const identity = existingIdentity ?? ensureIdentity(incoming, observedAt);
      onEndpointRef.current?.({
        ...identity,
        timing: timingFor(incoming, observedAt),
        lifecycle: readLifecycle(incoming, 'provisional'),
        recognitionPath: readRecognitionPath(incoming),
        audioMs: finiteNumber(incoming.audioMs),
      });
      setStatus('processing');
    };

    switch (message.type) {
      case 'hello':
        if (message.streamId) {
          streamIdRef.current = message.streamId;
          setStreamId(message.streamId);
        }
        if (message.protocol !== ASR_PROTOCOL_VERSION) {
          setStatus('error');
          setError('The browser and local ASR service use incompatible protocol versions.');
        }
        break;
      case 'model_status':
        if (message.status === 'error') {
          setStatus('error');
          setError(message.error || 'The local speech model could not load.');
        } else {
          setStatus('loading-model');
          setError(null);
        }
        break;
      case 'model_ready':
        setError(null);
        setStatus(desiredListeningRef.current ? 'connecting' : 'ready');
        if (desiredListeningRef.current
            && !streamStartedRef.current
            && socketRef.current?.readyState === WebSocket.OPEN) {
          sendStartControl(socketRef.current);
        } else if (socketRef.current?.readyState === WebSocket.OPEN) {
          sendContextControl(socketRef.current);
        }
        break;
      case 'listening':
        if (desiredListeningRef.current && streamStartedRef.current) {
          // Keep this explicit context declaration for older servers that do
          // not inspect the additive fields on the start control.
          const declaration = expectationDeclaration();
          const contextReady = declaration === null
            || sendContextControl(socketRef.current, true);
          transportReadyRef.current = contextReady;
          setStatus(contextReady ? 'listening' : 'connecting');
        } else {
          setStatus(desiredListeningRef.current ? 'connecting' : 'ready');
        }
        break;
      case 'speech_start': {
        const observedAt = now();
        const sampleTiming = readSampleTiming(message);
        speechStartedAtRef.current = observedAt;
        speechStartSampleRef.current = sampleTiming.startSample;
        observedVersionRef.current = readOriginalContextVersion(message)
          ?? currentContextVersion(contextVersionRef.current)
          ?? null;
        const incomingUtteranceId = messageUtteranceId(message);
        utteranceIdRef.current = incomingUtteranceId === null
          ? (utteranceCounterRef.current += 1)
          : Math.floor(incomingUtteranceId);
        utteranceCounterRef.current = Math.max(utteranceCounterRef.current, utteranceIdRef.current);
        transactionIdRef.current = messageTransactionId(message, null);
        revisionRef.current = messageRevision(message, 0);
        ensureIdentity(message, observedAt);
        setStatus('processing');
        break;
      }
      case 'partial': {
        const observedAt = now();
        const identity = ensureIdentity(message, observedAt);
        const transcript = message.text?.trim() ?? '';
        const partial: AsrPartial = {
          ...identity,
          transcript,
          timing: timingFor(message, observedAt),
          lifecycle: readLifecycle(message, 'provisional'),
          recognitionPath: readRecognitionPath(message),
          audioMs: finiteNumber(message.audioMs),
          decodeMs: finiteNumber(message.decodeMs),
        };
        setInterimTranscript(transcript);
        setLatestDecodeMs(partial.decodeMs);
        onPartialRef.current?.(partial);
        setStatus('processing');
        break;
      }
      case 'endpoint':
      case 'speech_end':
        emitEndpoint(message);
        break;
      case 'final': {
        const transcript = message.text?.trim() ?? '';
        const observedAt = now();
        const identity = ensureIdentity(message, observedAt);
        const verdict = readSpeaker(message);
        const timing = timingFor(message, observedAt);
        setSpeaker(verdict);
        setCadence(readCadence(message));
        if (message.endpoint) emitEndpoint(message, identity);
        if (transcript) {
          onFinalRef.current({
            transcript,
            timing,
            words: readWords(message),
            alternatives: readAlternatives(message),
            ...identity,
            lifecycle: readLifecycle(message, 'confirmed'),
            recognitionPath: readRecognitionPath(message),
            audioMs: finiteNumber(message.audioMs),
            decodeMs: finiteNumber(message.decodeMs),
            speaker: verdict,
            observedVersion: identity.originalContextVersion,
          });
        }
        speechStartedAtRef.current = null;
        speechStartSampleRef.current = null;
        observedVersionRef.current = null;
        utteranceIdRef.current = null;
        transactionIdRef.current = null;
        revisionRef.current = 0;
        setInterimTranscript('');
        setLatestDecodeMs(finiteNumber(message.decodeMs));
        setStatus(desiredListeningRef.current ? 'listening' : 'ready');
        break;
      }
      case 'stopped':
        transportReadyRef.current = false;
        streamStartedRef.current = false;
        setStatus(desiredListeningRef.current ? 'connecting' : 'ready');
        break;
      case 'context_ack':
        // Acknowledgements are intentionally display-neutral. The desired
        // declaration remains in refs and is re-sent on the next connection.
        break;
      case 'audio_gap_ack':
      case 'gap_ack':
        // Gap acknowledgements must never transition a healthy listener out of
        // its current state.
        break;
      case 'audio_gap_error':
      case 'gap_error':
        setError(message.message ?? message.error ?? 'The service could not record an audio gap.');
        setStatus(desiredListeningRef.current ? 'listening' : 'ready');
        break;
      case 'error':
        if (typeof message.code === 'string' && message.code.includes('gap')) {
          setError(message.message ?? message.error ?? 'The service could not record an audio gap.');
          setStatus(desiredListeningRef.current ? 'listening' : 'ready');
        } else {
          setError(message.message ?? 'The local recognition service reported an error.');
          setStatus(message.recoverable && desiredListeningRef.current ? 'listening' : 'error');
        }
        break;
      default:
        break;
    }
  }, [expectationDeclaration, sendContextControl, sendStartControl]);

  const connect = useCallback(() => {
    if (!supported || !mountedRef.current) return;
    if (reconnectTimerRef.current !== null) window.clearTimeout(reconnectTimerRef.current);
    const existing = socketRef.current;
    if (
      existing
      && (existing.readyState === WebSocket.CONNECTING || existing.readyState === WebSocket.OPEN)
    ) return;

    setStatus('connecting');
    setError(null);
    // A new WebSocket creates a fresh server sample clock. Any ranges already
    // skipped while it was unavailable remain in audioGapsRef and are remapped
    // from zero by the first resumed PCM frame.
    sampleCursorRef.current = 0;
    const nextStreamId = stableIdentity('stream');
    streamIdRef.current = nextStreamId;
    setStreamId(nextStreamId);
    const socket = new WebSocket(asrWebSocketUrl(window.location));
    socket.binaryType = 'arraybuffer';
    socketRef.current = socket;
    socket.onopen = () => {
      reconnectAttemptRef.current = 0;
      declaredExpectationRef.current = null;
      transportReadyRef.current = false;
      streamStartedRef.current = false;
      // Keep the desired declaration while offline. It is safe to send before
      // a start because the server treats context as connection state.
      sendContextControl(socket);
    };
    socket.onmessage = (event: MessageEvent<string>) => {
      const message = parseServerMessage(event.data);
      if (message) handleServerMessage(message);
    };
    socket.onerror = () => {
      setError('Cannot reach the local speech service. Start it with npm run dev, then retry.');
    };
    socket.onclose = () => {
      if (socketRef.current === socket) {
        socketRef.current = null;
        streamStartedRef.current = false;
        transportReadyRef.current = false;
        // Each WebSocket start owns a fresh server sample clock. Keep the
        // pending gap ledger, but make the next connection explicitly account
        // for all samples it did not receive before its first PCM frame.
        sampleCursorRef.current = 0;
        speechStartedAtRef.current = null;
        speechStartSampleRef.current = null;
        observedVersionRef.current = null;
        utteranceIdRef.current = null;
        transactionIdRef.current = null;
        revisionRef.current = 0;
      }
      if (!mountedRef.current) return;
      setStatus('offline');
      setError('The local speech service disconnected. Reconnecting automatically…');
      const delay = Math.min(5_000, 500 * 2 ** reconnectAttemptRef.current);
      reconnectAttemptRef.current += 1;
      reconnectTimerRef.current = window.setTimeout(() => connectRef.current(), delay);
    };
  }, [handleServerMessage, sendContextControl, supported]);

  useEffect(() => {
    connectRef.current = connect;
  }, [connect]);

  const start = useCallback(async () => {
    if (!supported) {
      setError('Local microphone capture is unavailable. Use the transcript simulator below.');
      return;
    }
    if (!socketRef.current || socketRef.current.readyState !== WebSocket.OPEN || status !== 'ready') {
      setError('The local speech model is not ready yet. Wait for Ready or use Retry engine.');
      connect();
      return;
    }
    desiredListeningRef.current = true;
    streamStartedRef.current = false;
    transportReadyRef.current = false;
    sampleCursorRef.current = 0;
    audioGapsRef.current = [];
    setStatus('connecting');
    setError(null);
    let pendingStream: MediaStream | null = null;
    let pendingContext: AudioContext | null = null;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: CAPTURE_CONSTRAINTS });
      if (!desiredListeningRef.current) {
        for (const track of stream.getTracks()) track.stop();
        return;
      }
      pendingStream = stream;
      const Context = window.AudioContext ?? window.webkitAudioContext;
      if (!Context) throw new Error('AudioContext is unavailable.');
      const context = new Context({ latencyHint: 'interactive' });
      pendingContext = context;
      await context.audioWorklet.addModule('/audio/pcm-capture-worklet.js');
      const source = context.createMediaStreamSource(stream);
      const worklet = new AudioWorkletNode(context, 'pcm-capture-processor', {
        processorOptions: { targetSampleRate: TARGET_SAMPLE_RATE, batchMs: LIVE_BATCH_MS },
      });
      const mute = context.createGain();
      mute.gain.value = 0;
      worklet.port.onmessage = (event: MessageEvent<WorkletAudioMessage>) => {
        publishAudioLevel(event.data.level * 4);
        sendAudioFrame(event.data);
      };
      source.connect(worklet);
      worklet.connect(mute);
      mute.connect(context.destination);
      captureRef.current = { stream, context, source, worklet, mute };
      pendingStream = null;
      pendingContext = null;
      setCaptureActive(true);
      await context.resume();
      const socket = socketRef.current;
      if (!socket || socket.readyState !== WebSocket.OPEN) {
        throw new Error('the local speech service disconnected during microphone setup');
      }
      sendStartControl(socket);
      setStatus('connecting');
    } catch (reason) {
      desiredListeningRef.current = false;
      streamStartedRef.current = false;
      transportReadyRef.current = false;
      audioGapsRef.current = [];
      sampleCursorRef.current = 0;
      if (pendingStream) {
        for (const track of pendingStream.getTracks()) track.stop();
      }
      if (pendingContext) void pendingContext.close();
      releaseCapture();
      const detail = reason instanceof Error ? reason.message : 'permission or device failure';
      setError(`Microphone capture could not start: ${detail}`);
      setStatus('error');
    }
  }, [connect, publishAudioLevel, releaseCapture, sendAudioFrame, sendStartControl, status, supported]);

  const stop = useCallback(() => {
    desiredListeningRef.current = false;
    const socket = socketRef.current;
    flushAudioGapControl(socket, 0, true);
    streamStartedRef.current = false;
    transportReadyRef.current = false;
    sampleCursorRef.current = 0;
    audioGapsRef.current = [];
    speechStartedAtRef.current = null;
    speechStartSampleRef.current = null;
    observedVersionRef.current = null;
    utteranceIdRef.current = null;
    transactionIdRef.current = null;
    revisionRef.current = 0;
    setInterimTranscript('');
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'stop' }));
    releaseCapture();
    setStatus((current) => {
      if (current === 'unsupported') return current;
      return socket?.readyState === WebSocket.OPEN ? 'ready' : 'offline';
    });
  }, [flushAudioGapControl, releaseCapture]);

  const declareExpectation = useCallback((expectation: ClinicalExpectation) => {
    desiredExpectationRef.current = expectation;
    const socket = socketRef.current;
    sendContextControl(socket);
  }, [sendContextControl]);

  // The chart can advance its version without changing the grammar family
  // (for example, moving to the next tooth while still expecting depths).
  // Re-declare that version even when the expectation string is unchanged.
  useEffect(() => {
    if (desiredExpectationRef.current !== null) {
      sendContextControl(socketRef.current);
    }
  }, [contextVersion, sendContextControl]);

  const retry = useCallback(() => {
    if (!supported) return;
    setError(null);
    reconnectAttemptRef.current = 0;
    if (socketRef.current?.readyState === WebSocket.OPEN) {
      if (desiredListeningRef.current) {
        // retry_model may leave the old session attached to this socket. Gate
        // PCM until model_ready starts a fresh session and reset its sample
        // clock without discarding the pending gap ledger.
        streamStartedRef.current = false;
        transportReadyRef.current = false;
        sampleCursorRef.current = 0;
      }
      socketRef.current.send(JSON.stringify({ type: 'retry_model' }));
      setStatus('loading-model');
      return;
    }
    if (socketRef.current) {
      socketRef.current.onclose = null;
      socketRef.current.close();
    }
    socketRef.current = null;
    connect();
  }, [connect, supported]);

  const refreshRuntime = useCallback(async () => {
    try {
      const response = await fetch('/api/health');
      if (!response.ok) return;
      const health = (await response.json()) as { runtime?: RuntimeInfo };
      if (mountedRef.current && health.runtime) setRuntime(health.runtime);
    } catch {
      // The socket already reports service availability; this is supplementary.
    }
  }, []);

  const refreshEnrollment = useCallback(async () => {
    try {
      const response = await fetch('/api/speaker');
      if (!response.ok) return;
      const state = (await response.json()) as EnrollmentState;
      if (mountedRef.current) setEnrollment(state);
    } catch {
      // Attribution is optional; its absence must not break capture.
    }
  }, []);

  const enroll = useCallback(async (seconds = ENROLLMENT_SECONDS) => {
    if (!supported) {
      setError('Speaker enrollment needs microphone access, which is unavailable here.');
      return;
    }
    enrollmentCaptureRef.current?.abort();
    const controller = new AbortController();
    enrollmentCaptureRef.current = controller;
    setEnrolling(true);
    setError(null);
    try {
      const sample = await captureSeconds(seconds, {
        signal: controller.signal,
        onLevel: (level) => publishAudioLevel(level * 4),
      });
      const response = await fetch('/api/speaker/enroll', { method: 'POST', body: sample });
      const state = (await response.json()) as EnrollmentState & { error?: string };
      if (!response.ok) {
        setError(state.error ?? 'Enrollment failed. Try again and keep speaking throughout.');
      }
      if (mountedRef.current) setEnrollment({ ...state });
    } catch (reason) {
      if (reason instanceof DOMException && reason.name === 'AbortError') return;
      const detail = reason instanceof Error ? reason.message : 'microphone or service failure';
      setError(`Speaker enrollment could not complete: ${detail}`);
    } finally {
      if (enrollmentCaptureRef.current === controller) {
        enrollmentCaptureRef.current = null;
        if (mountedRef.current) setEnrolling(false);
      }
    }
  }, [publishAudioLevel, supported]);

  const revokeEnrollment = useCallback(async () => {
    try {
      const response = await fetch('/api/speaker/reset', { method: 'POST' });
      const state = (await response.json()) as EnrollmentState;
      if (mountedRef.current) {
        setEnrollment(state);
        setSpeaker(null);
      }
    } catch {
      setError('The enrolled voice profile could not be revoked. Is the service running?');
    }
  }, []);

  useEffect(() => {
    if (status !== 'ready' && status !== 'listening') return;
    void refreshRuntime();
    void refreshEnrollment();
  }, [refreshEnrollment, refreshRuntime, status]);

  useEffect(() => {
    mountedRef.current = true;
    connect();
    return () => {
      mountedRef.current = false;
      desiredListeningRef.current = false;
      streamStartedRef.current = false;
      transportReadyRef.current = false;
      audioGapsRef.current = [];
      sampleCursorRef.current = 0;
      if (reconnectTimerRef.current !== null) window.clearTimeout(reconnectTimerRef.current);
      const socket = socketRef.current;
      socketRef.current = null;
      if (socket) {
        socket.onclose = null;
        socket.close();
      }
      enrollmentCaptureRef.current?.abort();
      enrollmentCaptureRef.current = null;
      releaseCapture(false);
      if (levelTimerRef.current !== null) window.clearTimeout(levelTimerRef.current);
      levelTimerRef.current = null;
    };
  }, [connect, releaseCapture]);

  return {
    supported,
    status,
    listening: captureActive,
    interimTranscript,
    error,
    model,
    runtime,
    audioLevel,
    latestDecodeMs,
    speaker,
    cadence,
    enrollment,
    enrolling,
    streamId,
    start,
    stop,
    retry,
    declareExpectation,
    enroll,
    revokeEnrollment,
  };
}
