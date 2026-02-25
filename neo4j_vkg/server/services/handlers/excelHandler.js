/**
 * Excel Handler - Process Excel workbooks with multi-sheet support
 */

const excelParser = require('../excelParser');
const logger = require('../../utils/logger');

class ExcelHandler {
  async extract(filePath, options = {}) {
    try {
      const parsed = await excelParser.parse(filePath, options);
      const flat = excelParser.flattenSheets(parsed);

      return {
        text: parsed.text,
        structured: {
          type: 'tabular',
          format: 'excel',
          sheets: parsed.sheets,
          data: flat.rows,
          headers: flat.headers,
          rowCount: flat.rowCount,
          sheetCount: parsed.sheets.length
        },
        metadata: {
          sheetNames: parsed.sheets.map(s => s.sheetName),
          rowCount: flat.rowCount,
          sheetCount: parsed.sheets.length,
          extractedAt: new Date().toISOString()
        }
      };
    } catch (error) {
      logger.error('Excel extraction failed:', error);
      throw error;
    }
  }
}

module.exports = new ExcelHandler();
