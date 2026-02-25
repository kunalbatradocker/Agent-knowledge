const pdf = require('pdf-parse');
const fs = require('fs');

class PDFParser {
  /**
   * Extract text from PDF with page break tracking
   * @param {string} filePath - Path to PDF file
   * @returns {Object} Extracted text with page information
   */
  async extractText(filePath) {
    try {
      const dataBuffer = fs.readFileSync(filePath);
      return await this.extractTextFromBuffer(dataBuffer);
    } catch (error) {
      throw new Error(`Failed to parse PDF: ${error.message}`);
    }
  }

  /**
   * Extract text from PDF buffer with page break tracking
   * @param {Buffer} buffer - PDF buffer
   * @returns {Object} Extracted text with page information
   */
  async extractTextFromBuffer(buffer) {
    try {
      const pageTexts = [];
      const pageBreaks = [];
      let currentPosition = 0;

      // Custom page render function to track page boundaries
      const renderPage = (pageData) => {
        return pageData.getTextContent().then((textContent) => {
          let pageText = '';
          let lastY = null;
          
          // Sort items by position (top to bottom, left to right)
          const items = textContent.items.sort((a, b) => {
            const yDiff = b.transform[5] - a.transform[5]; // Y position (inverted)
            if (Math.abs(yDiff) > 5) return yDiff;
            return a.transform[4] - b.transform[4]; // X position
          });
          
          for (const item of items) {
            const y = item.transform[5];
            
            // Add newline if Y position changed significantly (new line)
            if (lastY !== null && Math.abs(lastY - y) > 5) {
              pageText += '\n';
            }
            
            pageText += item.str;
            lastY = y;
          }
          
          return pageText.trim();
        });
      };

      // Parse with custom render function
      const options = {
        pagerender: renderPage
      };

      const data = await pdf(buffer, options);
      
      // pdf-parse with custom render returns text per page joined by form feed
      // We need to split and track positions
      const fullText = data.text;
      
      // Try to detect page breaks using form feed character or double newlines
      // pdf-parse typically uses form feed (\f) between pages
      const pages = fullText.split(/\f|\n{3,}/);
      
      let combinedText = '';
      for (let i = 0; i < pages.length; i++) {
        const pageText = pages[i].trim();
        if (pageText.length > 0) {
          if (combinedText.length > 0) {
            // Record page break position
            pageBreaks.push(combinedText.length);
            combinedText += '\n\n'; // Add separator between pages
          }
          pageTexts.push({
            pageNumber: i + 1,
            text: pageText,
            startPosition: combinedText.length,
            charCount: pageText.length
          });
          combinedText += pageText;
        }
      }

      // If no page breaks detected but we have multiple pages, estimate them
      if (pageBreaks.length === 0 && data.numpages > 1) {
        console.log(`   ⚠️ No page breaks detected, estimating for ${data.numpages} pages`);
        const avgPageLength = combinedText.length / data.numpages;
        for (let i = 1; i < data.numpages; i++) {
          // Try to find a good break point near the estimated position
          const estimatedPos = Math.floor(i * avgPageLength);
          const breakPos = this.findGoodBreakPoint(combinedText, estimatedPos, 200);
          pageBreaks.push(breakPos);
        }
        
        // Rebuild pageTexts based on estimated breaks
        pageTexts.length = 0;
        let lastBreak = 0;
        for (let i = 0; i <= pageBreaks.length; i++) {
          const endPos = i < pageBreaks.length ? pageBreaks[i] : combinedText.length;
          const pageText = combinedText.slice(lastBreak, endPos).trim();
          if (pageText.length > 0) {
            pageTexts.push({
              pageNumber: i + 1,
              text: pageText,
              startPosition: lastBreak,
              charCount: pageText.length
            });
          }
          lastBreak = endPos;
        }
      }

      console.log(`   📄 PDF extracted: ${data.numpages} pages, ${combinedText.length} chars, ${pageBreaks.length} breaks detected`);
      if (pageTexts.length > 0) {
        console.log(`   📄 Page sizes: ${pageTexts.slice(0, 5).map(p => p.charCount).join(', ')}${pageTexts.length > 5 ? '...' : ''}`);
      }

      return {
        text: combinedText,
        numPages: data.numpages,
        info: data.info,
        metadata: data.metadata,
        pageBreaks: pageBreaks,
        pageTexts: pageTexts
      };
    } catch (error) {
      throw new Error(`Failed to parse PDF buffer: ${error.message}`);
    }
  }

  /**
   * Find a good break point near the target position (at sentence/paragraph boundary)
   */
  findGoodBreakPoint(text, targetPos, searchRange) {
    const start = Math.max(0, targetPos - searchRange);
    const end = Math.min(text.length, targetPos + searchRange);
    const searchText = text.slice(start, end);
    
    // Look for paragraph breaks first
    const paragraphBreak = searchText.lastIndexOf('\n\n');
    if (paragraphBreak !== -1) {
      return start + paragraphBreak + 2;
    }
    
    // Look for sentence endings
    const sentenceEnders = ['. ', '.\n', '! ', '!\n', '? ', '?\n'];
    let bestBreak = -1;
    let bestDistance = searchRange;
    
    for (const ender of sentenceEnders) {
      let pos = 0;
      while ((pos = searchText.indexOf(ender, pos)) !== -1) {
        const absolutePos = start + pos + ender.length;
        const distance = Math.abs(absolutePos - targetPos);
        if (distance < bestDistance) {
          bestDistance = distance;
          bestBreak = absolutePos;
        }
        pos++;
      }
    }
    
    if (bestBreak !== -1) {
      return bestBreak;
    }
    
    // Fall back to any newline
    const newlinePos = searchText.lastIndexOf('\n');
    if (newlinePos !== -1) {
      return start + newlinePos + 1;
    }
    
    return targetPos;
  }

  /**
   * Extract text page by page (returns array of page texts)
   * @param {string} filePath - Path to PDF file
   * @returns {Array} Array of page text objects
   */
  async extractTextByPage(filePath) {
    const result = await this.extractText(filePath);
    return result.pageTexts || [];
  }
}

module.exports = new PDFParser();

