/**
 * Evaluation Service
 * Provides evaluation harness for comparing RAG vs GraphRAG performance
 * Supports golden questions and expected answers
 */

const graphRAGService = require('./graphRAGService');
const fs = require('fs');
const path = require('path');

class EvaluationService {
  constructor() {
    this.evaluationPath = path.join(__dirname, '../data/evaluations');
    this.ensureEvaluationDirectory();
  }

  ensureEvaluationDirectory() {
    if (!fs.existsSync(this.evaluationPath)) {
      fs.mkdirSync(this.evaluationPath, { recursive: true });
    }
  }

  /**
   * Run evaluation on a set of golden questions
   * @param {Array} goldenQuestions - Array of { question, expectedAnswer, expectedConcepts?, expectedRelations? }
   * @param {Object} options - Evaluation options
   * @returns {Promise<Object>} - Evaluation results
   */
  async evaluate(goldenQuestions, options = {}) {
    const {
      searchModes = ['rag', 'graph', 'hybrid'],
      topK = 5,
      graphDepth = 2
    } = options;

    const results = {
      timestamp: new Date().toISOString(),
      totalQuestions: goldenQuestions.length,
      modes: {},
      summary: {
        rag: { correct: 0, partial: 0, incorrect: 0, avgSimilarity: 0 },
        graph: { correct: 0, partial: 0, incorrect: 0, avgSimilarity: 0 },
        hybrid: { correct: 0, partial: 0, incorrect: 0, avgSimilarity: 0 }
      }
    };

    for (const mode of searchModes) {
      results.modes[mode] = [];
      let totalSimilarity = 0;

      for (const golden of goldenQuestions) {
        try {
          // Run query with specified mode
          const queryResult = await graphRAGService.query(golden.question, {
            searchMode: mode,
            topK: topK,
            graphDepth: graphDepth
          });

          // Evaluate answer quality
          const evaluation = this.evaluateAnswer(
            queryResult.answer,
            golden.expectedAnswer,
            golden.expectedConcepts,
            golden.expectedRelations,
            queryResult.sources
          );

          totalSimilarity += evaluation.similarity;
          results.modes[mode].push({
            question: golden.question,
            expectedAnswer: golden.expectedAnswer,
            actualAnswer: queryResult.answer,
            evaluation: evaluation,
            sources: {
              chunksUsed: queryResult.sources.chunks?.length || 0,
              conceptsFound: queryResult.sources.graphEntities?.length || 0,
              relationsFound: queryResult.sources.relations?.length || 0
            }
          });

          // Update summary
          if (evaluation.similarity >= 0.8) {
            results.summary[mode].correct++;
          } else if (evaluation.similarity >= 0.5) {
            results.summary[mode].partial++;
          } else {
            results.summary[mode].incorrect++;
          }
        } catch (error) {
          console.error(`Error evaluating question in ${mode} mode:`, error);
          results.modes[mode].push({
            question: golden.question,
            error: error.message,
            evaluation: { similarity: 0, status: 'error' }
          });
          results.summary[mode].incorrect++;
        }
      }

      // Calculate average similarity
      if (results.modes[mode].length > 0) {
        results.summary[mode].avgSimilarity = totalSimilarity / results.modes[mode].length;
      }
    }

    return results;
  }

  /**
   * Evaluate answer quality against expected answer
   * @param {string} actualAnswer - The generated answer
   * @param {string} expectedAnswer - The expected answer
   * @param {Array} expectedConcepts - Optional expected concepts
   * @param {Array} expectedRelations - Optional expected relations
   * @param {Object} sources - Query sources
   * @returns {Object} - Evaluation result
   */
  evaluateAnswer(actualAnswer, expectedAnswer, expectedConcepts = [], expectedRelations = [], sources = {}) {
    // Simple similarity based on keyword overlap
    const actualLower = actualAnswer.toLowerCase();
    const expectedLower = expectedAnswer.toLowerCase();

    // Extract keywords (simple approach)
    const actualKeywords = new Set(actualLower.match(/\b\w{4,}\b/g) || []);
    const expectedKeywords = new Set(expectedLower.match(/\b\w{4,}\b/g) || []);

    // Calculate keyword overlap
    const intersection = new Set([...actualKeywords].filter(x => expectedKeywords.has(x)));
    const union = new Set([...actualKeywords, ...expectedKeywords]);
    const keywordSimilarity = union.size > 0 ? intersection.size / union.size : 0;

    // Check for expected concepts
    let conceptScore = 0;
    if (expectedConcepts && expectedConcepts.length > 0) {
      const foundConcepts = expectedConcepts.filter(concept => 
        actualLower.includes(concept.toLowerCase()) ||
        sources.graphEntities?.some(e => e.label?.toLowerCase().includes(concept.toLowerCase()))
      );
      conceptScore = foundConcepts.length / expectedConcepts.length;
    }

    // Check for expected relations
    let relationScore = 0;
    if (expectedRelations && expectedRelations.length > 0) {
      const foundRelations = expectedRelations.filter(rel =>
        sources.relations?.some(r => 
          r.predicate?.toLowerCase().includes(rel.toLowerCase()) ||
          r.type?.toLowerCase().includes(rel.toLowerCase())
        )
      );
      relationScore = foundRelations.length / expectedRelations.length;
    }

    // Combined similarity score
    const similarity = (keywordSimilarity * 0.6) + (conceptScore * 0.2) + (relationScore * 0.2);

    let status = 'incorrect';
    if (similarity >= 0.8) {
      status = 'correct';
    } else if (similarity >= 0.5) {
      status = 'partial';
    }

    return {
      similarity: Math.round(similarity * 100) / 100,
      status: status,
      keywordSimilarity: Math.round(keywordSimilarity * 100) / 100,
      conceptScore: Math.round(conceptScore * 100) / 100,
      relationScore: Math.round(relationScore * 100) / 100
    };
  }

  /**
   * Save evaluation results to file
   */
  async saveEvaluation(results, filename = null) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filepath = path.join(
      this.evaluationPath,
      filename || `evaluation-${timestamp}.json`
    );

    fs.writeFileSync(filepath, JSON.stringify(results, null, 2));
    console.log(`✅ Evaluation saved to: ${filepath}`);
    return filepath;
  }

  /**
   * Load evaluation results from file
   */
  loadEvaluation(filename) {
    const filepath = path.join(this.evaluationPath, filename);
    if (!fs.existsSync(filepath)) {
      throw new Error(`Evaluation file not found: ${filename}`);
    }
    return JSON.parse(fs.readFileSync(filepath, 'utf-8'));
  }

  /**
   * List all evaluation files
   */
  listEvaluations() {
    if (!fs.existsSync(this.evaluationPath)) {
      return [];
    }
    return fs.readdirSync(this.evaluationPath)
      .filter(f => f.endsWith('.json'))
      .map(f => ({
        filename: f,
        filepath: path.join(this.evaluationPath, f),
        modified: fs.statSync(path.join(this.evaluationPath, f)).mtime
      }))
      .sort((a, b) => b.modified - a.modified);
  }

  /**
   * Compare two evaluation results
   */
  compareEvaluations(eval1, eval2) {
    const comparison = {
      timestamp: new Date().toISOString(),
      eval1: eval1.timestamp,
      eval2: eval2.timestamp,
      modes: {}
    };

    for (const mode of ['rag', 'graph', 'hybrid']) {
      if (eval1.summary[mode] && eval2.summary[mode]) {
        comparison.modes[mode] = {
          eval1: eval1.summary[mode],
          eval2: eval2.summary[mode],
          improvement: {
            correct: eval2.summary[mode].correct - eval1.summary[mode].correct,
            avgSimilarity: eval2.summary[mode].avgSimilarity - eval1.summary[mode].avgSimilarity
          }
        };
      }
    }

    return comparison;
  }
}

module.exports = new EvaluationService();

