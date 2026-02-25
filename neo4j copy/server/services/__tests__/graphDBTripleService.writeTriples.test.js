/**
 * Tests for writeTriplesToGraphDB audit integration (Task 7.2)
 */

const graphDBTripleService = require('../graphDBTripleService');
const auditService = require('../auditService');
const graphDBStore = require('../graphDBStore');

// Mock dependencies
jest.mock('../auditService', () => ({
  preCommitAudit: jest.fn(),
}));

jest.mock('../graphDBStore', () => ({
  getDataGraphIRI: jest.fn(() => 'http://purplefabric.ai/graphs/tenant/t1/workspace/w1/data'),
  baseUrl: 'http://localhost:7200',
  repository: 'test-repo',
  _fetchWithPool: jest.fn(),
}));

jest.mock('../../utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

describe('writeTriplesToGraphDB with audit integration', () => {
  const tenantId = 't1';
  const workspaceId = 'w1';
  const triples = [
    '<http://example.org/entity/1> <http://example.org/prop> "value"^^<http://www.w3.org/2001/XMLSchema#string> .',
  ];

  beforeEach(() => {
    jest.clearAllMocks();
    graphDBStore._fetchWithPool.mockResolvedValue({ ok: true });
  });

  test('throws if triples array is empty', async () => {
    await expect(
      graphDBTripleService.writeTriplesToGraphDB(tenantId, workspaceId, [])
    ).rejects.toThrow('No triples to write');
  });

  test('throws if triples is null', async () => {
    await expect(
      graphDBTripleService.writeTriplesToGraphDB(tenantId, workspaceId, null)
    ).rejects.toThrow('No triples to write');
  });

  test('skips audit when no sourceDocumentURI is provided (backward compat)', async () => {
    const result = await graphDBTripleService.writeTriplesToGraphDB(tenantId, workspaceId, triples);

    expect(auditService.preCommitAudit).not.toHaveBeenCalled();
    expect(graphDBStore._fetchWithPool).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(true);
    expect(result.tripleCount).toBe(1);
  });

  test('skips audit when options is empty object', async () => {
    const result = await graphDBTripleService.writeTriplesToGraphDB(tenantId, workspaceId, triples, {});

    expect(auditService.preCommitAudit).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
  });

  test('runs audit flow when sourceDocumentURI is provided', async () => {
    auditService.preCommitAudit.mockResolvedValue({
      changeCount: 1,
      entityURIsToDelete: [],
    });

    const result = await graphDBTripleService.writeTriplesToGraphDB(
      tenantId, workspaceId, triples, { sourceDocumentURI: 'doc://test-doc' }
    );

    expect(auditService.preCommitAudit).toHaveBeenCalledWith(
      tenantId, workspaceId, triples, 'doc://test-doc'
    );
    expect(result.success).toBe(true);
    expect(result.tripleCount).toBe(1);
  });

  test('deletes old triples when audit returns entityURIsToDelete', async () => {
    const entityURIs = ['http://example.org/entity/1', 'http://example.org/entity/2'];
    auditService.preCommitAudit.mockResolvedValue({
      changeCount: 2,
      entityURIsToDelete: entityURIs,
    });

    // deleteEntityTriples uses _fetchWithPool for SPARQL DELETE
    // First call = deleteEntityTriples, second call = batch POST insert
    graphDBStore._fetchWithPool.mockResolvedValue({ ok: true });

    const deleteEntitySpy = jest.spyOn(graphDBTripleService, 'deleteEntityTriples');

    await graphDBTripleService.writeTriplesToGraphDB(
      tenantId, workspaceId, triples, { sourceDocumentURI: 'doc://test-doc' }
    );

    expect(deleteEntitySpy).toHaveBeenCalledWith(tenantId, workspaceId, entityURIs);
    deleteEntitySpy.mockRestore();
  });

  test('skips delete when entityURIsToDelete is empty', async () => {
    auditService.preCommitAudit.mockResolvedValue({
      changeCount: 0,
      entityURIsToDelete: [],
    });

    const deleteEntitySpy = jest.spyOn(graphDBTripleService, 'deleteEntityTriples');

    await graphDBTripleService.writeTriplesToGraphDB(
      tenantId, workspaceId, triples, { sourceDocumentURI: 'doc://test-doc' }
    );

    expect(deleteEntitySpy).not.toHaveBeenCalled();
    deleteEntitySpy.mockRestore();
  });

  test('aborts data write and throws when audit fails', async () => {
    auditService.preCommitAudit.mockRejectedValue(new Error('GraphDB connection timeout'));

    await expect(
      graphDBTripleService.writeTriplesToGraphDB(
        tenantId, workspaceId, triples, { sourceDocumentURI: 'doc://test-doc' }
      )
    ).rejects.toThrow('Audit failed, aborting data write: GraphDB connection timeout');

    // Data graph POST should NOT have been called
    expect(graphDBStore._fetchWithPool).not.toHaveBeenCalled();
  });

  test('still inserts triples via batch POST after audit + delete', async () => {
    auditService.preCommitAudit.mockResolvedValue({
      changeCount: 1,
      entityURIsToDelete: ['http://example.org/entity/1'],
    });

    await graphDBTripleService.writeTriplesToGraphDB(
      tenantId, workspaceId, triples, { sourceDocumentURI: 'doc://test-doc' }
    );

    // _fetchWithPool called for: deleteEntityTriples (1) + batch POST (1)
    expect(graphDBStore._fetchWithPool).toHaveBeenCalledTimes(2);

    // The second call should be the POST with turtle content
    const postCall = graphDBStore._fetchWithPool.mock.calls[1];
    expect(postCall[1].method).toBe('POST');
    expect(postCall[1].headers['Content-Type']).toBe('text/turtle');
    expect(postCall[1].body).toContain(triples[0]);
  });
});
