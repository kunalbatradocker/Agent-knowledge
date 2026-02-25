import React, { useState, useEffect } from 'react';

/**
 * Cross-Source Relationship Editor
 * Allows defining relationships between entities from different data sources
 */
const CrossSourceEditor = ({ sources = [], onSave }) => {
  const [relationships, setRelationships] = useState([]);
  const [suggestions, setSuggestions] = useState([]);
  const [loading, setLoading] = useState(false);
  const [selectedSource1, setSelectedSource1] = useState('');
  const [selectedSource2, setSelectedSource2] = useState('');
  const [entities1, setEntities1] = useState([]);
  const [entities2, setEntities2] = useState([]);

  // Load entities when sources change
  useEffect(() => {
    if (selectedSource1) loadEntities(selectedSource1, setEntities1);
  }, [selectedSource1]);

  useEffect(() => {
    if (selectedSource2) loadEntities(selectedSource2, setEntities2);
  }, [selectedSource2]);

  // Auto-suggest relationships when both sources selected
  useEffect(() => {
    if (entities1.length > 0 && entities2.length > 0) {
      suggestRelationships();
    }
  }, [entities1, entities2]);

  const loadEntities = async (sourceId, setter) => {
    try {
      const res = await fetch(`/api/entities?sourceId=${sourceId}&limit=100`, {
        headers: { 'x-tenant-id': 'default', 'x-workspace-id': 'default' }
      });
      const data = await res.json();
      setter(data.entities || []);
    } catch (err) {
      console.error('Failed to load entities:', err);
      setter([]);
    }
  };

  const suggestRelationships = () => {
    const suggested = [];
    
    // Find entities with similar names/types across sources
    for (const e1 of entities1) {
      for (const e2 of entities2) {
        const similarity = calculateSimilarity(e1, e2);
        if (similarity > 0.5) {
          suggested.push({
            sourceEntity: e1,
            targetEntity: e2,
            similarity,
            suggestedName: `relatesTo${e2.type || 'Entity'}`,
            reason: similarity > 0.8 ? 'High name similarity' : 'Potential match'
          });
        }
      }
    }
    
    setSuggestions(suggested.sort((a, b) => b.similarity - a.similarity).slice(0, 10));
  };

  const calculateSimilarity = (e1, e2) => {
    const name1 = (e1.label || e1.name || '').toLowerCase();
    const name2 = (e2.label || e2.name || '').toLowerCase();
    const type1 = (e1.type || '').toLowerCase();
    const type2 = (e2.type || '').toLowerCase();
    
    // Simple similarity based on common words
    const words1 = new Set(name1.split(/\W+/));
    const words2 = new Set(name2.split(/\W+/));
    const common = [...words1].filter(w => words2.has(w) && w.length > 2);
    
    let score = common.length / Math.max(words1.size, words2.size, 1);
    
    // Boost if types match
    if (type1 && type2 && type1 === type2) score += 0.3;
    
    return Math.min(score, 1);
  };

  const addRelationship = (rel = {}) => {
    setRelationships([...relationships, {
      id: Date.now(),
      sourceEntity: rel.sourceEntity || null,
      targetEntity: rel.targetEntity || null,
      relationshipName: rel.suggestedName || '',
      bidirectional: false,
      ...rel
    }]);
  };

  const updateRelationship = (id, field, value) => {
    setRelationships(relationships.map(r => 
      r.id === id ? { ...r, [field]: value } : r
    ));
  };

  const removeRelationship = (id) => {
    setRelationships(relationships.filter(r => r.id !== id));
  };

  const handleSave = async () => {
    if (relationships.length === 0) return;
    
    setLoading(true);
    try {
      for (const rel of relationships) {
        if (!rel.sourceEntity || !rel.targetEntity || !rel.relationshipName) continue;
        
        await fetch('/api/ontology/relationships', {
          method: 'POST',
          headers: { 
            'Content-Type': 'application/json',
            'x-tenant-id': 'default', 
            'x-workspace-id': 'default' 
          },
          body: JSON.stringify({
            sourceClass: rel.sourceEntity.typeUri || rel.sourceEntity.type,
            sourceSchema: selectedSource1,
            targetClass: rel.targetEntity.typeUri || rel.targetEntity.type,
            targetSchema: selectedSource2,
            relationshipName: rel.relationshipName,
            relationshipType: 'object_property',
            inverse: rel.bidirectional
          })
        });
      }
      
      if (onSave) onSave(relationships);
      alert('Cross-source relationships saved!');
    } catch (err) {
      console.error('Failed to save relationships:', err);
      alert('Failed to save: ' + err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="p-4 bg-white rounded-lg shadow">
      <h2 className="text-xl font-bold mb-4">Cross-Source Relationship Editor</h2>
      <p className="text-gray-600 mb-4">
        Define relationships between entities from different data sources
      </p>

      {/* Source Selection */}
      <div className="grid grid-cols-2 gap-4 mb-6">
        <div>
          <label className="block text-sm font-medium mb-1">Source 1</label>
          <select 
            className="w-full p-2 border rounded"
            value={selectedSource1}
            onChange={(e) => setSelectedSource1(e.target.value)}
          >
            <option value="">Select source...</option>
            {sources.map(s => (
              <option key={s.id} value={s.id}>{s.name || s.id}</option>
            ))}
          </select>
          {entities1.length > 0 && (
            <p className="text-sm text-gray-500 mt-1">{entities1.length} entities</p>
          )}
        </div>
        <div>
          <label className="block text-sm font-medium mb-1">Source 2</label>
          <select 
            className="w-full p-2 border rounded"
            value={selectedSource2}
            onChange={(e) => setSelectedSource2(e.target.value)}
          >
            <option value="">Select source...</option>
            {sources.map(s => (
              <option key={s.id} value={s.id}>{s.name || s.id}</option>
            ))}
          </select>
          {entities2.length > 0 && (
            <p className="text-sm text-gray-500 mt-1">{entities2.length} entities</p>
          )}
        </div>
      </div>

      {/* Suggestions */}
      {suggestions.length > 0 && (
        <div className="mb-6">
          <h3 className="font-medium mb-2">Suggested Relationships</h3>
          <div className="space-y-2 max-h-48 overflow-y-auto">
            {suggestions.map((s, i) => (
              <div key={i} className="flex items-center justify-between p-2 bg-blue-50 rounded">
                <div className="flex-1">
                  <span className="font-medium">{s.sourceEntity.label || s.sourceEntity.name}</span>
                  <span className="mx-2 text-gray-400">→</span>
                  <span className="font-medium">{s.targetEntity.label || s.targetEntity.name}</span>
                  <span className="ml-2 text-sm text-gray-500">({Math.round(s.similarity * 100)}% match)</span>
                </div>
                <button 
                  onClick={() => addRelationship(s)}
                  className="px-3 py-1 bg-blue-600 text-white text-sm rounded hover:bg-blue-700"
                >
                  Add
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Manual Relationship Definition */}
      <div className="mb-6">
        <div className="flex justify-between items-center mb-2">
          <h3 className="font-medium">Defined Relationships</h3>
          <button 
            onClick={() => addRelationship()}
            className="text-sm text-blue-600 hover:underline"
          >
            + Add Manual
          </button>
        </div>

        {relationships.length === 0 ? (
          <p className="text-gray-500 text-sm">No relationships defined yet</p>
        ) : (
          <div className="space-y-3">
            {relationships.map(rel => (
              <div key={rel.id} className="p-3 border rounded bg-gray-50">
                <div className="grid grid-cols-3 gap-2 mb-2">
                  <select
                    className="p-2 border rounded text-sm"
                    value={rel.sourceEntity?.id || ''}
                    onChange={(e) => {
                      const entity = entities1.find(en => en.id === e.target.value);
                      updateRelationship(rel.id, 'sourceEntity', entity);
                    }}
                  >
                    <option value="">Source Entity</option>
                    {entities1.map(e => (
                      <option key={e.id} value={e.id}>{e.label || e.name}</option>
                    ))}
                  </select>
                  
                  <input
                    className="p-2 border rounded text-sm"
                    placeholder="Relationship name"
                    value={rel.relationshipName}
                    onChange={(e) => updateRelationship(rel.id, 'relationshipName', e.target.value)}
                  />
                  
                  <select
                    className="p-2 border rounded text-sm"
                    value={rel.targetEntity?.id || ''}
                    onChange={(e) => {
                      const entity = entities2.find(en => en.id === e.target.value);
                      updateRelationship(rel.id, 'targetEntity', entity);
                    }}
                  >
                    <option value="">Target Entity</option>
                    {entities2.map(e => (
                      <option key={e.id} value={e.id}>{e.label || e.name}</option>
                    ))}
                  </select>
                </div>
                
                <div className="flex items-center justify-between">
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={rel.bidirectional}
                      onChange={(e) => updateRelationship(rel.id, 'bidirectional', e.target.checked)}
                    />
                    Bidirectional
                  </label>
                  <button 
                    onClick={() => removeRelationship(rel.id)}
                    className="text-red-500 text-sm hover:underline"
                  >
                    Remove
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Save Button */}
      <button
        onClick={handleSave}
        disabled={loading || relationships.length === 0}
        className="w-full py-2 bg-green-600 text-white rounded hover:bg-green-700 disabled:bg-gray-400"
      >
        {loading ? 'Saving...' : `Save ${relationships.length} Relationship(s)`}
      </button>
    </div>
  );
};

export default CrossSourceEditor;
