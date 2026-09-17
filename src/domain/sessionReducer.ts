import {
  applyTranscript,
  clearCurrentRecord,
  createInitialSession,
  updateContext,
} from './clinicalEngine';
import type { ClinicalSession, ContextPatch, TranscriptTiming } from './types';

export type SessionAction =
  | { type: 'transcript'; transcript: string; timing: TranscriptTiming }
  | { type: 'context'; patch: ContextPatch; occurredAt: number }
  | { type: 'clear-current'; occurredAt: number }
  | { type: 'reset-session' };

export function sessionReducer(
  session: ClinicalSession,
  action: SessionAction,
): ClinicalSession {
  switch (action.type) {
    case 'transcript':
      return applyTranscript(session, action.transcript, action.timing);
    case 'context':
      return updateContext(session, action.patch, action.occurredAt);
    case 'clear-current':
      return clearCurrentRecord(session, action.occurredAt);
    case 'reset-session':
      return createInitialSession();
  }
}
