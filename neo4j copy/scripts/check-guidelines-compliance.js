/**
 * Guidelines Compliance Checker
 * Validates code against development guidelines and suggests updates
 */

const fs = require('fs').promises;
const path = require('path');

class GuidelinesChecker {
  constructor() {
    this.violations = [];
    this.suggestions = [];
  }

  async checkCompliance() {
    console.log('🔍 Checking guidelines compliance...');
    
    await this.checkServicePatterns();
    await this.checkRoutePatterns();
    await this.checkSecurityPatterns();
    await this.checkNamingConventions();
    await this.checkErrorHandling();
    
    this.generateReport();
  }

  async checkServicePatterns() {
    const serviceFiles = await this.getFiles('server/services', '.js');
    
    for (const file of serviceFiles) {
      const content = await fs.readFile(file, 'utf8');
      const fileName = path.basename(file);
      
      // Check service naming
      if (!fileName.endsWith('Service.js')) {
        this.violations.push({
          type: 'naming',
          file: fileName,
          rule: 'Services must end with "Service.js"',
          severity: 'error'
        });
      }
      
      // Check for tenant validation
      if (content.includes('tenantId') && !content.includes('validateTenantContext')) {
        this.violations.push({
          type: 'security',
          file: fileName,
          rule: 'Services handling tenant data must validate tenant context',
          severity: 'error'
        });
      }
      
      // Check for error handling
      if (!content.includes('withErrorHandling') && !content.includes('try {')) {
        this.violations.push({
          type: 'error_handling',
          file: fileName,
          rule: 'Services must implement proper error handling',
          severity: 'warning'
        });
      }
      
      // Check for dependency injection
      if (content.includes('require(') && !content.includes('dependencies =')) {
        this.suggestions.push({
          type: 'architecture',
          file: fileName,
          suggestion: 'Consider using dependency injection pattern for better testability'
        });
      }
    }
  }

  async checkRoutePatterns() {
    const routeFiles = await this.getFiles('server/routes', '.js');
    
    for (const file of routeFiles) {
      const content = await fs.readFile(file, 'utf8');
      const fileName = path.basename(file);
      
      // Check for tenant context middleware
      if (content.includes('/tenants/') && !content.includes('requireTenantContext')) {
        this.violations.push({
          type: 'security',
          file: fileName,
          rule: 'Multi-tenant routes must use requireTenantContext middleware',
          severity: 'error'
        });
      }
      
      // Check response format
      if (content.includes('res.json') && !content.includes('success:')) {
        this.violations.push({
          type: 'api_format',
          file: fileName,
          rule: 'API responses must follow standard format with success field',
          severity: 'warning'
        });
      }
    }
  }

  async checkSecurityPatterns() {
    const allFiles = [
      ...await this.getFiles('server/services', '.js'),
      ...await this.getFiles('server/routes', '.js')
    ];
    
    for (const file of allFiles) {
      const content = await fs.readFile(file, 'utf8');
      const fileName = path.basename(file);
      
      // Check for SQL injection risks
      if (content.includes('${') && content.includes('query')) {
        this.violations.push({
          type: 'security',
          file: fileName,
          rule: 'Use parameterized queries to prevent injection attacks',
          severity: 'error'
        });
      }
      
      // Check for hardcoded credentials
      if (content.match(/(password|secret|key)\s*[:=]\s*['"][^'"]+['"]/i)) {
        this.violations.push({
          type: 'security',
          file: fileName,
          rule: 'No hardcoded credentials allowed',
          severity: 'error'
        });
      }
    }
  }

  async checkNamingConventions() {
    // Check file naming
    const allFiles = await this.getFiles('server', '.js');
    
    for (const file of allFiles) {
      const fileName = path.basename(file);
      
      // Check camelCase for files
      if (fileName.includes('_') && !fileName.includes('test')) {
        this.violations.push({
          type: 'naming',
          file: fileName,
          rule: 'Use camelCase for file names, not snake_case',
          severity: 'warning'
        });
      }
    }
  }

  async checkErrorHandling() {
    const serviceFiles = await this.getFiles('server/services', '.js');
    
    for (const file of serviceFiles) {
      const content = await fs.readFile(file, 'utf8');
      const fileName = path.basename(file);
      
      // Check for proper error classes
      if (content.includes('throw new Error') && !content.includes('ValidationError')) {
        this.suggestions.push({
          type: 'error_handling',
          file: fileName,
          suggestion: 'Use custom error classes (ValidationError, NotFoundError, etc.) instead of generic Error'
        });
      }
    }
  }

  async getFiles(dir, extension) {
    const files = [];
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          files.push(...await this.getFiles(fullPath, extension));
        } else if (entry.name.endsWith(extension)) {
          files.push(fullPath);
        }
      }
    } catch (error) {
      // Directory doesn't exist, skip
    }
    return files;
  }

  generateReport() {
    console.log('\n📋 Guidelines Compliance Report\n');
    
    if (this.violations.length === 0 && this.suggestions.length === 0) {
      console.log('✅ All guidelines compliance checks passed!');
      return;
    }
    
    // Group violations by severity
    const errors = this.violations.filter(v => v.severity === 'error');
    const warnings = this.violations.filter(v => v.severity === 'warning');
    
    if (errors.length > 0) {
      console.log('❌ ERRORS (must fix):');
      errors.forEach(error => {
        console.log(`   ${error.file}: ${error.rule}`);
      });
      console.log('');
    }
    
    if (warnings.length > 0) {
      console.log('⚠️  WARNINGS (should fix):');
      warnings.forEach(warning => {
        console.log(`   ${warning.file}: ${warning.rule}`);
      });
      console.log('');
    }
    
    if (this.suggestions.length > 0) {
      console.log('💡 SUGGESTIONS (consider):');
      this.suggestions.forEach(suggestion => {
        console.log(`   ${suggestion.file}: ${suggestion.suggestion}`);
      });
      console.log('');
    }
    
    // Summary
    console.log(`📊 Summary: ${errors.length} errors, ${warnings.length} warnings, ${this.suggestions.length} suggestions`);
    
    if (errors.length > 0) {
      console.log('\n🔧 To auto-fix some issues, run: npm run guidelines:update');
      process.exit(1);
    }
  }
}

// Run if called directly
if (require.main === module) {
  const checker = new GuidelinesChecker();
  checker.checkCompliance().catch(error => {
    console.error('❌ Compliance check failed:', error);
    process.exit(1);
  });
}

module.exports = GuidelinesChecker;
