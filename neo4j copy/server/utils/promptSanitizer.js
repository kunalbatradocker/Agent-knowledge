/**
 * Prompt Sanitizer — prevents prompt injection in LLM inputs
 * 
 * All user-provided data (column names, cell values, document text)
 * must be sanitized before interpolation into LLM prompts.
 */

const INJECTION_PATTERNS = [
  /ignore\s+(all\s+)?previous\s+instructions/i,
  /disregard\s+(all\s+)?above/i,
  /you\s+are\s+now/i,
  /system\s*:\s*/i,
  /\bprompt\s*:/i,
  /```\s*(system|assistant|user)/i,
  /\[INST\]/i,
  /<<SYS>>/i,
  /\bdo\s+not\s+follow/i,
  /override\s+(the\s+)?instructions/i,
  /forget\s+(everything|all)/i,
];

/**
 * Sanitize a single string value for safe LLM prompt interpolation.
 * Escapes control sequences and truncates to maxLen.
 */
function sanitizeValue(value, maxLen = 500) {
  if (value === null || value === undefined) return '';
  let str = String(value);
  
  // Truncate
  if (str.length > maxLen) {
    str = str.substring(0, maxLen) + '…';
  }
  
  // Replace backtick sequences that could break prompt formatting
  str = str.replace(/```/g, '\'\'\'');
  
  // Neutralize injection patterns by inserting zero-width spaces
  for (const pattern of INJECTION_PATTERNS) {
    str = str.replace(pattern, (match) => {
      // Insert invisible marker to break the pattern
      return match.split('').join('\u200B');
    });
  }
  
  return str;
}

/**
 * Sanitize an array of column headers
 */
function sanitizeHeaders(headers, maxLen = 100) {
  return headers.map(h => sanitizeValue(h, maxLen));
}

/**
 * Sanitize sample rows for prompt inclusion.
 * Limits row count and value lengths.
 */
function sanitizeSampleRows(rows, maxRows = 10, maxValueLen = 200) {
  return rows.slice(0, maxRows).map(row => {
    const sanitized = {};
    for (const [key, value] of Object.entries(row)) {
      if (key === '__sheet') {
        sanitized[key] = value; // internal marker, keep as-is
      } else {
        sanitized[sanitizeValue(key, 100)] = sanitizeValue(value, maxValueLen);
      }
    }
    return sanitized;
  });
}

/**
 * Sanitize document text for prompt inclusion.
 * Truncates and neutralizes injection patterns.
 */
function sanitizeDocumentText(text, maxLen = 30000) {
  if (!text) return '';
  let sanitized = text;
  if (sanitized.length > maxLen) {
    sanitized = sanitized.substring(0, maxLen) + '\n...[truncated]';
  }
  // Neutralize injection patterns in document text
  for (const pattern of INJECTION_PATTERNS) {
    sanitized = sanitized.replace(pattern, (match) => {
      return match.split('').join('\u200B');
    });
  }
  return sanitized;
}

/**
 * Sanitize ontology class/property descriptions for prompt inclusion.
 */
function sanitizeOntologyContext(ontology, maxClasses = 50, maxProps = 100) {
  if (!ontology) return { classes: [], properties: [], objectProperties: [], dataProperties: [] };
  
  const sanitizeList = (list, max) => (list || []).slice(0, max).map(item => ({
    ...item,
    label: sanitizeValue(item.label || item.localName || '', 100),
    comment: sanitizeValue(item.comment || item.description || '', 300),
    domain: sanitizeValue(item.domain || '', 100),
    range: sanitizeValue(item.range || item.rangeLabel || '', 100),
  }));
  
  return {
    classes: sanitizeList(ontology.classes, maxClasses),
    properties: sanitizeList(ontology.properties, maxProps),
    objectProperties: sanitizeList(ontology.objectProperties, maxProps),
    dataProperties: sanitizeList(ontology.dataProperties, maxProps),
  };
}

module.exports = {
  sanitizeValue,
  sanitizeHeaders,
  sanitizeSampleRows,
  sanitizeDocumentText,
  sanitizeOntologyContext,
  INJECTION_PATTERNS,
};
