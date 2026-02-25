/**
 * Evaluation Routes
 * Handles evaluation endpoints for testing knowledge graph quality
 */

const express = require('express');
const router = express.Router();

/**
 * POST /evaluate
 * Run evaluation with golden questions
 */
router.post('/evaluate', async (req, res) => {
  try {
    const { goldenQuestions, options = {} } = req.body;
    
    if (!goldenQuestions || !Array.isArray(goldenQuestions)) {
      return res.status(400).json({ error: 'goldenQuestions array is required' });
    }

    const evaluationService = require('../../services/evaluationService');
    const result = await evaluationService.runEvaluation(goldenQuestions, options);
    
    res.json({
      success: true,
      evaluation: result
    });
  } catch (error) {
    console.error('Evaluation error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /evaluations
 * List all evaluation results
 */
router.get('/evaluations', async (_req, res) => {
  try {
    const evaluationService = require('../../services/evaluationService');
    const evaluations = await evaluationService.listEvaluations();
    res.json({ success: true, evaluations });
  } catch (error) {
    console.error('List evaluations error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /evaluations/:filename
 * Get a specific evaluation result
 */
router.get('/evaluations/:filename', async (req, res) => {
  try {
    const evaluationService = require('../../services/evaluationService');
    const evaluation = await evaluationService.getEvaluation(req.params.filename);
    res.json({ success: true, evaluation });
  } catch (error) {
    console.error('Get evaluation error:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
