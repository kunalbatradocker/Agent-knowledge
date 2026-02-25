/**
 * LLM Token Middleware
 * Looks up the per-user Bedrock token from Redis (encrypted),
 * decrypts it, and makes it available to all LLM service calls
 * within the request via AsyncLocalStorage.
 */
const tokenStore = require('../utils/tokenEncryption');
const { llmRequestContext } = require('../services/llmService');

/**
 * Middleware: injects per-user Bedrock token into request-scoped context.
 * Must run AFTER requireAuth (needs req.user).
 */
function injectUserLLMToken(req, res, next) {
  const userId = req.user?.email || req.headers['x-user-id'] || 'default';

  tokenStore.getToken(userId)
    .then(token => {
      if (token) {
        console.log(`🔑 [LLM-Token] Found per-user token for: ${userId}`);
        llmRequestContext.run({ bedrockToken: token }, () => next());
      } else if (userId !== 'default') {
        // Fallback: try 'default' key (admin-set server token stored via Admin panel)
        return tokenStore.getToken('default').then(defaultToken => {
          if (defaultToken) {
            console.log(`🔑 [LLM-Token] No token for "${userId}", using admin-set default token`);
            llmRequestContext.run({ bedrockToken: defaultToken }, () => next());
          } else {
            console.log(`🔑 [LLM-Token] No token found for: ${userId} or default`);
            next();
          }
        });
      } else {
        console.log(`🔑 [LLM-Token] No token found for: ${userId}`);
        next();
      }
    })
    .catch((err) => {
      console.warn(`🔑 [LLM-Token] Error looking up token for ${userId}: ${err.message}`);
      next();
    });
}

module.exports = { injectUserLLMToken };
