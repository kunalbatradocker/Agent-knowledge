import React, { useState } from 'react';
import EntityRegistry from './EntityRegistry';
import EntityDetail from './EntityDetail';
import EntityGraphView from './EntityGraphView';
import './EntitiesPage.css';

/**
 * EntitiesPage Component
 * Main page for entity management
 * 
 * Views:
 * - registry: Tabular list of entities (default)
 * - detail: Single entity detail view
 * - graph: Contextual graph visualization
 * 
 * TERMINOLOGY:
 * - This is the DATA/Graph UI - manages Entities (instances)
 * - Ontology UI (OntologyManager) manages Classes (types)
 */
const EntitiesPage = () => {
  const [view, setView] = useState('registry'); // 'registry' | 'detail' | 'graph'
  const [selectedEntity, setSelectedEntity] = useState(null);

  // Handle entity selection from registry
  const handleSelectEntity = (entity) => {
    setSelectedEntity(entity);
    setView('detail');
  };

  // Handle back to registry
  const handleBackToRegistry = () => {
    setSelectedEntity(null);
    setView('registry');
  };

  // Handle view graph
  const handleViewGraph = (entity) => {
    setSelectedEntity(entity);
    setView('graph');
  };

  // Handle back to detail from graph
  const handleBackToDetail = () => {
    setView('detail');
  };

  // Handle entity selection from graph
  const handleGraphSelectEntity = (entity) => {
    setSelectedEntity(entity);
    setView('detail');
  };

  return (
    <div className="entities-page">
      {view === 'registry' && (
        <EntityRegistry onSelectEntity={handleSelectEntity} />
      )}
      
      {view === 'detail' && selectedEntity && (
        <EntityDetail
          entityId={selectedEntity.entityId}
          onClose={handleBackToRegistry}
          onViewGraph={handleViewGraph}
        />
      )}
      
      {view === 'graph' && selectedEntity && (
        <EntityGraphView
          entity={selectedEntity}
          onClose={handleBackToDetail}
          onSelectEntity={handleGraphSelectEntity}
        />
      )}
    </div>
  );
};

export default EntitiesPage;
