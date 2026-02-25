/**
 * ReasoningTrace — Collapsible step-by-step evidence chain display.
 * Shows how the VKG query engine derived its answer.
 */
import { useState } from 'react';
import './ReasoningTrace.css';

function ReasoningTrace({ trace = [], pipeline = {} }) {
  const [expandedSteps, setExpandedSteps] = useState(new Set());

  const toggleStep = (idx) => {
    setExpandedSteps(prev => {
      const next = new Set(prev);
      next.has(idx) ? next.delete(idx) : next.add(idx);
      return next;
    });
  };

  if (!trace || trace.length === 0) return null;

  return (
    <div className="rt-container">
      <h3 className="rt-title">🧠 Reasoning Trace</h3>

      <div className="rt-timeline">
        {trace.map((step, i) => (
          <div key={i} className="rt-step" onClick={() => toggleStep(i)}>
            <div className="rt-step-header">
              <span className="rt-step-num">{i + 1}</span>
              <span className="rt-step-text">{step.step}</span>
              <span className="rt-step-toggle">{expandedSteps.has(i) ? '▼' : '▶'}</span>
            </div>

            {expandedSteps.has(i) && (
              <div className="rt-step-details">
                {step.evidence?.length > 0 && (
                  <div className="rt-evidence">
                    <span className="rt-detail-label">Evidence:</span>
                    <div className="rt-evidence-items">
                      {step.evidence.map((e, j) => (
                        <span key={j} className="rt-evidence-item">{e}</span>
                      ))}
                    </div>
                  </div>
                )}
                {step.sources?.length > 0 && (
                  <div className="rt-sources">
                    <span className="rt-detail-label">Sources:</span>
                    {step.sources.map((s, j) => (
                      <span key={j} className="rt-source-badge">🗄️ {s}</span>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        ))}
      </div>

      {pipeline?.steps?.length > 0 && (
        <div className="rt-pipeline">
          <h4 className="rt-pipeline-title">⚙️ Execution Pipeline</h4>
          <div className="rt-pipeline-bar">
            {pipeline.steps.map((step, i) => {
              const pct = pipeline.total_time_ms > 0
                ? Math.max(2, (step.duration_ms / pipeline.total_time_ms) * 100)
                : 100 / pipeline.steps.length;
              return (
                <div
                  key={i}
                  className={`rt-pipe-segment ${step.status}`}
                  style={{ width: `${pct}%` }}
                  title={`${step.name}: ${step.duration_ms}ms (${step.status})`}
                />
              );
            })}
          </div>
          <div className="rt-pipeline-legend">
            {pipeline.steps.map((step, i) => (
              <div key={i} className="rt-pipe-item">
                <span className={`rt-pipe-dot ${step.status}`} />
                <span className="rt-pipe-name">{step.name}</span>
                <span className="rt-pipe-ms">{step.duration_ms}ms</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default ReasoningTrace;
