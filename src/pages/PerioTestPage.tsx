import { RotateCcw, ShieldCheck } from 'lucide-react';
import type { FormEvent } from 'react';
import { CapturePanel } from '../components/CapturePanel';
import { ChartTable } from '../components/ChartTable';
import { ConfirmationsPanel } from '../components/ConfirmationsPanel';
import { FixtureRecorder } from '../components/FixtureRecorder';
import { HistoryPanel } from '../components/HistoryPanel';
import { MetricsPanel } from '../components/MetricsPanel';
import { StationPanel } from '../components/StationPanel';
import { ToothChart } from '../components/ToothChart';
import { WorkflowPanel } from '../components/WorkflowPanel';
import type { WorkflowCommand } from '../domain/grammar';
import type { ClinicalSession, PerioRecord, Surface, ToothRecord } from '../domain/types';
import type { AsrStatus } from '../speech/protocol';
import type { LocalAsrController } from '../speech/useLocalAsr';
import { usePageTitle } from './usePageTitle';

interface PerioTestPageProps {
  session: ClinicalSession;
  record: PerioRecord;
  tooth: ToothRecord;
  chartRows: PerioRecord[];
  speech: LocalAsrController;
  statusLabels: Record<AsrStatus, string>;
  examples: readonly string[];
  simulatedTranscript: string;
  onSimulatedChange: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onExample: (phrase: string) => void;
  onStart: () => void;
  showDeveloperTools: boolean;
  showFixtureRecorder: boolean;
  onChangeContext: (patch: { tooth?: number; surface?: Surface }) => void;
  onClear: () => void;
  onCommand: (command: WorkflowCommand) => void;
  onResetSession: () => void;
  onResolveConfirmation: (id: number, approve: boolean) => void;
}

export function PerioTestPage({
  session,
  record,
  tooth,
  chartRows,
  speech,
  statusLabels,
  examples,
  simulatedTranscript,
  onSimulatedChange,
  onSubmit,
  onExample,
  onStart,
  showDeveloperTools,
  showFixtureRecorder,
  onChangeContext,
  onClear,
  onCommand,
  onResetSession,
  onResolveConfirmation,
}: PerioTestPageProps) {
  const headingRef = usePageTitle('Perio test');

  return (
    <div className="page perio-page">
      <section aria-label="Tooth chart" data-testid="tooth-chart-slot">
        <ToothChart session={session} />
      </section>

      <header className="page-topbar">
        <span
          className={`system-status ${speech.listening ? 'is-live' : ''}`}
          data-status={speech.status}
        >
          <span className="status-dot" aria-hidden="true" />
          {statusLabels[speech.status]}
        </span>
        <button className="button button-quiet" type="button" onClick={onResetSession}>
          <RotateCcw size={16} aria-hidden="true" /> Reset session
        </button>
      </header>

      <section className="workspace-heading" aria-labelledby="page-title">
        <div>
          <p className="eyebrow">Live charting</p>
          <h1 id="page-title" tabIndex={-1} ref={headingRef}>Periodontal examination</h1>
          <p>Record measurements and findings while keeping the active tooth in view.</p>
        </div>
        <div className="trust-note">
          <ShieldCheck size={19} aria-hidden="true" />
          <span><strong>Clinical safeguards active</strong>Uncertain entries wait for review.</span>
        </div>
      </section>

      {showFixtureRecorder && <FixtureRecorder />}
      <ConfirmationsPanel pending={session.pending} onResolve={onResolveConfirmation} />

      <div className="dashboard-grid">
        <CapturePanel
          speech={speech}
          statusLabels={statusLabels}
          examples={examples}
          simulatedTranscript={simulatedTranscript}
          onSimulatedChange={onSimulatedChange}
          onSubmit={onSubmit}
          onExample={onExample}
          onStart={onStart}
          showDeveloperTools={showDeveloperTools}
        />
        <StationPanel
          session={session}
          record={record}
          tooth={tooth}
          onChangeContext={onChangeContext}
          onClear={onClear}
        />
        <div id="activity"><MetricsPanel session={session} cadence={speech.cadence} /></div>
        <HistoryPanel events={session.history} />
        <WorkflowPanel session={session} onCommand={onCommand} />
      </div>
      <ChartTable rows={chartRows} teeth={session.teeth} />
    </div>
  );
}
