/**
 * OntologyTTLViewer Component
 * Displays ontology in Turtle (TTL) format with syntax highlighting
 */

import { useState, useEffect } from 'react';
import './OntologyTTLViewer.css';

const OntologyTTLViewer = ({ ontology, tenantId, workspaceId }) => {
  const [ttlContent, setTtlContent] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [viewMode, setViewMode] = useState('formatted'); // 'formatted' or 'raw'
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (ontology && (ontology.iri || ontology.ontologyId)) {
      fetchTTL();
    }
  }, [ontology, tenantId, workspaceId]);

  const fetchTTL = async () => {
    setLoading(true);
    setError(null);
    
    try {
      const params = new URLSearchParams({
        tenantId: tenantId || 'default',
        workspaceId: workspaceId || 'default',
        exportType: 'schema',
        scope: ontology?.scope || 'workspace'
      });

      // If ontology has an ID, add it to export only that ontology
      if (ontology?.ontologyId) {
        params.append('ontologyId', ontology.ontologyId);
      }

      const response = await fetch(`/api/owl/export?${params}`);
      
      if (!response.ok) {
        throw new Error('Failed to fetch TTL content');
      }

      const content = await response.text();
      setTtlContent(content);
    } catch (err) {
      console.error('Error fetching TTL:', err);
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const copyToClipboard = () => {
    navigator.clipboard.writeText(ttlContent);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const downloadTTL = () => {
    const blob = new Blob([ttlContent], { type: 'text/turtle' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${ontology.label || 'ontology'}.ttl`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const highlightTTL = (content) => {
    if (!content) return [];

    // Split into lines for processing
    const lines = content.split('\n');
    
    return lines.map((line, index) => {
      // Comments
      if (line.trim().startsWith('#')) {
        return <div key={index} className="ttl-comment">{line}</div>;
      }

      // Prefixes
      if (line.trim().startsWith('@prefix')) {
        const parts = line.match(/(@prefix)\s+(\w+:)\s+(<[^>]+>)\s+\./);
        if (parts) {
          return (
            <div key={index} className="ttl-line">
              <span className="ttl-keyword">{parts[1]}</span>
              <span className="ttl-prefix"> {parts[2]}</span>
              <span className="ttl-uri"> {parts[3]}</span>
              <span className="ttl-punctuation"> .</span>
            </div>
          );
        }
      }

      // Parse the line into tokens
      const tokens = [];
      let currentPos = 0;
      const lineText = line;

      // Helper to add text token
      const addToken = (text, className = null) => {
        if (text) {
          tokens.push({ text, className });
        }
      };

      // Process line character by character
      while (currentPos < lineText.length) {
        const remaining = lineText.substring(currentPos);

        // Match IRI in angle brackets
        const iriMatch = remaining.match(/^(<[^>]+>)/);
        if (iriMatch) {
          addToken(iriMatch[1], 'ttl-uri');
          currentPos += iriMatch[1].length;
          continue;
        }

        // Match prefixed name
        const prefixedMatch = remaining.match(/^(\w+):(\w+)/);
        if (prefixedMatch) {
          const fullMatch = prefixedMatch[0];
          const prefix = prefixedMatch[1];
          const localName = prefixedMatch[2];
          
          // Check if it's a keyword
          const keywords = ['a', 'rdf:type', 'rdfs:subClassOf', 'rdfs:domain', 'rdfs:range', 
                           'owl:Class', 'owl:ObjectProperty', 'owl:DatatypeProperty', 
                           'owl:Ontology', 'owl:oneOf', 'owl:unionOf', 'owl:withRestrictions',
                           'owl:onDatatype', 'xsd:string', 'xsd:integer', 'xsd:decimal', 
                           'xsd:date', 'xsd:boolean', 'xsd:gYear', 'xsd:dateTime', 'xsd:anyURI',
                           'xsd:pattern', 'rdfs:label', 'rdfs:comment', 'owl:versionInfo'];
          
          if (keywords.includes(fullMatch)) {
            addToken(fullMatch, 'ttl-keyword');
          } else {
            tokens.push({
              text: prefix + ':',
              className: 'ttl-prefix-part'
            });
            tokens.push({
              text: localName,
              className: 'ttl-prefixed-local'
            });
          }
          currentPos += fullMatch.length;
          continue;
        }

        // Match string literals
        const stringMatch = remaining.match(/^"([^"]*)"/);
        if (stringMatch) {
          addToken(stringMatch[0], 'ttl-string');
          currentPos += stringMatch[0].length;
          continue;
        }

        // Match punctuation
        const punctMatch = remaining.match(/^([;.,\[\]()])/);
        if (punctMatch) {
          addToken(punctMatch[1], 'ttl-punctuation');
          currentPos += punctMatch[1].length;
          continue;
        }

        // Match 'a' keyword
        if (remaining.match(/^a\s/)) {
          addToken('a', 'ttl-keyword');
          currentPos += 1;
          continue;
        }

        // Default: add character as-is
        addToken(lineText[currentPos]);
        currentPos++;
      }

      // Render the line with tokens
      return (
        <div key={index} className="ttl-line">
          {tokens.map((token, i) => (
            token.className ? (
              <span key={i} className={token.className}>{token.text}</span>
            ) : (
              <span key={i}>{token.text}</span>
            )
          ))}
        </div>
      );
    });
  };

  if (!ontology) {
    return (
      <div className="ttl-viewer-placeholder">
        <div className="ttl-placeholder-icon">📄</div>
        <h3>No Ontology Selected</h3>
        <p>Select an ontology to view its Turtle (TTL) representation</p>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="ttl-viewer-loading">
        <div className="ttl-spinner"></div>
        <p>Loading TTL content...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="ttl-viewer-error">
        <div className="ttl-error-icon">⚠️</div>
        <h3>Error Loading TTL</h3>
        <p>{error}</p>
        <button onClick={fetchTTL} className="ttl-retry-btn">
          🔄 Retry
        </button>
      </div>
    );
  }

  return (
    <div className="ttl-viewer">
      {/* Header */}
      <div className="ttl-viewer-header">
        <div className="ttl-viewer-title">
          <span className="ttl-icon">📄</span>
          <div>
            <h3>{ontology.label || 'Ontology'}</h3>
            <p className="ttl-subtitle">Turtle (TTL) Format</p>
          </div>
        </div>
        
        <div className="ttl-viewer-actions">
          <div className="ttl-view-mode">
            <button
              className={`ttl-mode-btn ${viewMode === 'formatted' ? 'active' : ''}`}
              onClick={() => setViewMode('formatted')}
              title="Syntax highlighted view"
            >
              🎨 Formatted
            </button>
            <button
              className={`ttl-mode-btn ${viewMode === 'raw' ? 'active' : ''}`}
              onClick={() => setViewMode('raw')}
              title="Plain text view"
            >
              📝 Raw
            </button>
          </div>
          
          <button 
            onClick={copyToClipboard} 
            className="ttl-action-btn"
            title="Copy to clipboard"
          >
            {copied ? '✓ Copied!' : '📋 Copy'}
          </button>
          
          <button 
            onClick={downloadTTL} 
            className="ttl-action-btn"
            title="Download TTL file"
          >
            💾 Download
          </button>
          
          <button 
            onClick={fetchTTL} 
            className="ttl-action-btn"
            title="Refresh content"
          >
            🔄 Refresh
          </button>
        </div>
      </div>

      {/* Stats */}
      <div className="ttl-stats">
        <div className="ttl-stat">
          <span className="ttl-stat-label">Lines:</span>
          <span className="ttl-stat-value">{ttlContent.split('\n').length}</span>
        </div>
        <div className="ttl-stat">
          <span className="ttl-stat-label">Size:</span>
          <span className="ttl-stat-value">{(ttlContent.length / 1024).toFixed(1)} KB</span>
        </div>
        <div className="ttl-stat">
          <span className="ttl-stat-label">Classes:</span>
          <span className="ttl-stat-value">{(ttlContent.match(/owl:Class/g) || []).length}</span>
        </div>
        <div className="ttl-stat">
          <span className="ttl-stat-label">Properties:</span>
          <span className="ttl-stat-value">
            {(ttlContent.match(/owl:ObjectProperty|owl:DatatypeProperty/g) || []).length}
          </span>
        </div>
      </div>

      {/* Content */}
      <div className="ttl-content-wrapper">
        {viewMode === 'formatted' ? (
          <div className="ttl-content formatted">
            {highlightTTL(ttlContent)}
          </div>
        ) : (
          <pre className="ttl-content raw">
            {ttlContent}
          </pre>
        )}
      </div>

      {/* Footer Info */}
      <div className="ttl-footer">
        <span className="ttl-footer-text">
          💡 Tip: Use the formatted view for better readability or raw view for copying
        </span>
      </div>
    </div>
  );
};

export default OntologyTTLViewer;
