/**
 * Chunking Service
 * Handles document chunking with page tracking and URI generation
 */

const { v4: uuidv4 } = require('uuid');

class ChunkingService {
  constructor() {
    // Default chunk settings - larger chunks = fewer LLM calls, more context per chunk
    this.defaultChunkSize = parseInt(process.env.CHUNK_SIZE) || 2000; // characters
    this.defaultChunkOverlap = parseInt(process.env.CHUNK_OVERLAP) || 300; // characters
  }

  /**
   * Chunk text into smaller pieces with overlap and metadata
   * @param {string} text - The text to chunk
   * @param {Object} options - Chunking options
   * @returns {Array} Array of chunk objects conforming to Neo4j schema
   */
  chunkText(text, options = {}) {
    const chunkSize = options.chunkSize || this.defaultChunkSize;
    const chunkOverlap = options.chunkOverlap || this.defaultChunkOverlap;
    const documentId = options.documentId || uuidv4();
    const documentUri = options.documentUri || `doc://upload/${documentId}`;
    const documentName = options.documentName || 'Unknown Document';
    const pageBreaks = options.pageBreaks || []; // Array of character positions where pages break

    const chunks = [];
    let startIndex = 0;
    let chunkOrder = 0;
    let lastStartIndex = -1; // Track previous start to prevent infinite loops

    while (startIndex < text.length) {
      // Prevent infinite loop
      if (startIndex === lastStartIndex) {
        console.warn(`Chunking: Breaking out of potential infinite loop at index ${startIndex}`);
        break;
      }
      lastStartIndex = startIndex;

      // Calculate end index - don't exceed text length
      let endIndex = Math.min(startIndex + chunkSize, text.length);

      // Try to break at sentence boundary if not at end of text
      if (endIndex < text.length) {
        const breakPoint = this.findSentenceBreak(text, endIndex, Math.min(chunkSize / 2, 200));
        if (breakPoint > startIndex + 100) { // Only use break point if it gives us a reasonable chunk
          endIndex = breakPoint;
        }
      }

      // Extract chunk text
      const chunkText = text.slice(startIndex, endIndex).trim();

      if (chunkText.length > 0) {
        const chunkId = `${documentId}_chunk_${chunkOrder}`;
        const chunkUri = `${documentUri}#chunk=${chunkOrder}`;

        // Calculate page numbers
        const pageInfo = this.calculatePageNumbers(startIndex, endIndex, pageBreaks);

        chunks.push({
          // Neo4j Chunk node properties
          chunk_id: chunkId,
          uri: chunkUri,
          text: chunkText,
          order: chunkOrder,
          start_page: pageInfo.startPage,
          end_page: pageInfo.endPage,
          vector_key: chunkId, // Will be updated when stored in vector DB

          // Additional metadata for processing
          id: chunkId, // Alias for backward compatibility
          documentId: documentId,
          documentUri: documentUri,
          documentName: documentName,
          chunkIndex: chunkOrder,
          startChar: startIndex,
          endChar: endIndex,
          metadata: {
            chunkSize: chunkText.length,
            totalChunks: null, // Will be updated after all chunks are created
            position: startIndex / text.length,
            startPage: pageInfo.startPage,
            endPage: pageInfo.endPage
          }
        });
        chunkOrder++;
      }

      // Calculate next start index
      const nextStart = endIndex - chunkOverlap;
      
      // Ensure we always make forward progress
      if (nextStart <= startIndex) {
        startIndex = endIndex; // Move past current chunk without overlap
      } else {
        startIndex = nextStart;
      }

      // Safety check - limit number of chunks
      if (chunkOrder > 1000) {
        console.warn('Chunking: Reached maximum chunk limit (1000)');
        break;
      }
    }

    // Update total chunks count
    chunks.forEach(chunk => {
      chunk.metadata.totalChunks = chunks.length;
    });

    return chunks;
  }

  /**
   * Calculate page numbers for a chunk based on character positions
   */
  calculatePageNumbers(startChar, endChar, pageBreaks) {
    if (!pageBreaks || pageBreaks.length === 0) {
      return { startPage: null, endPage: null };
    }

    let startPage = 1;
    let endPage = 1;

    // Find start page
    for (let i = 0; i < pageBreaks.length; i++) {
      if (startChar >= pageBreaks[i]) {
        startPage = i + 2; // Pages are 1-indexed, and breaks mark end of page
      }
    }

    // Find end page
    for (let i = 0; i < pageBreaks.length; i++) {
      if (endChar >= pageBreaks[i]) {
        endPage = i + 2;
      }
    }

    return { startPage, endPage };
  }

  /**
   * Find a good sentence break point near the target position
   */
  findSentenceBreak(text, targetPos, maxLookback) {
    const sentenceEnders = ['. ', '.\n', '! ', '!\n', '? ', '?\n', '\n\n'];

    // Look backwards for sentence enders
    for (let i = targetPos; i > targetPos - maxLookback && i > 0; i--) {
      for (const ender of sentenceEnders) {
        if (text.slice(i - ender.length, i) === ender) {
          return i;
        }
      }
    }

    // If no sentence break found, look for other break points
    const breakChars = ['\n', ' ', ',', ';'];
    for (let i = targetPos; i > targetPos - 50 && i > 0; i--) {
      if (breakChars.includes(text[i])) {
        return i + 1;
      }
    }

    return targetPos;
  }

  /**
   * Chunk a document with full metadata (main entry point)
   * @param {string} text - Document text
   * @param {Object} documentMetadata - Document metadata
   * @returns {Object} Document with chunks
   */
  chunkDocument(text, documentMetadata = {}) {
    const docId = documentMetadata.id || uuidv4();
    const docUri = documentMetadata.uri || `doc://${documentMetadata.source || 'upload'}/${docId}`;

    const chunks = this.chunkText(text, {
      documentId: docId,
      documentUri: docUri,
      documentName: documentMetadata.name || 'Unknown',
      chunkSize: documentMetadata.chunkSize || this.defaultChunkSize,
      chunkOverlap: documentMetadata.chunkOverlap || this.defaultChunkOverlap,
      pageBreaks: documentMetadata.pageBreaks || []
    });

    return {
      documentId: docId,
      documentUri: docUri,
      documentName: documentMetadata.name,
      source: documentMetadata.source || 'upload',
      doc_type: documentMetadata.doc_type || 'document',
      totalChunks: chunks.length,
      totalCharacters: text.length,
      chunks: chunks
    };
  }

  /**
   * Chunk a PDF with page information
   * @param {string} text - Extracted PDF text
   * @param {Object} pdfMetadata - PDF metadata including page info
   * @returns {Object} Document with chunks including page numbers
   */
  chunkPDF(text, pdfMetadata = {}) {
    // If page info is available, estimate page breaks
    const pageBreaks = [];
    if (pdfMetadata.numPages && pdfMetadata.numPages > 1) {
      const avgPageLength = text.length / pdfMetadata.numPages;
      for (let i = 1; i < pdfMetadata.numPages; i++) {
        pageBreaks.push(Math.floor(i * avgPageLength));
      }
    }

    return this.chunkDocument(text, {
      ...pdfMetadata,
      pageBreaks: pdfMetadata.pageBreaks || pageBreaks,
      doc_type: 'pdf'
    });
  }

  /**
   * Chunk by page - each page becomes a chunk (or split if too long)
   * Uses actual page break positions if available, otherwise estimates
   * @param {string} text - Document text
   * @param {Object} options - Chunking options
   * @returns {Array} Array of chunk objects
   */
  chunkByPage(text, options = {}) {
    const documentId = options.documentId || uuidv4();
    const documentUri = options.documentUri || `doc://upload/${documentId}`;
    const documentName = options.documentName || 'Unknown Document';
    const numPages = options.numPages || 1;
    const maxChunkSize = options.maxChunkSize || 4000; // Max chars per chunk
    const pageBreaks = options.pageBreaks || []; // Actual page break positions
    const pageTexts = options.pageTexts || []; // Pre-extracted page texts
    
    const chunks = [];
    let chunkOrder = 0;

    console.log(`   📄 chunkByPage: numPages=${numPages}, pageBreaks=${pageBreaks.length}, pageTexts=${pageTexts.length}`);

    // If we have pre-extracted page texts, use them directly
    if (pageTexts.length > 0) {
      console.log(`   📄 Using pre-extracted page texts (${pageTexts.length} pages)`);
      
      for (const page of pageTexts) {
        const pageText = page.text.trim();
        const pageNum = page.pageNumber;
        
        if (pageText.length === 0) continue;

        // If page is too long, split it
        if (pageText.length > maxChunkSize) {
          const subChunks = this.splitLongPage(pageText, maxChunkSize);
          for (let i = 0; i < subChunks.length; i++) {
            const chunkId = `${documentId}_chunk_${chunkOrder}`;
            chunks.push({
              chunk_id: chunkId,
              uri: `${documentUri}#chunk=${chunkOrder}`,
              text: subChunks[i],
              order: chunkOrder,
              start_page: pageNum,
              end_page: pageNum,
              vector_key: chunkId,
              id: chunkId,
              documentId: documentId,
              documentUri: documentUri,
              documentName: documentName,
              chunkIndex: chunkOrder,
              metadata: {
                chunkSize: subChunks[i].length,
                pageNumber: pageNum,
                subChunkIndex: i,
                method: 'page',
                startPage: pageNum,
                endPage: pageNum
              }
            });
            chunkOrder++;
          }
        } else {
          const chunkId = `${documentId}_chunk_${chunkOrder}`;
          chunks.push({
            chunk_id: chunkId,
            uri: `${documentUri}#chunk=${chunkOrder}`,
            text: pageText,
            order: chunkOrder,
            start_page: pageNum,
            end_page: pageNum,
            vector_key: chunkId,
            id: chunkId,
            documentId: documentId,
            documentUri: documentUri,
            documentName: documentName,
            chunkIndex: chunkOrder,
            metadata: {
              chunkSize: pageText.length,
              pageNumber: pageNum,
              method: 'page',
              startPage: pageNum,
              endPage: pageNum
            }
          });
          chunkOrder++;
        }
      }
    }
    // If we have page breaks, use them to split
    else if (pageBreaks.length > 0) {
      console.log(`   📄 Using page breaks (${pageBreaks.length} breaks)`);
      
      let lastBreak = 0;
      for (let pageNum = 1; pageNum <= pageBreaks.length + 1; pageNum++) {
        const pageEnd = pageNum <= pageBreaks.length ? pageBreaks[pageNum - 1] : text.length;
        let pageText = text.slice(lastBreak, pageEnd).trim();
        
        if (pageText.length === 0) {
          lastBreak = pageEnd;
          continue;
        }

        // If page is too long, split it
        if (pageText.length > maxChunkSize) {
          const subChunks = this.splitLongPage(pageText, maxChunkSize);
          for (let i = 0; i < subChunks.length; i++) {
            const chunkId = `${documentId}_chunk_${chunkOrder}`;
            chunks.push({
              chunk_id: chunkId,
              uri: `${documentUri}#chunk=${chunkOrder}`,
              text: subChunks[i],
              order: chunkOrder,
              start_page: pageNum,
              end_page: pageNum,
              vector_key: chunkId,
              id: chunkId,
              documentId: documentId,
              documentUri: documentUri,
              documentName: documentName,
              chunkIndex: chunkOrder,
              metadata: {
                chunkSize: subChunks[i].length,
                pageNumber: pageNum,
                subChunkIndex: i,
                method: 'page',
                startPage: pageNum,
                endPage: pageNum
              }
            });
            chunkOrder++;
          }
        } else {
          const chunkId = `${documentId}_chunk_${chunkOrder}`;
          chunks.push({
            chunk_id: chunkId,
            uri: `${documentUri}#chunk=${chunkOrder}`,
            text: pageText,
            order: chunkOrder,
            start_page: pageNum,
            end_page: pageNum,
            vector_key: chunkId,
            id: chunkId,
            documentId: documentId,
            documentUri: documentUri,
            documentName: documentName,
            chunkIndex: chunkOrder,
            metadata: {
              chunkSize: pageText.length,
              pageNumber: pageNum,
              method: 'page',
              startPage: pageNum,
              endPage: pageNum
            }
          });
          chunkOrder++;
        }
        
        lastBreak = pageEnd;
      }
    }
    // Fall back to estimation if we have page count
    else if (numPages > 1) {
      console.log(`   📄 Estimating page breaks for ${numPages} pages`);
      const avgPageLength = text.length / numPages;
      
      for (let pageNum = 0; pageNum < numPages; pageNum++) {
        const pageStart = Math.floor(pageNum * avgPageLength);
        const pageEnd = pageNum === numPages - 1 ? text.length : Math.floor((pageNum + 1) * avgPageLength);
        let pageText = text.slice(pageStart, pageEnd).trim();

        if (pageText.length === 0) continue;

        // If page is too long, split it
        if (pageText.length > maxChunkSize) {
          const subChunks = this.splitLongPage(pageText, maxChunkSize);
          let subChunkOffset = pageStart;
          for (let i = 0; i < subChunks.length; i++) {
            const chunkId = `${documentId}_chunk_${chunkOrder}`;
            const subChunkEndOffset = subChunkOffset + subChunks[i].length;
            chunks.push({
              chunk_id: chunkId,
              uri: `${documentUri}#chunk=${chunkOrder}`,
              text: subChunks[i],
              order: chunkOrder,
              start_page: pageNum + 1,
              end_page: pageNum + 1,
              vector_key: chunkId,
              id: chunkId,
              documentId: documentId,
              documentUri: documentUri,
              documentName: documentName,
              chunkIndex: chunkOrder,
              startChar: subChunkOffset,
              endChar: subChunkEndOffset,
              metadata: {
                chunkSize: subChunks[i].length,
                pageNumber: pageNum + 1,
                subChunkIndex: i,
                method: 'page',
                startPage: pageNum + 1,
                endPage: pageNum + 1
              }
            });
            subChunkOffset = subChunkEndOffset;
            chunkOrder++;
          }
        } else {
          const chunkId = `${documentId}_chunk_${chunkOrder}`;
          chunks.push({
            chunk_id: chunkId,
            uri: `${documentUri}#chunk=${chunkOrder}`,
            text: pageText,
            order: chunkOrder,
            start_page: pageNum + 1,
            end_page: pageNum + 1,
            vector_key: chunkId,
            id: chunkId,
            documentId: documentId,
            documentUri: documentUri,
            documentName: documentName,
            chunkIndex: chunkOrder,
            startChar: pageStart,
            endChar: pageEnd,
            metadata: {
              chunkSize: pageText.length,
              pageNumber: pageNum + 1,
              method: 'page',
              startPage: pageNum + 1,
              endPage: pageNum + 1
            }
          });
          chunkOrder++;
        }
      }
    } else {
      // Single page document - use fixed length chunking
      console.log(`   📄 Single page, falling back to fixed chunking`);
      return this.chunkText(text, options);
    }

    // Update total chunks count
    chunks.forEach(chunk => {
      chunk.metadata.totalChunks = chunks.length;
    });

    console.log(`   📄 Created ${chunks.length} chunks from ${numPages} pages`);
    if (chunks.length > 0) {
      console.log(`   📄 Chunk sizes: ${chunks.slice(0, 5).map(c => c.metadata.chunkSize).join(', ')}${chunks.length > 5 ? '...' : ''}`);
    }

    return chunks;
  }

  /**
   * Split a long page into smaller chunks at sentence boundaries
   */
  splitLongPage(text, maxSize) {
    const chunks = [];
    let start = 0;

    while (start < text.length) {
      let end = Math.min(start + maxSize, text.length);
      
      // Try to find sentence break if not at end
      if (end < text.length) {
        const breakPoint = this.findSentenceBreak(text, end, Math.min(maxSize / 2, 500));
        if (breakPoint > start + 100) {
          end = breakPoint;
        }
      }

      const chunk = text.slice(start, end).trim();
      if (chunk.length > 0) {
        chunks.push(chunk);
      }
      start = end;
    }

    return chunks;
  }

  /**
   * Chunk document with specified method
   * @param {string} text - Document text
   * @param {Object} documentMetadata - Document metadata including chunkingMethod
   * @returns {Object} Document with chunks
   */
  chunkDocumentWithMethod(text, documentMetadata = {}) {
    const docId = documentMetadata.id || uuidv4();
    const docUri = documentMetadata.uri || `doc://${documentMetadata.source || 'upload'}/${docId}`;
    const method = documentMetadata.chunkingMethod || 'fixed';

    let chunks;

    if (method === 'page' && documentMetadata.numPages && documentMetadata.numPages > 1) {
      console.log(`   📄 Using page-based chunking (${documentMetadata.numPages} pages)`);
      chunks = this.chunkByPage(text, {
        documentId: docId,
        documentUri: docUri,
        documentName: documentMetadata.name || 'Unknown',
        numPages: documentMetadata.numPages,
        maxChunkSize: documentMetadata.maxChunkSize || 4000,
        pageBreaks: documentMetadata.pageBreaks || [],
        pageTexts: documentMetadata.pageTexts || []
      });
    } else {
      console.log(`   📄 Using fixed-length chunking (${documentMetadata.chunkSize || this.defaultChunkSize} chars)`);
      chunks = this.chunkText(text, {
        documentId: docId,
        documentUri: docUri,
        documentName: documentMetadata.name || 'Unknown',
        chunkSize: documentMetadata.chunkSize || this.defaultChunkSize,
        chunkOverlap: documentMetadata.chunkOverlap || this.defaultChunkOverlap,
        pageBreaks: documentMetadata.pageBreaks || []
      });
    }

    return {
      documentId: docId,
      documentUri: docUri,
      documentName: documentMetadata.name,
      source: documentMetadata.source || 'upload',
      doc_type: documentMetadata.doc_type || 'document',
      chunkingMethod: method,
      totalChunks: chunks.length,
      totalCharacters: text.length,
      chunks: chunks
    };
  }

  /**
   * Get available chunking methods
   */
  getChunkingMethods() {
    return [
      {
        id: 'fixed',
        name: 'Fixed Length',
        description: `Split by character count (${this.defaultChunkSize} chars with ${this.defaultChunkOverlap} overlap)`,
        isDefault: true
      },
      {
        id: 'page',
        name: 'Page-based',
        description: 'One chunk per page (best for PDFs with clear page structure)',
        requiresPages: true
      }
    ];
  }

  /**
   * Estimate optimal chunk size based on document characteristics
   */
  estimateOptimalChunkSize(text, options = {}) {
    const targetChunks = options.targetChunks || 20;
    const minChunkSize = options.minChunkSize || 500;
    const maxChunkSize = options.maxChunkSize || 2000;

    // Calculate based on desired number of chunks
    let estimatedSize = Math.floor(text.length / targetChunks);

    // Clamp to bounds
    estimatedSize = Math.max(minChunkSize, Math.min(maxChunkSize, estimatedSize));

    // Round to nearest 100
    estimatedSize = Math.round(estimatedSize / 100) * 100;

    return {
      chunkSize: estimatedSize,
      chunkOverlap: Math.floor(estimatedSize * 0.2),
      estimatedChunks: Math.ceil(text.length / (estimatedSize * 0.8))
    };
  }
}

module.exports = new ChunkingService();
