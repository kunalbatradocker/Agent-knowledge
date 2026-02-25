const fs = require('fs');
const path = require('path');
const { Store, Parser } = require('n3');
const xml2js = require('xml2js');

class OntologyParser {
  constructor() {
    this.store = new Store();
  }

  async parseFile(filePath, mimeType) {
    const ext = path.extname(filePath).toLowerCase();
    
    try {
      if (ext === '.owl' || ext === '.rdf' || mimeType?.includes('xml')) {
        return await this.parseOWL(filePath);
      } else if (ext === '.ttl' || ext === '.turtle' || mimeType?.includes('turtle')) {
        return await this.parseTurtle(filePath);
      } else if (ext === '.json' || ext === '.jsonld' || mimeType?.includes('json')) {
        return await this.parseJSONLD(filePath);
      } else {
        throw new Error(`Unsupported file format: ${ext}`);
      }
    } catch (error) {
      throw new Error(`Failed to parse ontology file: ${error.message}`);
    }
  }

  async parseOWL(filePath) {
    const fileContent = fs.readFileSync(filePath, 'utf-8');
    const parser = new xml2js.Parser();
    const result = await parser.parseStringPromise(fileContent);
    
    const ontology = {
      uri: this.extractURI(result),
      classes: [],
      properties: [],
      individuals: [],
      relationships: []
    };

    // Parse OWL classes
    if (result['rdf:RDF']?.['owl:Class']) {
      const classes = Array.isArray(result['rdf:RDF']['owl:Class']) 
        ? result['rdf:RDF']['owl:Class'] 
        : [result['rdf:RDF']['owl:Class']];
      
      classes.forEach(cls => {
        ontology.classes.push({
          uri: cls.$?.['rdf:about'] || cls.$?.['rdf:ID'],
          label: this.extractLabel(cls),
          comment: this.extractComment(cls),
          subClassOf: this.extractSubClassOf(cls)
        });
      });
    }

    // Parse OWL Object Properties
    if (result['rdf:RDF']?.['owl:ObjectProperty']) {
      const props = Array.isArray(result['rdf:RDF']['owl:ObjectProperty'])
        ? result['rdf:RDF']['owl:ObjectProperty']
        : [result['rdf:RDF']['owl:ObjectProperty']];
      
      props.forEach(prop => {
        ontology.properties.push({
          uri: prop.$?.['rdf:about'] || prop.$?.['rdf:ID'],
          label: this.extractLabel(prop),
          comment: this.extractComment(prop),
          domain: this.extractDomain(prop),
          range: this.extractRange(prop)
        });
      });
    }

    // Parse Individuals
    if (result['rdf:RDF']?.['owl:NamedIndividual']) {
      const individuals = Array.isArray(result['rdf:RDF']['owl:NamedIndividual'])
        ? result['rdf:RDF']['owl:NamedIndividual']
        : [result['rdf:RDF']['owl:NamedIndividual']];
      
      individuals.forEach(ind => {
        ontology.individuals.push({
          uri: ind.$?.['rdf:about'] || ind.$?.['rdf:ID'],
          label: this.extractLabel(ind),
          type: this.extractType(ind)
        });
      });
    }

    return ontology;
  }

  async parseTurtle(filePath) {
    const fileContent = fs.readFileSync(filePath, 'utf-8');
    const parser = new Parser();
    const quads = parser.parse(fileContent);
    
    this.store.addQuads(quads);

    const ontology = {
      uri: this.extractURITurtle(),
      classes: [],
      properties: [],
      individuals: [],
      relationships: []
    };

    // Extract classes
    const classQuads = this.store.getQuads(null, 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', 'http://www.w3.org/2002/07/owl#Class', null);
    classQuads.forEach(quad => {
      ontology.classes.push({
        uri: quad.subject.value,
        label: this.getLabel(quad.subject),
        comment: this.getComment(quad.subject),
        subClassOf: this.getSubClassOf(quad.subject)
      });
    });

    // Extract object properties
    const propQuads = this.store.getQuads(null, 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', 'http://www.w3.org/2002/07/owl#ObjectProperty', null);
    propQuads.forEach(quad => {
      ontology.properties.push({
        uri: quad.subject.value,
        label: this.getLabel(quad.subject),
        comment: this.getComment(quad.subject),
        domain: this.getDomain(quad.subject),
        range: this.getRange(quad.subject)
      });
    });

    return ontology;
  }

  async parseJSONLD(filePath) {
    const fileContent = fs.readFileSync(filePath, 'utf-8');
    const data = JSON.parse(fileContent);
    
    const ontology = {
      uri: data['@id'] || data['@context']?.['@vocab'] || 'http://purplefabric.ai/ontology',
      classes: [],
      properties: [],
      individuals: [],
      relationships: []
    };

    // Parse JSON-LD structure
    if (Array.isArray(data['@graph'])) {
      data['@graph'].forEach(item => {
        if (item['@type']?.includes('http://www.w3.org/2002/07/owl#Class')) {
          ontology.classes.push({
            uri: item['@id'],
            label: item['http://www.w3.org/2000/01/rdf-schema#label']?.[0]?.['@value'] || item['rdfs:label']?.[0]?.['@value'],
            comment: item['http://www.w3.org/2000/01/rdf-schema#comment']?.[0]?.['@value'],
            subClassOf: item['http://www.w3.org/2000/01/rdf-schema#subClassOf']?.map(s => s['@id'] || s)
          });
        }
      });
    }

    return ontology;
  }

  // Helper methods for OWL parsing
  extractURI(result) {
    return result['rdf:RDF']?.['owl:Ontology']?.[0]?.$?.['rdf:about'] || 
           result['rdf:RDF']?.['owl:Ontology']?.[0]?.$?.['rdf:ID'] ||
           'http://purplefabric.ai/ontology';
  }

  extractLabel(item) {
    if (item['rdfs:label']) {
      const labels = Array.isArray(item['rdfs:label']) ? item['rdfs:label'] : [item['rdfs:label']];
      return labels.find(l => l.$?.['xml:lang'] === 'en' || !l.$?.['xml:lang'])?._ || labels[0]?._;
    }
    return null;
  }

  extractComment(item) {
    if (item['rdfs:comment']) {
      const comments = Array.isArray(item['rdfs:comment']) ? item['rdfs:comment'] : [item['rdfs:comment']];
      return comments.find(c => c.$?.['xml:lang'] === 'en' || !c.$?.['xml:lang'])?._ || comments[0]?._;
    }
    return null;
  }

  extractSubClassOf(item) {
    if (item['rdfs:subClassOf']) {
      const subClasses = Array.isArray(item['rdfs:subClassOf']) ? item['rdfs:subClassOf'] : [item['rdfs:subClassOf']];
      return subClasses.map(sc => sc.$?.['rdf:resource'] || sc.$?.['rdf:about']).filter(Boolean);
    }
    return [];
  }

  extractDomain(item) {
    if (item['rdfs:domain']) {
      const domains = Array.isArray(item['rdfs:domain']) ? item['rdfs:domain'] : [item['rdfs:domain']];
      return domains.map(d => d.$?.['rdf:resource'] || d.$?.['rdf:about']).filter(Boolean);
    }
    return [];
  }

  extractRange(item) {
    if (item['rdfs:range']) {
      const ranges = Array.isArray(item['rdfs:range']) ? item['rdfs:range'] : [item['rdfs:range']];
      return ranges.map(r => r.$?.['rdf:resource'] || r.$?.['rdf:about']).filter(Boolean);
    }
    return [];
  }

  extractType(item) {
    if (item['rdf:type']) {
      const types = Array.isArray(item['rdf:type']) ? item['rdf:type'] : [item['rdf:type']];
      return types.map(t => t.$?.['rdf:resource'] || t.$?.['rdf:about']).filter(Boolean);
    }
    return [];
  }

  // Helper methods for Turtle parsing
  extractURITurtle() {
    const ontologyQuads = this.store.getQuads(null, 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', 'http://www.w3.org/2002/07/owl#Ontology', null);
    return ontologyQuads.length > 0 ? ontologyQuads[0].subject.value : 'http://purplefabric.ai/ontology';
  }

  getLabel(subject) {
    const labelQuads = this.store.getQuads(subject, 'http://www.w3.org/2000/01/rdf-schema#label', null, null);
    const enLabel = labelQuads.find(q => q.object.language === 'en');
    return enLabel ? enLabel.object.value : (labelQuads[0]?.object.value || null);
  }

  getComment(subject) {
    const commentQuads = this.store.getQuads(subject, 'http://www.w3.org/2000/01/rdf-schema#comment', null, null);
    const enComment = commentQuads.find(q => q.object.language === 'en');
    return enComment ? enComment.object.value : (commentQuads[0]?.object.value || null);
  }

  getSubClassOf(subject) {
    const subClassQuads = this.store.getQuads(subject, 'http://www.w3.org/2000/01/rdf-schema#subClassOf', null, null);
    return subClassQuads.map(q => q.object.value);
  }

  getDomain(subject) {
    const domainQuads = this.store.getQuads(subject, 'http://www.w3.org/2000/01/rdf-schema#domain', null, null);
    return domainQuads.map(q => q.object.value);
  }

  getRange(subject) {
    const rangeQuads = this.store.getQuads(subject, 'http://www.w3.org/2000/01/rdf-schema#range', null, null);
    return rangeQuads.map(q => q.object.value);
  }
}

module.exports = new OntologyParser();

