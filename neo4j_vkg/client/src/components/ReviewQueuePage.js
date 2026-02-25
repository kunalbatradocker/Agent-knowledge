import { useState, useEffect, useCallback } from 'react';
import { useTenant } from '../contexts/TenantContext';
import { usePermissions } from '../hooks/usePermissions';
import './ReviewQueuePage.css';

const API_BASE_URL = '/api';

function ReviewQueuePage() {
  const { currentWorkspace } = useTenant();
  const { canUpload, isMember } = usePermissions();
  const [activeTab, setActiveTab] = useState('low_confidence');
  const [items, setItems] = useState([]);
  const [stats, setStats] = useState({ low_confidence: 0, candidates: 0, quarantined: 0, total: 0 });
  const [loading, setLoading] = useState(false);
  const [selectedItems, setSelectedItems] = useState(new Set());
  const [actionLoading, setActionLoading] = useState(false);

  const fetchStats = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (currentWorkspace?.workspace_id) {
        params.append('workspace_id', currentWorkspace.workspace_id);
      }
      const response = await fetch(`${API_BASE_URL}/review-queue/stats?${params}`);
      const data = await response.json();
      if (data.success) {
        setStats(data.stats);
      }
    } catch (error) {
      console.error('Error fetching stats:', error);
    }
  }, [currentWorkspace]);

  const fetchItems = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      params.append('type', activeTab.toUpperCase());
      params.append('status', 'pending');
      if (currentWorkspace?.workspace_id) {
        params.append('workspace_id', currentWorkspace.workspace_id);
      }
      
      const response = await fetch(`${API_BASE_URL}/review-queue?${params}`);
      const data = await response.json();
      if (data.success) {
        setItems(data.items || []);
      }
    } catch (error) {
      console.error('Error fetching items:', error);
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, [activeTab, currentWorkspace]);

  useEffect(() => {
    fetchStats();
    fetchItems();
  }, [fetchStats, fetchItems]);

  const handleSelectItem = (itemId) => {
    setSelectedItems(prev => {
      const newSet = new Set(prev);
      if (newSet.has(itemId)) {
        newSet.delete(itemId);
      } else {
        newSet.add(itemId);
      }
      return newSet;
    });
  };

  const handleSelectAll = () => {
    if (selectedItems.size === items.length) {
      setSelectedItems(new Set());
    } else {
      setSelectedItems(new Set(items.map(i => i.item_id)));
    }
  };

  const handleApprove = async (itemId) => {
    setActionLoading(true);
    try {
      const response = await fetch(`${API_BASE_URL}/review-queue/${itemId}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reviewer_id: 'current_user' })
      });
      const data = await response.json();
      if (data.success) {
        fetchItems();
        fetchStats();
      }
    } catch (error) {
      console.error('Error approving item:', error);
    } finally {
      setActionLoading(false);
    }
  };

  const handleReject = async (itemId) => {
    setActionLoading(true);
    try {
      const response = await fetch(`${API_BASE_URL}/review-queue/${itemId}/reject`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reviewer_id: 'current_user', reason: 'Rejected by user' })
      });
      const data = await response.json();
      if (data.success) {
        fetchItems();
        fetchStats();
      }
    } catch (error) {
      console.error('Error rejecting item:', error);
    } finally {
      setActionLoading(false);
    }
  };

  const handleBulkAction = async (action) => {
    if (selectedItems.size === 0) return;
    
    setActionLoading(true);
    try {
      const response = await fetch(`${API_BASE_URL}/review-queue/bulk`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          item_ids: Array.from(selectedItems),
          action,
          reviewer_id: 'current_user'
        })
      });
      const data = await response.json();
      if (data.success) {
        setSelectedItems(new Set());
        fetchItems();
        fetchStats();
      }
    } catch (error) {
      console.error('Error performing bulk action:', error);
    } finally {
      setActionLoading(false);
    }
  };

  const tabs = [
    { id: 'low_confidence', label: 'Low Confidence', count: stats.low_confidence, icon: '⚠️' },
    { id: 'candidate', label: 'Candidates', count: stats.candidates, icon: '📝' },
    { id: 'quarantined', label: 'Quarantined', count: stats.quarantined, icon: '🔒' }
  ];

  const getConfidenceColor = (confidence) => {
    if (confidence >= 0.7) return 'high';
    if (confidence >= 0.4) return 'medium';
    return 'low';
  };

  return (
    <div className="review-queue-page">
      <div className="review-queue-header">
        <div className="header-content">
          <h1>Review Queue</h1>
          <p>Review and approve entities that need human verification</p>
        </div>
        <div className="header-stats">
          <div className="stat-badge total">
            <span className="stat-value">{stats.total}</span>
            <span className="stat-label">Total Pending</span>
          </div>
        </div>
      </div>

      <div className="review-queue-tabs">
        {tabs.map(tab => (
          <button
            key={tab.id}
            className={`tab-button ${activeTab === tab.id ? 'active' : ''}`}
            onClick={() => setActiveTab(tab.id)}
          >
            <span className="tab-icon">{tab.icon}</span>
            <span className="tab-label">{tab.label}</span>
            <span className="tab-count">{tab.count}</span>
          </button>
        ))}
      </div>

      {selectedItems.size > 0 && isMember && (
        <div className="bulk-actions-bar">
          <span className="selected-count">{selectedItems.size} selected</span>
          <div className="bulk-buttons">
            <button 
              className="bulk-btn approve"
              onClick={() => handleBulkAction('approve')}
              disabled={actionLoading}
            >
              ✓ Approve All
            </button>
            <button 
              className="bulk-btn reject"
              onClick={() => handleBulkAction('reject')}
              disabled={actionLoading}
            >
              ✕ Reject All
            </button>
            <button 
              className="bulk-btn clear"
              onClick={() => setSelectedItems(new Set())}
            >
              Clear Selection
            </button>
          </div>
        </div>
      )}

      <div className="review-queue-content">
        {loading ? (
          <div className="loading-state">
            <div className="spinner"></div>
            <p>Loading review items...</p>
          </div>
        ) : items.length === 0 ? (
          <div className="empty-state">
            <span className="empty-icon">✨</span>
            <h3>All caught up!</h3>
            <p>No items pending review in this queue.</p>
          </div>
        ) : (
          <div className="review-items-list">
            <div className="list-header">
              <label className="select-all">
                <input
                  type="checkbox"
                  checked={selectedItems.size === items.length && items.length > 0}
                  onChange={handleSelectAll}
                />
                <span>Select All</span>
              </label>
              <span className="item-count">{items.length} items</span>
            </div>
            
            {items.map(item => (
              <div key={item.item_id} className={`review-item ${selectedItems.has(item.item_id) ? 'selected' : ''}`}>
                <div className="item-checkbox">
                  <input
                    type="checkbox"
                    checked={selectedItems.has(item.item_id)}
                    onChange={() => handleSelectItem(item.item_id)}
                  />
                </div>
                
                <div className="item-content">
                  <div className="item-header">
                    <span className="entity-label">{item.entity_data?.label || item.entity_data?.name || 'Unknown'}</span>
                    <span className="entity-type">{item.entity_data?.type || 'Unknown Type'}</span>
                    {item.confidence > 0 && (
                      <span className={`confidence-badge ${getConfidenceColor(item.confidence)}`}>
                        {Math.round(item.confidence * 100)}%
                      </span>
                    )}
                  </div>
                  
                  {item.entity_data?.description && (
                    <p className="item-description">{item.entity_data.description}</p>
                  )}
                  
                  <div className="item-meta">
                    {item.source_document_id && (
                      <span className="meta-item">
                        <span className="meta-icon">📄</span>
                        {item.source_document_id.substring(0, 8)}...
                      </span>
                    )}
                    <span className="meta-item">
                      <span className="meta-icon">🕐</span>
                      {new Date(item.created_at).toLocaleDateString()}
                    </span>
                  </div>
                </div>
                
                <div className="item-actions">
                  {isMember && (
                    <>
                      <button
                        className="action-btn approve"
                        onClick={() => handleApprove(item.item_id)}
                        disabled={actionLoading}
                        title="Approve"
                      >
                        ✓
                      </button>
                      <button
                        className="action-btn reject"
                        onClick={() => handleReject(item.item_id)}
                        disabled={actionLoading}
                        title="Reject"
                      >
                        ✕
                      </button>
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export default ReviewQueuePage;
