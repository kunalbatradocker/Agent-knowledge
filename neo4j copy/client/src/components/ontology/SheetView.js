import { useState, useEffect, useCallback, useRef } from 'react';
import { useTenant } from '../../contexts/TenantContext';
import { usePermissions } from '../../hooks/usePermissions';
import './SheetView.css';

export default function SheetView({ doc, onClose }) {
  const { getTenantHeaders } = useTenant();
  const { canUpload, canDelete } = usePermissions();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [entityTypes, setEntityTypes] = useState([]);
  const [selectedType, setSelectedType] = useState(null);
  const [page, setPage] = useState(0);
  const [search, setSearch] = useState('');
  const [columnFilters, setColumnFilters] = useState({}); // { colUri: filterText }
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [debouncedColFilters, setDebouncedColFilters] = useState({});
  const [editingCell, setEditingCell] = useState(null); // { rowUri, colUri, colLabel }
  const [editValue, setEditValue] = useState('');
  const [saving, setSaving] = useState(false);
  const [showAddRow, setShowAddRow] = useState(false);
  const [newRowData, setNewRowData] = useState({});
  const [showAudit, setShowAudit] = useState(false);
  const [auditLog, setAuditLog] = useState([]);
  const [error, setError] = useState(null);
  const editRef = useRef(null);
  const PAGE_SIZE = 100;

  const docId = doc.doc_id || doc.docId;

  // Debounce search and column filters
  useEffect(() => {
    const t = setTimeout(() => { setDebouncedSearch(search); setPage(0); }, 300);
    return () => clearTimeout(t);
  }, [search]);

  useEffect(() => {
    const t = setTimeout(() => { setDebouncedColFilters(columnFilters); setPage(0); }, 300);
    return () => clearTimeout(t);
  }, [columnFilters]);

  const loadData = useCallback(async (typeUri) => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ limit: PAGE_SIZE, offset: page * PAGE_SIZE });
      if (typeUri) params.set('type', typeUri);
      if (debouncedSearch) params.set('search', debouncedSearch);
      const activeColFilters = Object.fromEntries(Object.entries(debouncedColFilters).filter(([, v]) => v));
      if (Object.keys(activeColFilters).length) params.set('columnFilters', JSON.stringify(activeColFilters));
      const res = await fetch(`/api/ontology/sheet-data/${docId}?${params}`, { headers: getTenantHeaders() });
      const result = await res.json();
      if (!result.success) throw new Error(result.error);
      setData(result);
      setEntityTypes(result.entityTypes || []);
      if (!selectedType && result.selectedType) setSelectedType(result.selectedType.uri);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [docId, page, getTenantHeaders, selectedType, debouncedSearch, debouncedColFilters]);

  useEffect(() => { loadData(selectedType); }, [selectedType, page, debouncedSearch, debouncedColFilters]);

  useEffect(() => {
    if (editingCell && editRef.current) editRef.current.focus();
  }, [editingCell]);

  const saveCell = async () => {
    if (!editingCell) return;
    setSaving(true);
    try {
      const row = data.rows.find(r => r._uri === editingCell.rowUri);
      const oldValue = row?.[editingCell.colLabel] ?? '';
      if (editValue === oldValue) { setEditingCell(null); setSaving(false); return; }

      const res = await fetch(`/api/ontology/sheet-data/${docId}/cell`, {
        method: 'PUT',
        headers: { ...getTenantHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          entityUri: editingCell.rowUri,
          propertyUri: editingCell.colUri,
          oldValue,
          newValue: editValue
        })
      });
      const result = await res.json();
      if (!result.success) throw new Error(result.error);
      // Update local state
      setData(prev => ({
        ...prev,
        rows: prev.rows.map(r => r._uri === editingCell.rowUri ? { ...r, [editingCell.colLabel]: editValue } : r)
      }));
      setEditingCell(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  const addRow = async () => {
    if (!selectedType) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/ontology/sheet-data/${docId}/row`, {
        method: 'POST',
        headers: { ...getTenantHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ typeUri: selectedType, properties: newRowData })
      });
      const result = await res.json();
      if (!result.success) throw new Error(result.error);
      setShowAddRow(false);
      setNewRowData({});
      loadData(selectedType);
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  const deleteRow = async (entityUri) => {
    if (!window.confirm('Delete this row? This cannot be undone.')) return;
    try {
      const res = await fetch(`/api/ontology/sheet-data/${docId}/row`, {
        method: 'DELETE',
        headers: { ...getTenantHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ entityUri })
      });
      const result = await res.json();
      if (!result.success) throw new Error(result.error);
      loadData(selectedType);
    } catch (e) {
      setError(e.message);
    }
  };

  const loadAudit = async () => {
    try {
      const res = await fetch(`/api/ontology/sheet-data/${docId}/audit?limit=100`, { headers: getTenantHeaders() });
      const result = await res.json();
      if (result.success) setAuditLog(result.entries || []);
    } catch (e) { console.error(e); }
    setShowAudit(true);
  };

  const columns = data?.columns || [];
  const rows = data?.rows || [];
  const hasActiveFilters = search || Object.values(columnFilters).some(v => v);

  const handleKeyDown = (e) => {
    if (e.key === 'Enter') saveCell();
    if (e.key === 'Escape') setEditingCell(null);
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="sheet-modal" onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="sheet-header">
          <div className="sheet-title">
            <h3>📊 {doc.title || 'Sheet View'}</h3>
            <span className="sheet-subtitle">{data?.total || 0} entities · {columns.length} properties{hasActiveFilters ? ' (filtered)' : ''}</span>
          </div>
          <div className="sheet-toolbar">
            <div className="sheet-search-wrap">
              <input type="text" placeholder="Search all columns..." value={search} onChange={e => setSearch(e.target.value)} className="sheet-search" />
              {hasActiveFilters && (
                <button className="search-clear" onClick={() => { setSearch(''); setColumnFilters({}); }} title="Clear all filters">✕</button>
              )}
            </div>
            <button className="btn-sm" onClick={() => setShowAddRow(true)} title="Add row" disabled={!canUpload}>+ Row</button>
            <button className="btn-sm" onClick={loadAudit} title="Audit history">📋 History</button>
            <button className="btn-close" onClick={onClose}>✕</button>
          </div>
        </div>

        {/* Entity type tabs */}
        {entityTypes.length > 0 && (
          <div className="sheet-type-tabs">
            {entityTypes.map(et => (
              <button
                key={et.uri}
                className={`type-tab ${selectedType === et.uri ? 'active' : ''}`}
                onClick={() => { setSelectedType(et.uri); setPage(0); }}
              >
                {et.label} <span className="tab-count">{et.count}</span>
              </button>
            ))}
          </div>
        )}

        {error && <div className="sheet-error">{error} <button onClick={() => setError(null)}>✕</button></div>}

        {/* Table */}
        <div className="sheet-body">
          {loading ? (
            <div className="sheet-loading">Loading...</div>
          ) : rows.length === 0 ? (
            <div className="sheet-empty">No data found{hasActiveFilters ? ' matching filters' : ''}</div>
          ) : (
            <table className="sheet-table">
              <thead>
                <tr>
                  <th className="row-num">#</th>
                  {columns.map(col => (
                    <th key={col.uri} title={col.uri}>{col.label}</th>
                  ))}
                  <th className="row-actions">Actions</th>
                </tr>
                <tr className="filter-row">
                  <th className="row-num">🔍</th>
                  {columns.map(col => (
                    <th key={`f-${col.uri}`}>
                      <input
                        type="text"
                        className="col-filter"
                        placeholder="Filter..."
                        value={columnFilters[col.uri] || ''}
                        onChange={e => setColumnFilters(prev => ({ ...prev, [col.uri]: e.target.value }))}
                      />
                    </th>
                  ))}
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row, i) => (
                  <tr key={row._uri}>
                    <td className="row-num">{page * PAGE_SIZE + i + 1}</td>
                    {columns.map(col => {
                      const isEditing = editingCell?.rowUri === row._uri && editingCell?.colUri === col.uri;
                      const val = row[col.label] ?? '';
                      const isRef = row[`_ref_${col.label}`];
                      return (
                        <td
                          key={col.uri}
                          className={`sheet-cell ${isRef ? 'ref-cell' : ''} ${isEditing ? 'editing' : ''}`}
                          onDoubleClick={() => {
                            if (col.label === 'sourceDocument') return;
                            if (!canUpload) return;
                            setEditingCell({ rowUri: row._uri, colUri: col.uri, colLabel: col.label });
                            setEditValue(val);
                          }}
                        >
                          {isEditing ? (
                            <input
                              ref={editRef}
                              className="cell-input"
                              value={editValue}
                              onChange={e => setEditValue(e.target.value)}
                              onBlur={saveCell}
                              onKeyDown={handleKeyDown}
                              disabled={saving}
                            />
                          ) : (
                            <span className="cell-value" title={val}>{val}</span>
                          )}
                        </td>
                      );
                    })}
                    <td className="row-actions">
                      {canDelete && <button className="btn-tiny-delete" onClick={() => deleteRow(row._uri)} title="Delete row">🗑️</button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* Pagination */}
        {data && data.total > PAGE_SIZE && (
          <div className="sheet-pagination">
            <button disabled={page === 0} onClick={() => setPage(p => p - 1)}>← Prev</button>
            <span>Page {page + 1} of {Math.ceil(data.total / PAGE_SIZE)}</span>
            <button disabled={(page + 1) * PAGE_SIZE >= data.total} onClick={() => setPage(p => p + 1)}>Next →</button>
          </div>
        )}

        {/* Add Row Modal */}
        {showAddRow && (
          <div className="sheet-add-row-overlay" onClick={() => setShowAddRow(false)}>
            <div className="sheet-add-row" onClick={e => e.stopPropagation()}>
              <h4>Add New {data?.selectedType?.label || 'Entity'}</h4>
              <div className="add-row-fields">
                {columns.filter(c => c.label !== 'sourceDocument').map(col => (
                  <div key={col.uri} className="add-row-field">
                    <label>{col.label}</label>
                    <input
                      type="text"
                      value={newRowData[col.uri] || ''}
                      onChange={e => setNewRowData(prev => ({ ...prev, [col.uri]: e.target.value }))}
                      placeholder={col.label}
                    />
                  </div>
                ))}
              </div>
              <div className="add-row-actions">
                <button className="btn-sm" onClick={() => setShowAddRow(false)}>Cancel</button>
                <button className="btn-sm btn-primary" onClick={addRow} disabled={saving}>
                  {saving ? 'Adding...' : 'Add Row'}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Audit Log Panel */}
        {showAudit && (
          <div className="sheet-audit-overlay" onClick={() => setShowAudit(false)}>
            <div className="sheet-audit-panel" onClick={e => e.stopPropagation()}>
              <div className="audit-header">
                <h4>📋 Change History</h4>
                <button className="btn-close" onClick={() => setShowAudit(false)}>✕</button>
              </div>
              <div className="audit-list">
                {auditLog.length === 0 ? (
                  <div className="sheet-empty">No changes recorded yet</div>
                ) : auditLog.map(entry => (
                  <div key={entry.id} className={`audit-entry audit-${entry.action}`}>
                    <div className="audit-meta">
                      <span className="audit-action">
                        {entry.action === 'update_cell' && '✏️ Updated'}
                        {entry.action === 'add_row' && '➕ Added row'}
                        {entry.action === 'delete_row' && '🗑️ Deleted row'}
                      </span>
                      <span className="audit-time">{new Date(entry.timestamp).toLocaleString()}</span>
                    </div>
                    {(entry.entityLabel || entry.entityType) && (
                      <div className="audit-entity">
                        {entry.entityType && <span className="audit-entity-type">{entry.entityType}</span>}
                        <span className="audit-entity-label">{entry.entityLabel || '(unknown)'}</span>
                      </div>
                    )}
                    {entry.action === 'update_cell' && (
                      <div className="audit-detail">
                        <span className="audit-prop">{entry.property}</span>:
                        <span className="audit-old">{entry.oldValue || '(empty)'}</span> →
                        <span className="audit-new">{entry.newValue}</span>
                      </div>
                    )}
                    {entry.action === 'delete_row' && (
                      <div className="audit-detail">
                        <span className="audit-prop">{entry.property}</span>:
                        <span className="audit-old">{entry.oldValue || '(empty)'}</span>
                      </div>
                    )}
                    {entry.action === 'add_row' && entry.property && (
                      <div className="audit-detail">
                        <span className="audit-prop">{entry.property}</span>:
                        <span className="audit-new">{entry.newValue}</span>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
