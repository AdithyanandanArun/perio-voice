import { useState } from 'react';
import { PerioGraphs } from '../components/PerioGraphs';
import { createInitialSession } from '../domain/session';
import type { ClinicalSession } from '../domain/types';
import { APP_VERSION } from '../export/perioRows';
import { usePageTitle } from './usePageTitle';

interface GraphPageProps {
  /** Omitted only when the workspace hasn't wired a live session through yet. */
  session?: ClinicalSession;
  /** The signed-in clinician's display name, written into the "Exam" sheet. */
  clinicianName?: string | null;
}

export function GraphPage({ session, clinicianName = null }: GraphPageProps) {
  const headingRef = usePageTitle('Graph');
  const [fallbackSession] = useState<ClinicalSession>(() => createInitialSession());
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const activeSession = session ?? fallbackSession;

  const handleDownload = () => {
    setDownloading(true);
    setDownloadError(null);
    void import('../export/downloadPerioChart')
      .then(({ downloadPerioChart }) =>
        downloadPerioChart(activeSession, {
          examDate: new Date(),
          clinicianName,
          appVersion: APP_VERSION,
        }),
      )
      .catch(() => {
        setDownloadError('The Excel file could not be generated. Try again.');
      })
      .finally(() => {
        setDownloading(false);
      });
  };

  return (
    <div className="page graph-page">
      <div className="workspace-heading">
        <div>
          <p className="eyebrow">Session analytics</p>
          <h1 id="page-title" tabIndex={-1} ref={headingRef}>Graph</h1>
          <p>Charted trends and exports for this session.</p>
        </div>
        <button
          type="button"
          className="button button-primary"
          onClick={handleDownload}
          disabled={downloading}
          aria-label="Download Excel"
        >
          {downloading ? 'Preparing Excel…' : 'Download Excel'}
        </button>
      </div>
      {downloadError && (
        <p role="alert" style={{ color: 'var(--danger)' }}>{downloadError}</p>
      )}
      <section aria-label="Session charts" data-testid="graph-slot">
        <PerioGraphs session={activeSession} />
      </section>
    </div>
  );
}
