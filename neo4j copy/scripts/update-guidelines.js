/**
 * Auto-update Development Guidelines
 * Scans codebase for pattern changes and updates guidelines accordingly
 */

const fs = require('fs').promises;
const path = require('path');
const { execSync } = require('child_process');

class GuidelinesUpdater {
  constructor() {
    this.guidelinesPath = path.join(__dirname, '../DEVELOPMENT_GUIDELINES.md');
    this.serverPath = path.join(__dirname, '../server');
    this.clientPath = path.join(__dirname, '../client');
  }

  async updateGuidelines() {
    console.log('🔍 Analyzing codebase patterns...');
    
    const patterns = await this.analyzeCodebasePatterns();
    const currentGuidelines = await fs.readFile(this.guidelinesPath, 'utf8');
    
    let updatedGuidelines = currentGuidelines;
    let hasChanges = false;

    // Update service patterns
    if (patterns.newServices.length > 0) {
      updatedGuidelines = this.updateServicePatterns(updatedGuidelines, patterns.newServices);
      hasChanges = true;
    }

    // Update API patterns
    if (patterns.newRoutes.length > 0) {
      updatedGuidelines = this.updateAPIPatterns(updatedGuidelines, patterns.newRoutes);
      hasChanges = true;
    }

    // Update database patterns
    if (patterns.newDatabasePatterns.length > 0) {
      updatedGuidelines = this.updateDatabasePatterns(updatedGuidelines, patterns.newDatabasePatterns);
      hasChanges = true;
    }

    // Update dependencies
    if (patterns.newDependencies.length > 0) {
      updatedGuidelines = this.updateDependencyPatterns(updatedGuidelines, patterns.newDependencies);
      hasChanges = true;
    }

    if (hasChanges) {
      // Add timestamp
      const timestamp = new Date().toISOString().split('T')[0];
      updatedGuidelines = updatedGuidelines.replace(
        /Last Updated: \d{4}-\d{2}-\d{2}/,
        `Last Updated: ${timestamp}`
      );

      await fs.writeFile(this.guidelinesPath, updatedGuidelines);
      console.log('✅ Guidelines updated with new patterns');
      return true;
    }

    console.log('ℹ️  No guideline updates needed');
    return false;
  }

  async analyzeCodebasePatterns() {
    const patterns = {
      newServices: [],
      newRoutes: [],
      newDatabasePatterns: [],
      newDependencies: []
    };

    // Analyze services
    const serviceFiles = await this.getFiles(path.join(this.serverPath, 'services'), '.js');
    for (const file of serviceFiles) {
      const content = await fs.readFile(file, 'utf8');
      if (this.isNewServicePattern(content)) {
        patterns.newServices.push(this.extractServicePattern(content, file));
      }
    }

    // Analyze routes
    const routeFiles = await this.getFiles(path.join(this.serverPath, 'routes'), '.js');
    for (const file of routeFiles) {
      const content = await fs.readFile(file, 'utf8');
      if (this.isNewRoutePattern(content)) {
        patterns.newRoutes.push(this.extractRoutePattern(content, file));
      }
    }

    // Analyze package.json changes
    const packageJson = JSON.parse(await fs.readFile(path.join(__dirname, '../package.json'), 'utf8'));
    patterns.newDependencies = this.getNewDependencies(packageJson);

    return patterns;
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

  isNewServicePattern(content) {
    // Check for new service patterns not documented in guidelines
    const patterns = [
      /class \w+Service extends BaseService/,
      /async \w+\(tenantId, workspaceId/,
      /this\.validateTenantContext/,
      /this\.withErrorHandling/
    ];
    
    return patterns.every(pattern => pattern.test(content));
  }

  extractServicePattern(content, filePath) {
    const className = content.match(/class (\w+Service)/)?.[1];
    const methods = content.match(/async (\w+)\(/g)?.map(m => m.replace('async ', '').replace('(', ''));
    
    return {
      name: className,
      file: path.basename(filePath),
      methods: methods || [],
      hasTenantValidation: /validateTenantContext/.test(content),
      hasErrorHandling: /withErrorHandling/.test(content)
    };
  }

  isNewRoutePattern(content) {
    // Check for new route patterns
    return /router\.(get|post|put|delete)/.test(content) && 
           /requireTenantContext/.test(content);
  }

  extractRoutePattern(content, filePath) {
    const routes = content.match(/router\.(get|post|put|delete)\(['"`]([^'"`]+)['"`]/g) || [];
    return {
      file: path.basename(filePath),
      routes: routes.map(r => r.match(/router\.(\w+)\(['"`]([^'"`]+)['"`]/)).map(m => ({
        method: m[1].toUpperCase(),
        path: m[2]
      }))
    };
  }

  getNewDependencies(packageJson) {
    // Compare with known dependencies in guidelines
    const knownDeps = [
      'express', 'cors', 'dotenv', 'multer', 'neo4j-driver', 
      'redis', 'openai', 'pdf-parse', 'bullmq', 'n3', 'uuid'
    ];
    
    const allDeps = {
      ...packageJson.dependencies,
      ...packageJson.devDependencies
    };
    
    return Object.keys(allDeps).filter(dep => !knownDeps.includes(dep));
  }

  updateServicePatterns(guidelines, newServices) {
    // Add new service patterns to guidelines
    const serviceSection = guidelines.match(/(### Service Class Structure[\s\S]*?)(?=###|$)/)?.[1];
    if (serviceSection && newServices.length > 0) {
      const examples = newServices.map(service => 
        `- **${service.name}**: ${service.methods.join(', ')}`
      ).join('\n');
      
      return guidelines.replace(
        serviceSection,
        serviceSection + `\n\n**Recently Added Services:**\n${examples}\n`
      );
    }
    return guidelines;
  }

  updateAPIPatterns(guidelines, newRoutes) {
    // Update API patterns section
    return guidelines; // Implement based on specific needs
  }

  updateDatabasePatterns(guidelines, newPatterns) {
    // Update database patterns section
    return guidelines; // Implement based on specific needs
  }

  updateDependencyPatterns(guidelines, newDeps) {
    if (newDeps.length === 0) return guidelines;
    
    const depsSection = guidelines.match(/(### Dependencies[\s\S]*?)(?=###|$)/)?.[1];
    if (depsSection) {
      const newDepsText = newDeps.map(dep => `- \`${dep}\`: [Document purpose and constraints]`).join('\n');
      return guidelines.replace(
        depsSection,
        depsSection + `\n\n**New Dependencies (require documentation):**\n${newDepsText}\n`
      );
    }
    return guidelines;
  }
}

// Run if called directly
if (require.main === module) {
  const updater = new GuidelinesUpdater();
  updater.updateGuidelines()
    .then(updated => {
      if (updated) {
        console.log('📋 Please review and commit the updated guidelines');
      }
      process.exit(0);
    })
    .catch(error => {
      console.error('❌ Failed to update guidelines:', error);
      process.exit(1);
    });
}

module.exports = GuidelinesUpdater;
