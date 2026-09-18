import {
  applyTranscript,
  clearCurrentRecord,
  createInitialSession,
  updateContext,
} from './clinicalEngine';
import { processAutoChart } from './autoChart';
import { applyWorkflowCommand, resolveConfirmation } from './pipeline';
import type { WorkflowCommand } from './grammar';
import type {
  ClinicalSession,
  ContextPatch,
  SessionSettings,
  TranscriptTiming,
  UtteranceInput,
} from './types';

/**
 * The only chart transition boundary.
 *
 * Every path into the chart — speech, the simulator, a button, an approved
 * confirmation — arrives here, so there is exactly one place where clinical
 * state changes and exactly one place to audit.
 */
export type SessionAction =
  | { type: 'transcript'; transcript: string; timing: TranscriptTiming }
  | { type: 'utterance'; input: UtteranceInput }
  | { type: 'context'; patch: ContextPatch; occurredAt: number }
  | { type: 'clear-current'; occurredAt: number }
  | { type: 'workflow'; command: WorkflowCommand; occurredAt: number }
  | { type: 'confirmation'; id: number; approve: boolean; occurredAt: number }
  | { type: 'settings'; patch: Partial<SessionSettings> }
  | { type: 'reset-session'; settings?: Partial<SessionSettings> };

export function sessionReducer(
  session: ClinicalSession,
  action: SessionAction,
): ClinicalSession {
  switch (action.type) {
    case 'transcript':
      return applyTranscript(session, action.transcript, action.timing);
    case 'utterance':
      return processAutoChart(session, action.input).session;
    case 'context':
      return updateContext(session, action.patch, action.occurredAt);
    case 'clear-current':
      return clearCurrentRecord(session, action.occurredAt);
    case 'workflow':
      return applyWorkflowCommand(session, action.command, action.occurredAt);
    case 'confirmation':
      return resolveConfirmation(session, action.id, action.approve, action.occurredAt);
    case 'settings':
      return { ...session, settings: { ...session.settings, ...action.patch } };
    case 'reset-session':
      return createInitialSession(action.settings ?? session.settings);
  }
}
