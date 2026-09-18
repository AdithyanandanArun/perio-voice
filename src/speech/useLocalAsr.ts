import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SpeakerVerdict } from '../domain/types';
import { captureSeconds } from './capture';
import {
  ASR_PROTOCOL_VERSION,
  TARGET_SAMPLE_RATE,
  asrWebSocketUrl,
  parseServerMessage,
  readAlternatives,
  readCadence,
  readSpeaker,
  readWords,
  type AsrFinal,
  type AsrModelInfo,
  type AsrServerMessage,
  type AsrStatus,
  CAPTURE_CONSTRAINTS,
  type CadenceInfo,
  type ClinicalExpectation,
  type EnrollmentState,
  type RuntimeInfo,
} from './protocol';

interface UseLocalAsrOptions {
  onFinal: (final: AsrFinal) => void;
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

export function useLocalAsr({ onFinal, contextVersion }: UseLocalAsrOptions): LocalAsrController {
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
  const socketRef = useRef<WebSocket | null>(null);
  const captureRef = useRef<CaptureResources | null>(null);
  const desiredListeningRef = useRef(false);
  const speechStartedAtRef = useRef<number | null>(null);
  const observedVersionRef = useRef<number | null>(null);
  const contextVersionRef = useRef(contextVersion);
  const reconnectTimerRef = useRef<number | null>(null);
  const reconnectAttemptRef = useRef(0);
  const connectRef = useRef<() => void>(() => undefined);
  const mountedRef = useRef(false);
  const onFinalRef = useRef(onFinal);
  const enrollmentCaptureRef = useRef<AbortController | null>(null);

  useEffect(() => {
    onFinalRef.current = onFinal;
    contextVersionRef.current = contextVersion;
  }, [contextVersion, onFinal]);

  const releaseCapture = useCallback((updateState = true) => {
    const capture = captureRef.current;
    captureRef.current = null;
    if (!capture) return;
    capture.worklet.port.onmessage = null;
    capture.source.disconnect();
    capture.worklet.disconnect();
    capture.mute.disconnect();
    for (const track of capture.stream.getTracks()) track.stop();
    void capture.context.close();
    if (updateState) {
      setCaptureActive(false);
      setAudioLevel(0);
    }
  }, []);

  const handleServerMessage = useCallback((message: AsrServerMessage) => {
    if (message.model && message.device && message.computeType) {
      setModel({ name: message.model, device: message.device, computeType: message.computeType });
    }
    switch (message.type) {
      case 'hello':
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
        if (desiredListeningRef.current && socketRef.current?.readyState === WebSocket.OPEN) {
          socketRef.current.send(JSON.stringify({ type: 'start' }));
        }
        break;
      case 'listening':
        setStatus('listening');
        break;
      case 'speech_start':
        speechStartedAtRef.current ??= performance.now() - 100;
        observedVersionRef.current = contextVersionRef.current?.() ?? null;
        setStatus('processing');
        break;
      case 'partial':
        setInterimTranscript(message.text?.trim() ?? '');
        setLatestDecodeMs(message.decodeMs ?? null);
        setStatus('processing');
        break;
      case 'final': {
        const transcript = message.text?.trim() ?? '';
        const observedAt = performance.now();
        const verdict = readSpeaker(message);
        setSpeaker(verdict);
        setCadence(readCadence(message));
        if (transcript) {
          onFinalRef.current({
            transcript,
            timing: {
              startedAt: speechStartedAtRef.current ?? observedAt,
              observedAt,
            },
            words: readWords(message),
            alternatives: readAlternatives(message),
            utteranceId: message.utteranceId ?? null,
            audioMs: message.audioMs ?? null,
            decodeMs: message.decodeMs ?? null,
            speaker: verdict,
            observedVersion: observedVersionRef.current,
          });
        }
        speechStartedAtRef.current = null;
        observedVersionRef.current = null;
        setInterimTranscript('');
        setLatestDecodeMs(message.decodeMs ?? null);
        setStatus(desiredListeningRef.current ? 'listening' : 'ready');
        break;
      }
      case 'stopped':
        setStatus('ready');
        break;
      case 'error':
        setError(message.message ?? 'The local recognition service reported an error.');
        setStatus(message.recoverable && desiredListeningRef.current ? 'listening' : 'error');
        break;
      default:
        break;
    }
  }, []);

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
    const socket = new WebSocket(asrWebSocketUrl(window.location));
    socket.binaryType = 'arraybuffer';
    socketRef.current = socket;
    socket.onopen = () => {
      reconnectAttemptRef.current = 0;
      // The service keeps expectation per connection, so a reconnect has to
      // re-declare it or the grammar silently reverts to the widest one.
      declaredExpectationRef.current = null;
    };
    socket.onmessage = (event: MessageEvent<string>) => {
      const message = parseServerMessage(event.data);
      if (message) handleServerMessage(message);
    };
    socket.onerror = () => {
      setError('Cannot reach the local speech service. Start it with npm run dev, then retry.');
    };
    socket.onclose = () => {
      if (socketRef.current === socket) socketRef.current = null;
      if (!mountedRef.current) return;
      setStatus('offline');
      setError('The local speech service disconnected. Reconnecting automatically…');
      const delay = Math.min(5_000, 500 * 2 ** reconnectAttemptRef.current);
      reconnectAttemptRef.current += 1;
      reconnectTimerRef.current = window.setTimeout(() => connectRef.current(), delay);
    };
  }, [handleServerMessage, supported]);

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
        processorOptions: { targetSampleRate: TARGET_SAMPLE_RATE, batchMs: 100 },
      });
      const mute = context.createGain();
      mute.gain.value = 0;
      worklet.port.onmessage = (event: MessageEvent<{ pcm: ArrayBuffer; level: number }>) => {
        setAudioLevel(Math.min(1, event.data.level * 4));
        const socket = socketRef.current;
        if (desiredListeningRef.current && socket?.readyState === WebSocket.OPEN) {
          socket.send(event.data.pcm);
        }
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
      socket.send(JSON.stringify({ type: 'start' }));
      setStatus('connecting');
    } catch (reason) {
      desiredListeningRef.current = false;
      if (pendingStream) {
        for (const track of pendingStream.getTracks()) track.stop();
      }
      if (pendingContext) void pendingContext.close();
      releaseCapture();
      const detail = reason instanceof Error ? reason.message : 'permission or device failure';
      setError(`Microphone capture could not start: ${detail}`);
      setStatus('error');
    }
  }, [connect, releaseCapture, status, supported]);

  const stop = useCallback(() => {
    desiredListeningRef.current = false;
    speechStartedAtRef.current = null;
    setInterimTranscript('');
    const socket = socketRef.current;
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'stop' }));
    releaseCapture();
    setStatus((current) => {
      if (current === 'unsupported') return current;
      return socket?.readyState === WebSocket.OPEN ? 'ready' : 'offline';
    });
  }, [releaseCapture]);

  const declaredExpectationRef = useRef<ClinicalExpectation | null>(null);

  const declareExpectation = useCallback((expectation: ClinicalExpectation) => {
    if (declaredExpectationRef.current === expectation) return;
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    declaredExpectationRef.current = expectation;
    socket.send(JSON.stringify({ type: 'context', expect: expectation }));
  }, []);

  const retry = useCallback(() => {
    if (!supported) return;
    setError(null);
    reconnectAttemptRef.current = 0;
    if (socketRef.current?.readyState === WebSocket.OPEN) {
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
        onLevel: (level) => {
          if (mountedRef.current) setAudioLevel(Math.min(1, level * 4));
        },
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
  }, [supported]);

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
    start,
    stop,
    retry,
    declareExpectation,
    enroll,
    revokeEnrollment,
  };
}
