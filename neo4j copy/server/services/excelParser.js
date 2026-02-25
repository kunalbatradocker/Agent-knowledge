/**
 * Excel Parser Service
 * Reads all sheets from .xlsx/.xls workbooks and produces
 * a unified structure compatible with the CSV pipeline.
 */

const XLSX = require('xlsx');
const logger = require('../utils/logger');

class ExcelParser {
  /**
   * Parse an Excel workbook — returns every sheet as structured data
   * plus a combined text representation for LLM / chunking.
   */
  async parse(filePath, options = {}) {
    const { maxRows = 100000 } = options;

    try {
      const workbook = XLSX.readFile(filePath, { type: 'file', cellDates: true });
      const sheets = [];
      let combinedText = '';

      for (const sheetName of workbook.SheetNames) {
        const ws = workbook.Sheets[sheetName];
        const jsonRows = XLSX.utils.sheet_to_json(ws, { defval: '' });
        const rows = jsonRows.slice(0, maxRows);
        const headers = rows.length > 0 ? Object.keys(rows[0]) : [];

        // Build readable text for this sheet
        let sheetText = `\n=== Sheet: ${sheetName} (${rows.length} rows, ${headers.length} columns) ===\n`;
        sheetText += `Columns: ${headers.join(', ')}\n\n`;

        const sampleSize = Math.min(10, rows.length);
        for (let i = 0; i < sampleSize; i++) {
          sheetText += `Row ${i + 1}:\n`;
          headers.forEach(h => { sheetText += `  ${h}: ${rows[i][h]}\n`; });
          sheetText += '\n';
        }
        if (rows.length > sampleSize) {
          sheetText += `... and ${rows.length - sampleSize} more rows\n`;
        }

        combinedText += sheetText;

        sheets.push({
          sheetName,
          headers,
          rows,
          rowCount: rows.length,
          columnAnalysis: this.analyzeColumns(headers, rows)
        });
      }

      logger.info(`📊 Parsed Excel: ${sheets.length} sheet(s), ${sheets.reduce((s, sh) => s + sh.rowCount, 0)} total rows`);

      return { sheets, text: combinedText };
    } catch (error) {
      logger.error('Excel parsing failed:', error);
      throw error;
    }
  }

  /**
   * Flatten all sheets into a single rows array (for CSV-compatible pipeline).
   * Each row gets a __sheet column so the LLM can distinguish sources.
   */
  flattenSheets(parsed) {
    const allRows = [];
    const allHeaders = new Set(['__sheet']);

    for (const sheet of parsed.sheets) {
      sheet.headers.forEach(h => allHeaders.add(h));
      for (const row of sheet.rows) {
        allRows.push({ __sheet: sheet.sheetName, ...row });
      }
    }

    return {
      headers: Array.from(allHeaders),
      rows: allRows,
      rowCount: allRows.length,
      text: parsed.text
    };
  }

  analyzeColumns(headers, rows) {
    const columns = {};
    headers.forEach(header => {
      const values = rows.map(r => r[header]).filter(v => v != null && v !== '');
      const numericCount = values.filter(v => !isNaN(Number(v))).length;
      const isNumeric = values.length > 0 && numericCount / values.length > 0.8;
      const isId = /id$/i.test(header) || header.toLowerCase() === 'id';
      const isDate = /date|time|created|updated/i.test(header);
      columns[header] = { isNumeric, isId, isDate, uniqueCount: new Set(values).size };
    });
    return { columns };
  }
}

module.exports = new ExcelParser();
