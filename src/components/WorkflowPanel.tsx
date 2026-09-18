import { ChevronLeft, ChevronRight, CornerUpLeft, Map, Redo2, SkipForward, Undo2 } from 'lucide-react';
import { QUADRANT_LABELS, workflowProgress } from '../domain/workflow';
import { redoableEntry, undoableEntry } from '../domain/journal';
import type { WorkflowCommand } from '../domain/grammar';
import type { ClinicalSession } from '../domain/types';

interface WorkflowPanelProps {
  session: ClinicalSession;
  onCommand: (command: WorkflowCommand) => void;
}

export function WorkflowPanel({
  session,
  onCommand,
}: WorkflowPanelProps) {
  const progress = workflowProgress(session.context, session.workflow, session.charts);
  const canUndo = undoableEntry(session.journal) !== null;
  const canRedo = redoableEntry(session.journal) !== null;
  const percent = progress.totalSites === 0
    ? 0
    : Math.round((progress.completedSites / progress.totalSites) * 100);

  return (
    <section className="panel workflow-panel" aria-labelledby="workflow-title">
      <div className="panel-heading compact">
        <div>
          <p className="section-index">05 · POSITION</p>
          <h2 id="workflow-title">Full-mouth workflow</h2>
        </div>
        <Map size={20} aria-hidden="true" />
      </div>

      <div className="workflow-position">
        <div>
          <span>Station</span>
          <strong>
            {progress.stationIndex + 1} of {progress.stationCount}
          </strong>
          <small>
            {QUADRANT_LABELS[progress.quadrant]} · tooth {session.context.tooth}{' '}
            {session.context.surface}
          </small>
        </div>
        <div
          className="progress-track"
          role="progressbar"
          aria-label="Full-mouth charting progress"
          aria-valuemin={0}
          aria-valuemax={progress.totalSites}
          aria-valuenow={progress.completedSites}
          aria-valuetext={`${progress.completedSites} of ${progress.totalSites} sites recorded`}
        >
          <span style={{ transform: `scaleX(${percent / 100})` }} />
        </div>
        <small>
          {progress.completedSites} of {progress.totalSites} sites · {progress.completedStations}{' '}
          station{progress.completedStations === 1 ? '' : 's'} complete
        </small>
      </div>

      <div className="workflow-controls" aria-label="Workflow controls">
        <button type="button" onClick={() => onCommand('back')}>
          <ChevronLeft size={16} aria-hidden="true" />
          Previous tooth
        </button>
        <button type="button" onClick={() => onCommand('next')}>
          <ChevronRight size={16} aria-hidden="true" />
          Next tooth
        </button>
        <button type="button" onClick={() => onCommand('skip')}>
          <SkipForward size={16} aria-hidden="true" />
          Skip tooth
        </button>
        <button type="button" onClick={() => onCommand('resume')} disabled={!progress.resumable}>
          <CornerUpLeft size={16} aria-hidden="true" />
          Resume
        </button>
        <button type="button" onClick={() => onCommand('undo')} disabled={!canUndo}>
          <Undo2 size={16} aria-hidden="true" />
          Undo
        </button>
        <button type="button" onClick={() => onCommand('redo')} disabled={!canRedo}>
          <Redo2 size={16} aria-hidden="true" />
          Redo
        </button>
      </div>

      {progress.skipped.length > 0 && (
        <p className="skipped-teeth">
          Marked absent: {progress.skipped.join(', ')}
        </p>
      )}
    </section>
  );
}
