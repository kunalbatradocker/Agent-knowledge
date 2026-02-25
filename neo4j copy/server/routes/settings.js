/**
 * Settings Routes
 * Manage application settings stored in Redis
 */

const express = require('express');
const router = express.Router();
const { client: redisClient } = require('../config/redis');
const logger = require('../utils/logger');

const SETTINGS_KEY = 'app:settings';

// Default settings
const DEFAULT_SETTINGS = {
  llm: {
    llmTimeout: 300,        // 5 minutes default
    extractionMode: 'auto', // auto, full, chunked
    chunkSize: 20000,       // 20K chars per chunk
    maxChars: 100000        // 100K max for full mode
  }
};

/**
 * GET /api/settings/llm
 * Get LLM settings
 */
router.get('/llm', async (req, res) => {
  try {
    const settingsJson = await redisClient.hGet(SETTINGS_KEY, 'llm');
    const settings = settingsJson ? JSON.parse(settingsJson) : DEFAULT_SETTINGS.llm;
    
    res.json({ 
      success: true, 
      settings: { ...DEFAULT_SETTINGS.llm, ...settings }
    });
  } catch (error) {
    logger.error('Error fetching LLM settings:', error.message);
    res.json({ success: true, settings: DEFAULT_SETTINGS.llm });
  }
});

/**
 * PUT /api/settings/llm
 * Update LLM settings
 */
router.put('/llm', async (req, res) => {
  try {
    const { llmTimeout, extractionMode, chunkSize, maxChars } = req.body;
    
    // Validate
    const settings = {
      llmTimeout: Math.max(60, Math.min(900, parseInt(llmTimeout) || 300)),
      extractionMode: ['auto', 'full', 'chunked'].includes(extractionMode) ? extractionMode : 'auto',
      chunkSize: Math.max(5000, Math.min(50000, parseInt(chunkSize) || 20000)),
      maxChars: Math.max(50000, Math.min(200000, parseInt(maxChars) || 100000))
    };
    
    await redisClient.hSet(SETTINGS_KEY, 'llm', JSON.stringify(settings));
    
    logger.info('LLM settings updated:', settings);
    
    res.json({ success: true, settings });
  } catch (error) {
    logger.error('Error saving LLM settings:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/settings/all
 * Get all settings
 */
router.get('/all', async (req, res) => {
  try {
    const allSettings = await redisClient.hGetAll(SETTINGS_KEY);
    const parsed = {};
    
    for (const [key, value] of Object.entries(allSettings)) {
      try {
        parsed[key] = JSON.parse(value);
      } catch {
        parsed[key] = value;
      }
    }
    
    res.json({ 
      success: true, 
      settings: { ...DEFAULT_SETTINGS, ...parsed }
    });
  } catch (error) {
    logger.error('Error fetching all settings:', error.message);
    res.json({ success: true, settings: DEFAULT_SETTINGS });
  }
});

module.exports = router;
