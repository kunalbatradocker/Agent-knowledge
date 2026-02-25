/**
 * VKGQuery — Standalone federated query page.
 * Natural language input, suggested questions, full results display
 * with context graph, reasoning trace, pipeline view, and SQL.
 */
import { useState, useEffect, useRef } from 'react';
import { useTenant } from '../contexts/TenantContext';
import ContextGraphView from './ContextGraphView';
import ReasoningTrace from './ReasoningTrace';
import './VKGQuery.css';

const SUGGESTED_QUESTIONS = [
  'Show me all customers with transactions over $10,000',
  'Which products have the highest revenue across all databases?',
  'List recent orders with customer and merchant details',
  'What are the top 5 categories by transaction count?',
];

/* Pipeline step definitions — mirrors the backend pipeline */
const PIPELINE_STEPS = [
  { key: 'context',  icon: '📚', label: 'Loading ontology + mappings from GraphDB' },
  { key: 'llm_plan', icon: '🤖', label: 'LLM generating plan + SQL' },
  { key: 'validate', icon: '✅', label: 'Validating SQL' },
  { key: 'trino',    icon: '🗄️', label: 'Executing on Trino' },
  { key: 'graph',    icon: '🕸️', label: 'Building context graph' },
  { key: 'answer',   icon: '💬', label: 'LLM generating answer' },
];

/* Simulated step timing — approximate durations to animate while waiting */
const STEP_DELAYS = [400, 0, 200, 0, 200, 0]; // ms before moving to next step (0 = wait for real response)

function VKGQuery() {
  const { currentWorkspace, getTenantHeaders } = useTenant();
  const [question, setQuestion] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [activeTab, setActiveTab] = useState('answer');
  const [pipelineStep, setPipelineStep] = useState(-1);
  const [elapsedMs, setElapsedMs] = useState(0);
  const timerRef = useRef(null);
  const startTimeRef = useRef(null);

  // Elapsed timer while loading
  useEffect(() => {
    if (loading) {
      startTimeRef.current = Date.now();
      timerRef.current = setInterval(() => {
        setElapsedMs(Date.now() - startTimeRef.current);
      }, 100);
    } else {
      clearInterval(timerRef.current);
    }
    return () => clearInterval(timerRef.current);
  }, [loading]);

  // Animate pipeline steps while loading
  useEffect(() => {
    if (!loading) { setPipelineStep(-1); return; }
    let step = 0;
    setPipelineStep(0);
    const timers = [];

    function advanceStep() {
      step++;
      if (step < PIPELINE_STEPS.length) {
        setPipelineStep(step);
        // Some steps advance quickly (validation), others wait for the real response
        if (STEP_DELAYS[step] > 0) {
          timers.push(setTimeout(advanceStep, STEP_DELAYS[step]));
        }
        // Steps with delay=0 stay until the response arrives
      }
    }
    // Start first timed advance
    if (STEP_DELAYS[0] > 0) {
      timers.push(setTimeout(advanceStep, STEP_DELAYS[0]));
    }

    return () => timers.forEach(clearTimeout);
  }, [loading]);

  const handleQuery = async (q) => {
    const queryText = q || question;
    if (!queryText.trim()) return;
    setLoading(true);
    setError(null);
    setResult(null);

    try {
      const res = await fetch('/api/vkg/query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getTenantHeaders() },
        body: JSON.stringify({
          question: queryText,
          workspaceId: currentWorkspace?.workspace_id || 'default'
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Query failed');
      if (data.error) throw new Error(data.error);
      setResult(data);
      setActiveTab('answer');
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  const formatMs = (ms) => {
    if (ms == null) return '—';
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
  };

  return (
    <div className="vkgq-container">
      <div className="vkgq-header">
        <h2>🌐 Federated Query</h2>
        <p>Ask questions across your connected databases using natural language</p>
      </div>

      <form className="vkgq-input-area" onSubmit={e => { e.preventDefault(); handleQuery(); }}>
        <input
          className="vkgq-input"
          value={question}
          onChange={e => setQuestion(e.target.value)}
          placeholder="Ask a question about your data..."
          disabled={loading}
        />
        <button type="submit" className="vkgq-submit" disabled={!question.trim() || loading}>
          {loading ? '⏳ Querying...' : '🔍 Query'}
        </button>
      </form>

      {/* Live pipeline progress while loading */}
      {loading && (
        <div className="vkgq-pipeline-live">
          <div className="vkgq-pipeline-header">
            <span className="vkgq-pipeline-spinner" />
            <span>Processing query...</span>
            <span className="vkgq-pipeline-elapsed">{formatMs(elapsedMs)}</span>
          </div>
          <div className="vkgq-pipeline-steps">
            {PIPELINE_STEPS.map((s, i) => (
              <div key={s.key} className={`vkgq-pl-step ${i < pipelineStep ? 'done' : i === pipelineStep ? 'active' : 'pending'}`}>
                <span className="vkgq-pl-icon">
                  {i < pipelineStep ? '✅' : i === pipelineStep ? s.icon : '⬜'}
                </span>
                <span className="vkgq-pl-label">{s.label}</span>
                {i === pipelineStep && <span className="vkgq-pl-dots" />}
              </div>
            ))}
          </div>
        </div>
      )}

      {!result && !loading && !error && (
        <div className="vkgq-suggestions">
          <p className="vkgq-suggestions-label">Try asking:</p>
          <div className="vkgq-suggestion-list">
            {SUGGESTED_QUESTIONS.map((q, i) => (
              <button key={i} className="vkgq-suggestion" onClick={() => { setQuestion(q); handleQuery(q); }}>
                {q}
              </button>
            ))}
          </div>
        </div>
      )}

      {error && <div className="vkgq-error">❌ {error}</div>}

      {result && (
        <div className="vkgq-results">
          <div className="vkgq-tabs">
            <button className={activeTab === 'answer' ? 'active' : ''} onClick={() => setActiveTab('answer')}>💬 Answer</button>
            <button className={activeTab === 'pipeline' ? 'active' : ''} onClick={() => setActiveTab('pipeline')}>⚡ Pipeline</button>
            <button className={activeTab === 'graph' ? 'active' : ''} onClick={() => setActiveTab('graph')}>🕸️ Graph</button>
            <button className={activeTab === 'trace' ? 'active' : ''} onClick={() => setActiveTab('trace')}>🧠 Reasoning</button>
            <button className={activeTab === 'sql' ? 'active' : ''} onClick={() => setActiveTab('sql')}>🔍 SQL</button>
          </div>

          <div className="vkgq-tab-content">
            {activeTab === 'answer' && (
              <div className="vkgq-answer-panel">
                <div className="vkgq-answer-text">{result.answer}</div>
                {result.execution_stats && (
                  <div className="vkgq-stats-bar">
                    <span>⏱️ {formatMs(result.execution_stats.total_ms)}</span>
                    <span>📊 {result.execution_stats.rows_returned} rows</span>
                    <span>🗄️ {result.execution_stats.databases_queried} database{result.execution_stats.databases_queried !== 1 ? 's' : ''}</span>
                    {result.execution_stats.trino_execution_ms != null && (
                      <span>⚡ Trino: {formatMs(result.execution_stats.trino_execution_ms)}</span>
                    )}
                    {result.warnings?.length > 0 && <span>⚠️ {result.warnings.length} warning(s)</span>}
                  </div>
                )}
                {result.citations?.databases?.length > 0 && (
                  <div className="vkgq-db-badges">
                    {result.citations.databases.map((db, i) => (
                      <span key={i} className="vkgq-db-badge">🗄️ {db}</span>
                    ))}
                  </div>
                )}
              </div>
            )}

            {activeTab === 'pipeline' && (
              <PipelineView pipeline={result.execution_pipeline} plan={result.plan} stats={result.execution_stats} />
            )}

            {activeTab === 'graph' && (
              <ContextGraphView graph={result.context_graph} provenance={result.context_graph?.provenance} />
            )}

            {activeTab === 'trace' && (
              <ReasoningTrace trace={result.reasoning_trace} pipeline={result.execution_pipeline} />
            )}

            {activeTab === 'sql' && (
              <div className="vkgq-sql-panel">
                <h3>Generated SQL</h3>
                <pre className="vkgq-sql-code">{result.citations?.sql || 'No SQL generated'}</pre>
                {result.plan && (
                  <>
                    <h3>Execution Plan</h3>
                    <pre className="vkgq-plan-code">{JSON.stringify(result.plan, null, 2)}</pre>
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/* ─── Pipeline Results View ─── */
function PipelineView({ pipeline, plan, stats }) {
  if (!pipeline?.steps?.length) return <div className="vkgq-pipeline-empty">No pipeline data available</div>;

  const totalMs = pipeline.total_time_ms;

  return (
    <div className="vkgq-pipeline-view">
      <div className="vkgq-pv-summary">
        <div className="vkgq-pv-total">
          <span className="vkgq-pv-total-label">Total Pipeline</span>
          <span className="vkgq-pv-total-value">{formatPipelineMs(totalMs)}</span>
        </div>
        {stats && (
          <div className="vkgq-pv-kpis">
            <div className="vkgq-pv-kpi">
              <span className="vkgq-pv-kpi-val">{stats.rows_returned}</span>
              <span className="vkgq-pv-kpi-label">Rows</span>
            </div>
            <div className="vkgq-pv-kpi">
              <span className="vkgq-pv-kpi-val">{stats.databases_queried}</span>
              <span className="vkgq-pv-kpi-label">Databases</span>
            </div>
            {stats.trino_execution_ms != null && (
              <div className="vkgq-pv-kpi">
                <span className="vkgq-pv-kpi-val">{formatPipelineMs(stats.trino_execution_ms)}</span>
                <span className="vkgq-pv-kpi-label">Trino</span>
              </div>
            )}
          </div>
        )}
      </div>

      <div className="vkgq-pv-steps">
        {pipeline.steps.map((step, i) => {
          const pct = totalMs > 0 ? Math.max(2, (step.duration_ms / totalMs) * 100) : 0;
          const isLLM = step.name.includes('LLM');
          const isFailed = step.status === 'failed';
          return (
            <div key={i} className={`vkgq-pv-step ${isFailed ? 'failed' : ''}`}>
              <div className="vkgq-pv-step-header">
                <span className="vkgq-pv-step-icon">
                  {isFailed ? '❌' : isLLM ? '🤖' : '✅'}
                </span>
                <span className="vkgq-pv-step-name">{step.name}</span>
                <span className="vkgq-pv-step-time">{formatPipelineMs(step.duration_ms)}</span>
              </div>
              <div className="vkgq-pv-bar-track">
                <div
                  className={`vkgq-pv-bar-fill ${isLLM ? 'llm' : ''} ${isFailed ? 'failed' : ''}`}
                  style={{ width: `${pct}%` }}
                />
              </div>
              {step.error && <div className="vkgq-pv-step-error">{step.error}</div>}
            </div>
          );
        })}
      </div>

      {plan && (
        <div className="vkgq-pv-plan">
          <h4>Query Plan</h4>
          <div className="vkgq-pv-plan-chips">
            {plan.entities?.map((e, i) => <span key={i} className="vkgq-pv-chip entity">{e}</span>)}
            {plan.relationships?.map((r, i) => <span key={i} className="vkgq-pv-chip rel">{r}</span>)}
            {plan.aggregation && <span className="vkgq-pv-chip agg">{plan.aggregation}</span>}
          </div>
          {plan.reasoning && <p className="vkgq-pv-plan-reasoning">{plan.reasoning}</p>}
        </div>
      )}
    </div>
  );
}

function formatPipelineMs(ms) {
  if (ms == null) return '—';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export default VKGQuery;
