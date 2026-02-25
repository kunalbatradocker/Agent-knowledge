/**
 * Simple Logger Utility
 * Controls log verbosity based on LOG_LEVEL environment variable
 * 
 * Levels: error, warn, info, debug
 * Default: info (shows error, warn, info)
 */

const LOG_LEVELS = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3
};

const currentLevel = LOG_LEVELS[process.env.LOG_LEVEL?.toLowerCase()] ?? LOG_LEVELS.info;

const logger = {
  error: (...args) => {
    if (currentLevel >= LOG_LEVELS.error) {
      console.error('❌', ...args);
    }
  },
  
  warn: (...args) => {
    if (currentLevel >= LOG_LEVELS.warn) {
      console.warn('⚠️', ...args);
    }
  },
  
  info: (...args) => {
    if (currentLevel >= LOG_LEVELS.info) {
      console.log(...args);
    }
  },
  
  debug: (...args) => {
    if (currentLevel >= LOG_LEVELS.debug) {
      console.log('🔍', ...args);
    }
  },
  
  // For important milestones - always shown
  milestone: (...args) => {
    console.log('✅', ...args);
  },
  
  // For job progress - always shown with job icon
  job: (...args) => {
    console.log('⚙️', ...args);
  },
  
  // For extraction progress - always shown
  extraction: (...args) => {
    console.log('🔄', ...args);
  }
};

module.exports = logger;
