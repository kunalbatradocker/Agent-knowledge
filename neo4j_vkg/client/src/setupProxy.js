const { createProxyMiddleware } = require('http-proxy-middleware');

module.exports = function(app) {
  // Read server port from environment variable (same as backend server uses)
  // Note: This runs in Node.js context, so we can access PORT/SERVER_PORT directly
  // The client port is set separately via PORT env var when starting React
  const apiPort = process.env.SERVER_PORT || process.env.PORT || 5002;
  const target = `http://localhost:${apiPort}`;
  
  // Only log startup message once
  console.log(`[Proxy] API requests → ${target}`);
  
  // Endpoints that should NOT be logged (frequent polling, health checks)
  const quietEndpoints = [
    '/api/graph/connection',
    '/api/graph/stats',
    '/api/ontology/jobs',
    '/api/ontology/documents',
    '/api/ontology/folders',
    '/api/ontology/all',
    '/api/entities',
    '/api/tenants'
  ];
  
  const shouldLogRequest = (url, statusCode) => {
    // Always log errors
    if (statusCode >= 400) return true;
    // Don't log quiet endpoints
    if (quietEndpoints.some(endpoint => url.startsWith(endpoint))) return false;
    // Don't log 304 Not Modified
    if (statusCode === 304) return false;
    // Log everything else
    return true;
  };

  app.use(
    '/api',
    createProxyMiddleware({
      target: target,
      changeOrigin: true,
      logLevel: 'silent', // Disable built-in logging
      secure: false,
      timeout: 300000, // 5 minute timeout (processing can take time with LLM)
      proxyTimeout: 300000, // Also set proxy timeout
      onError: (err, req, res) => {
        console.error(`[Proxy] ❌ ${req.method} ${req.url} - ${err.code || err.message}`);
        
        // Only send error if response hasn't been sent
        if (!res.headersSent) {
          if (err.code === 'ECONNREFUSED') {
            res.status(503).json({
              error: 'Server not available',
              message: `Cannot connect to server at ${target}. Make sure the server is running.`,
              target: target,
              tip: 'Run: npm run server (or npm run dev)'
            });
          } else {
            res.status(500).json({
              error: 'Proxy error',
              message: err.message,
              code: err.code
            });
          }
        }
      },
      onProxyRes: (proxyRes, req, res) => {
        const statusCode = proxyRes.statusCode;
        
        // Only log important requests
        if (shouldLogRequest(req.url, statusCode)) {
          const icon = statusCode >= 400 ? '❌' : '✓';
          console.log(`[Proxy] ${icon} ${req.method} ${req.url} → ${statusCode}`);
        }
      }
    })
  );
};

