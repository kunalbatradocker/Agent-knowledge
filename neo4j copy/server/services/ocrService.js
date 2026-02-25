/**
 * OCR Service - Extract text from PDFs using OCR
 * Uses Tesseract.js for OCR and pdf-to-png-converter for PDF to image conversion
 * No external binary dependencies required (pure JavaScript)
 * 
 * IMPROVED: Higher DPI, better text cleaning, quality metrics
 */

const Tesseract = require('tesseract.js');
const path = require('path');
const fs = require('fs');
const { pdfToPng } = require('pdf-to-png-converter');

class OCRService {
  constructor() {
    this.tempDir = path.join(__dirname, '../temp');
    this.ensureTempDir();
    
    // Quality settings
    this.defaultDPI = 300; // Higher DPI for better quality (was 200)
    this.minConfidenceThreshold = 60; // Warn if below this
    
    console.log('✅ OCR Service initialized (using pdf-to-png-converter + Tesseract.js)');
    console.log(`   Default DPI: ${this.defaultDPI}, Min confidence: ${this.minConfidenceThreshold}%`);
  }

  ensureTempDir() {
    if (!fs.existsSync(this.tempDir)) {
      fs.mkdirSync(this.tempDir, { recursive: true });
    }
  }

  /**
   * Extract text from PDF using OCR
   * @param {string} filePath - Path to PDF file
   * @param {Object} options - OCR options
   * @returns {Object} - { text, numPages, confidence, method }
   */
  async extractTextFromPDF(filePath, options = {}) {
    const { language = 'eng', dpi = this.defaultDPI } = options;
    
    console.log(`\n🔍 OCR: Starting text extraction from ${path.basename(filePath)}`);
    const startTime = Date.now();

    try {
      // Convert PDF pages to PNG images
      console.log(`   📸 Converting PDF to images (DPI: ${dpi})...`);
      const pngPages = await pdfToPng(filePath, {
        disableFontFace: true,
        useSystemFonts: true,
        viewportScale: dpi / 72, // Convert DPI to scale (72 is default PDF DPI)
        outputFolder: this.tempDir,
        outputFileMask: `ocr_${Date.now()}`
      });
      
      console.log(`   📸 Converted ${pngPages.length} pages to images`);

      // OCR each image
      const pageTexts = [];
      let totalConfidence = 0;

      for (let i = 0; i < pngPages.length; i++) {
        const page = pngPages[i];
        console.log(`   🔤 OCR processing page ${i + 1}/${pngPages.length}...`);
        
        // Use the buffer directly if available, otherwise use the file path
        const imageSource = page.content || page.path;
        
        const result = await Tesseract.recognize(imageSource, language, {
          logger: m => {
            if (m.status === 'recognizing text' && m.progress) {
              process.stdout.write(`\r   📊 Page ${i + 1} progress: ${Math.round(m.progress * 100)}%`);
            }
          }
        });
        
        process.stdout.write('\n');
        pageTexts.push(result.data.text);
        totalConfidence += result.data.confidence;

        // Clean up image file if it was saved to disk
        if (page.path && fs.existsSync(page.path)) {
          try {
            fs.unlinkSync(page.path);
          } catch (e) {
            // Ignore cleanup errors
          }
        }
      }

      const fullText = this.cleanOCRText(pageTexts.join('\n\n--- Page Break ---\n\n'));
      const avgConfidence = pngPages.length > 0 ? totalConfidence / pngPages.length : 0;
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

      console.log(`   ✅ OCR complete in ${elapsed}s`);
      console.log(`   📊 Average confidence: ${avgConfidence.toFixed(1)}%`);
      console.log(`   📝 Extracted ${fullText.length.toLocaleString()} characters`);
      
      if (avgConfidence < this.minConfidenceThreshold) {
        console.log(`   ⚠️ Low confidence OCR - text quality may be poor`);
      }

      return {
        text: fullText,
        numPages: pngPages.length,
        confidence: avgConfidence,
        method: 'ocr',
        processingTime: elapsed
      };
    } catch (error) {
      console.error('   ❌ OCR error:', error.message);
      throw new Error(`OCR extraction failed: ${error.message}`);
    }
  }

  /**
   * Compare PDF text extraction vs OCR
   * @param {string} filePath - Path to PDF file
   * @returns {Object} - Comparison results
   */
  async compareExtractionMethods(filePath) {
    const pdfParser = require('./pdfParser');
    
    console.log('\n📊 Comparing PDF extraction methods...');
    console.log('='.repeat(50));

    // Method 1: Standard PDF text extraction
    console.log('\n📄 Method 1: PDF Text Extraction (pdf-parse)');
    const pdfStart = Date.now();
    let pdfResult;
    try {
      pdfResult = await pdfParser.extractText(filePath);
      pdfResult.method = 'pdf-parse';
      pdfResult.processingTime = ((Date.now() - pdfStart) / 1000).toFixed(1);
      console.log(`   ✅ Extracted ${pdfResult.text.length.toLocaleString()} chars in ${pdfResult.processingTime}s`);
    } catch (error) {
      console.log(`   ❌ Failed: ${error.message}`);
      pdfResult = { text: '', error: error.message, method: 'pdf-parse' };
    }

    // Method 2: OCR
    console.log('\n🔍 Method 2: OCR (Tesseract)');
    let ocrResult;
    try {
      ocrResult = await this.extractTextFromPDF(filePath);
    } catch (error) {
      console.log(`   ❌ Failed: ${error.message}`);
      ocrResult = { text: '', error: error.message, method: 'ocr' };
    }

    // Compare results
    console.log('\n📊 COMPARISON RESULTS');
    console.log('='.repeat(50));
    console.log(`PDF-Parse: ${pdfResult.text?.length || 0} chars, ${pdfResult.processingTime || 'N/A'}s`);
    console.log(`OCR:       ${ocrResult.text?.length || 0} chars, ${ocrResult.processingTime || 'N/A'}s, ${ocrResult.confidence?.toFixed(1) || 'N/A'}% confidence`);

    // Quality indicators
    const pdfWords = (pdfResult.text || '').split(/\s+/).filter(w => w.length > 2).length;
    const ocrWords = (ocrResult.text || '').split(/\s+/).filter(w => w.length > 2).length;
    
    console.log(`\nWord count: PDF=${pdfWords}, OCR=${ocrWords}`);
    
    // Check for common OCR issues
    const ocrGarbage = (ocrResult.text || '').match(/[^\x20-\x7E\n]/g)?.length || 0;
    const pdfGarbage = (pdfResult.text || '').match(/[^\x20-\x7E\n]/g)?.length || 0;
    
    console.log(`Non-ASCII chars: PDF=${pdfGarbage}, OCR=${ocrGarbage}`);

    return {
      pdfParse: {
        text: pdfResult.text,
        charCount: pdfResult.text?.length || 0,
        wordCount: pdfWords,
        processingTime: pdfResult.processingTime,
        numPages: pdfResult.numPages,
        error: pdfResult.error
      },
      ocr: {
        text: ocrResult.text,
        charCount: ocrResult.text?.length || 0,
        wordCount: ocrWords,
        processingTime: ocrResult.processingTime,
        confidence: ocrResult.confidence,
        numPages: ocrResult.numPages,
        error: ocrResult.error
      },
      recommendation: this.getRecommendation(pdfResult, ocrResult, pdfWords, ocrWords)
    };
  }

  /**
   * Get recommendation on which method to use
   */
  getRecommendation(pdfResult, ocrResult, pdfWords, ocrWords) {
    // If one failed, recommend the other
    if (pdfResult.error && !ocrResult.error) return 'ocr';
    if (ocrResult.error && !pdfResult.error) return 'pdf-parse';
    if (pdfResult.error && ocrResult.error) return 'none';

    // If PDF extraction got very little text but OCR got more, recommend OCR
    if (pdfWords < 50 && ocrWords > pdfWords * 2) return 'ocr';
    
    // If OCR confidence is low, prefer PDF
    if (ocrResult.confidence < 60) return 'pdf-parse';
    
    // If PDF got significantly more words, prefer PDF (faster)
    if (pdfWords > ocrWords * 1.5) return 'pdf-parse';
    
    // If OCR got significantly more words with good confidence, prefer OCR
    if (ocrWords > pdfWords * 1.5 && ocrResult.confidence > 80) return 'ocr';
    
    // Default to PDF (faster)
    return 'pdf-parse';
  }

  /**
   * Clean up temp directory
   */
  cleanup() {
    try {
      const files = fs.readdirSync(this.tempDir);
      for (const file of files) {
        if (file.startsWith('ocr_')) {
          fs.unlinkSync(path.join(this.tempDir, file));
        }
      }
    } catch (error) {
      console.error('Cleanup error:', error.message);
    }
  }

  /**
   * Clean OCR text - remove common OCR artifacts and normalize
   */
  cleanOCRText(text) {
    if (!text) return '';
    
    let cleaned = text;
    
    // Fix common OCR character substitutions
    const ocrFixes = [
      [/\|/g, 'I'],           // Pipe often misread as I
      [/0(?=[a-zA-Z])/g, 'O'], // Zero before letters -> O
      [/1(?=[a-zA-Z])/g, 'l'], // One before letters -> l
      [/\s{3,}/g, '  '],      // Multiple spaces -> double space
      [/\n{4,}/g, '\n\n\n'],  // Multiple newlines -> max 3
      [/[^\x20-\x7E\n\r\t]/g, ''], // Remove non-printable chars (keep basic ASCII)
    ];
    
    for (const [pattern, replacement] of ocrFixes) {
      cleaned = cleaned.replace(pattern, replacement);
    }
    
    // Remove lines that are just noise (single chars, just punctuation)
    const lines = cleaned.split('\n');
    const cleanedLines = lines.filter(line => {
      const trimmed = line.trim();
      // Keep empty lines for paragraph breaks
      if (trimmed === '') return true;
      // Remove lines that are just punctuation or single characters
      if (/^[^a-zA-Z0-9]*$/.test(trimmed)) return false;
      if (trimmed.length === 1) return false;
      // Remove lines that look like OCR garbage (mostly special chars)
      const alphanumCount = (trimmed.match(/[a-zA-Z0-9]/g) || []).length;
      if (alphanumCount < trimmed.length * 0.3 && trimmed.length > 5) return false;
      return true;
    });
    
    return cleanedLines.join('\n').trim();
  }
}

module.exports = new OCRService();
