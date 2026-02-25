/**
 * Text Handler - Process plain text files
 */

const logger = require('../../utils/logger');

class TextHandler {
  /**
   * Extract content from text file
   */
  async extract(filePath, options = {}) {
    try {
      const fs = require('fs').promises;
      const text = await fs.readFile(filePath, 'utf8');
      
      const analysis = this.analyzeText(text);
      
      return {
        text: text,
        structured: {
          type: 'document',
          format: 'text',
          analysis: analysis,
          sections: this.extractSections(text),
          entities: this.extractBasicEntities(text)
        },
        metadata: {
          length: text.length,
          lines: text.split('\n').length,
          words: text.split(/\s+/).filter(w => w.length > 0).length,
          extractedAt: new Date().toISOString()
        }
      };
    } catch (error) {
      logger.error('Text extraction failed:', error);
      throw error;
    }
  }

  /**
   * Validate text file
   */
  async validate(filePath, options = {}) {
    try {
      const fs = require('fs').promises;
      const stats = await fs.stat(filePath);
      
      if (stats.size > 10 * 1024 * 1024) { // 10MB limit
        return { 
          valid: false, 
          error: 'File too large (max 10MB for text files)' 
        };
      }
      
      return { 
        valid: true,
        size: stats.size,
        encoding: 'utf8'
      };
    } catch (error) {
      return { valid: false, error: error.message };
    }
  }

  /**
   * Get text schema
   */
  async getSchema(filePath, options = {}) {
    try {
      const result = await this.extract(filePath, options);
      
      return {
        type: 'document',
        format: 'text',
        structure: {
          length: result.metadata.length,
          lines: result.metadata.lines,
          words: result.metadata.words,
          sections: result.structured.sections.length,
          entities: result.structured.entities.length,
          language: result.structured.analysis.language,
          readability: result.structured.analysis.readability
        }
      };
    } catch (error) {
      logger.error('Text schema extraction failed:', error);
      return null;
    }
  }

  /**
   * Transform text to other formats
   */
  async transform(filePath, targetFormat, options = {}) {
    const result = await this.extract(filePath, options);
    
    switch (targetFormat) {
      case 'json':
        return JSON.stringify(result, null, 2);
      case 'markdown':
        return this.toMarkdown(result);
      case 'html':
        return this.toHTML(result);
      default:
        throw new Error(`Unsupported target format: ${targetFormat}`);
    }
  }

  /**
   * Analyze text content
   */
  analyzeText(text) {
    const words = text.split(/\s+/).filter(w => w.length > 0);
    const sentences = text.split(/[.!?]+/).filter(s => s.trim().length > 0);
    const paragraphs = text.split(/\n\s*\n/).filter(p => p.trim().length > 0);
    
    return {
      wordCount: words.length,
      sentenceCount: sentences.length,
      paragraphCount: paragraphs.length,
      avgWordsPerSentence: words.length / Math.max(sentences.length, 1),
      avgSentencesPerParagraph: sentences.length / Math.max(paragraphs.length, 1),
      language: this.detectLanguage(text),
      readability: this.calculateReadability(words, sentences),
      topics: this.extractTopics(words)
    };
  }

  /**
   * Extract sections from text
   */
  extractSections(text) {
    const lines = text.split('\n');
    const sections = [];
    let currentSection = null;
    
    lines.forEach((line, index) => {
      const trimmed = line.trim();
      
      // Detect headers (lines that are short, uppercase, or end with colon)
      if (trimmed.length > 0 && trimmed.length < 100) {
        const isHeader = trimmed === trimmed.toUpperCase() || 
                        trimmed.endsWith(':') ||
                        /^[A-Z][A-Z\s]+$/.test(trimmed);
        
        if (isHeader) {
          if (currentSection) {
            sections.push(currentSection);
          }
          
          currentSection = {
            title: trimmed,
            startLine: index,
            content: []
          };
          return;
        }
      }
      
      if (currentSection && trimmed.length > 0) {
        currentSection.content.push(trimmed);
      }
    });
    
    if (currentSection) {
      sections.push(currentSection);
    }
    
    return sections;
  }

  /**
   * Extract basic entities
   */
  extractBasicEntities(text) {
    const entities = [];
    
    // Email addresses
    const emails = text.match(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g);
    if (emails) {
      emails.forEach(email => {
        entities.push({ type: 'email', value: email });
      });
    }
    
    // URLs
    const urls = text.match(/https?:\/\/[^\s]+/g);
    if (urls) {
      urls.forEach(url => {
        entities.push({ type: 'url', value: url });
      });
    }
    
    // Phone numbers
    const phones = text.match(/\b\d{3}[-.]?\d{3}[-.]?\d{4}\b/g);
    if (phones) {
      phones.forEach(phone => {
        entities.push({ type: 'phone', value: phone });
      });
    }
    
    // Dates
    const dates = text.match(/\b\d{1,2}\/\d{1,2}\/\d{4}\b|\b\d{4}-\d{2}-\d{2}\b/g);
    if (dates) {
      dates.forEach(date => {
        entities.push({ type: 'date', value: date });
      });
    }
    
    // Money amounts
    const money = text.match(/\$[\d,]+\.?\d*/g);
    if (money) {
      money.forEach(amount => {
        entities.push({ type: 'money', value: amount });
      });
    }
    
    return entities;
  }

  /**
   * Simple language detection
   */
  detectLanguage(text) {
    const sample = text.toLowerCase().substring(0, 1000);
    
    // Simple heuristics for common languages
    const patterns = {
      english: /\b(the|and|or|but|in|on|at|to|for|of|with|by)\b/g,
      spanish: /\b(el|la|y|o|pero|en|de|con|por|para)\b/g,
      french: /\b(le|la|et|ou|mais|dans|de|avec|par|pour)\b/g,
      german: /\b(der|die|das|und|oder|aber|in|von|mit|für)\b/g
    };
    
    let maxMatches = 0;
    let detectedLang = 'unknown';
    
    Object.entries(patterns).forEach(([lang, pattern]) => {
      const matches = (sample.match(pattern) || []).length;
      if (matches > maxMatches) {
        maxMatches = matches;
        detectedLang = lang;
      }
    });
    
    return detectedLang;
  }

  /**
   * Calculate readability score (simplified Flesch formula)
   */
  calculateReadability(words, sentences) {
    const avgWordsPerSentence = words.length / Math.max(sentences.length, 1);
    const avgSyllablesPerWord = this.estimateSyllables(words);
    
    // Simplified Flesch Reading Ease
    const score = 206.835 - (1.015 * avgWordsPerSentence) - (84.6 * avgSyllablesPerWord);
    
    let level = 'unknown';
    if (score >= 90) level = 'very easy';
    else if (score >= 80) level = 'easy';
    else if (score >= 70) level = 'fairly easy';
    else if (score >= 60) level = 'standard';
    else if (score >= 50) level = 'fairly difficult';
    else if (score >= 30) level = 'difficult';
    else level = 'very difficult';
    
    return { score: Math.round(score), level };
  }

  /**
   * Estimate syllables in words
   */
  estimateSyllables(words) {
    const totalSyllables = words.reduce((sum, word) => {
      return sum + this.countSyllables(word);
    }, 0);
    
    return totalSyllables / Math.max(words.length, 1);
  }

  /**
   * Count syllables in a word (simple approximation)
   */
  countSyllables(word) {
    word = word.toLowerCase();
    if (word.length <= 3) return 1;
    
    const vowels = word.match(/[aeiouy]+/g);
    let count = vowels ? vowels.length : 1;
    
    if (word.endsWith('e')) count--;
    if (count === 0) count = 1;
    
    return count;
  }

  /**
   * Extract topics (simple keyword extraction)
   */
  extractTopics(words) {
    // Filter out common words
    const stopWords = new Set([
      'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
      'of', 'with', 'by', 'is', 'are', 'was', 'were', 'be', 'been', 'have',
      'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should',
      'this', 'that', 'these', 'those', 'i', 'you', 'he', 'she', 'it', 'we', 'they'
    ]);
    
    const wordFreq = new Map();
    
    words.forEach(word => {
      const clean = word.toLowerCase().replace(/[^a-z]/g, '');
      if (clean.length > 3 && !stopWords.has(clean)) {
        wordFreq.set(clean, (wordFreq.get(clean) || 0) + 1);
      }
    });
    
    // Get top 10 most frequent words
    return Array.from(wordFreq.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([word, freq]) => ({ word, frequency: freq }));
  }

  /**
   * Convert to Markdown
   */
  toMarkdown(result) {
    let markdown = `# Document Analysis\n\n`;
    
    markdown += `**Words:** ${result.metadata.words}\n`;
    markdown += `**Lines:** ${result.metadata.lines}\n`;
    markdown += `**Language:** ${result.structured.analysis.language}\n`;
    markdown += `**Readability:** ${result.structured.analysis.readability.level}\n\n`;
    
    if (result.structured.sections.length > 0) {
      markdown += `## Sections\n\n`;
      result.structured.sections.forEach(section => {
        markdown += `### ${section.title}\n\n`;
        markdown += section.content.join('\n\n') + '\n\n';
      });
    } else {
      markdown += `## Content\n\n${result.text}`;
    }
    
    return markdown;
  }

  /**
   * Convert to HTML
   */
  toHTML(result) {
    let html = `<!DOCTYPE html>
<html>
<head>
    <title>Document Analysis</title>
    <style>
        body { font-family: Arial, sans-serif; margin: 40px; }
        .metadata { background: #f5f5f5; padding: 15px; border-radius: 5px; }
        .section { margin: 20px 0; }
    </style>
</head>
<body>
    <h1>Document Analysis</h1>
    
    <div class="metadata">
        <p><strong>Words:</strong> ${result.metadata.words}</p>
        <p><strong>Lines:</strong> ${result.metadata.lines}</p>
        <p><strong>Language:</strong> ${result.structured.analysis.language}</p>
        <p><strong>Readability:</strong> ${result.structured.analysis.readability.level}</p>
    </div>
`;
    
    if (result.structured.sections.length > 0) {
      result.structured.sections.forEach(section => {
        html += `    <div class="section">
        <h2>${section.title}</h2>
        <p>${section.content.join('</p><p>')}</p>
    </div>
`;
      });
    } else {
      html += `    <div class="section">
        <h2>Content</h2>
        <pre>${result.text}</pre>
    </div>
`;
    }
    
    html += `</body>
</html>`;
    
    return html;
  }
}

module.exports = new TextHandler();
