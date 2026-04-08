import { describe, it, expect, vi } from 'vitest';

vi.mock('next/server', () => ({
  NextResponse: {
    json: (data: unknown, init?: { status?: number }) => ({
      _body: data,
      status: init?.status ?? 200,
      json: async () => data,
    }),
  },
  NextRequest: class {},
}));

const mockSearchKnowledge = vi.fn();
const mockListKnowledgeTransfers = vi.fn();

vi.mock('../../web/src/lib/pulseed-client', () => ({
  searchKnowledge: (...args: unknown[]) => mockSearchKnowledge(...args),
  listKnowledgeTransfers: (...args: unknown[]) => mockListKnowledgeTransfers(...args),
}));

const { GET: getTransfers } = await import('../../web/src/app/api/knowledge/transfers/route.js');
const { POST: postSearch } = await import('../../web/src/app/api/knowledge/search/route.js');

describe('GET /api/knowledge/transfers', () => {
  it('returns transfers plus transfer results and effectiveness metadata', async () => {
    mockListKnowledgeTransfers.mockResolvedValueOnce({
      transfers: [
        {
          candidate_id: 'tc_1',
          source_goal_id: 'goal-a',
          target_goal_id: 'goal-b',
          type: 'pattern',
          source_item_id: 'pattern-1',
          similarity_score: 0.91,
          estimated_benefit: 'Reuses a proven structure',
          state: 'proposed',
          domain_tag_match: true,
          adapted_content: null,
          effectiveness_score: null,
          proposed_at: null,
          applied_at: null,
          invalidated_at: null,
          result: {
            transfer_id: 'tr_1',
            candidate_id: 'tc_1',
            applied_at: '2026-04-08T00:00:00.000Z',
            adaptation_description: 'Adapted pattern for target',
            success: true,
          },
          effectiveness: null,
        },
      ],
      results: [
        {
          transfer_id: 'tr_1',
          candidate_id: 'tc_1',
          applied_at: '2026-04-08T00:00:00.000Z',
          adaptation_description: 'Adapted pattern for target',
          success: true,
        },
      ],
      effectiveness_records: [],
    });

    const res = await getTransfers();
    const body = await res.json();
    expect(Array.isArray(body.transfers)).toBe(true);
    expect(body.transfers).toHaveLength(1);
    expect(body.transfers[0].result.transfer_id).toBe('tr_1');
    expect(Array.isArray(body.results)).toBe(true);
    expect(Array.isArray(body.effectiveness_records)).toBe(true);
  });

  it('has status 200', async () => {
    mockListKnowledgeTransfers.mockResolvedValueOnce({
      transfers: [],
      results: [],
      effectiveness_records: [],
    });
    const res = await getTransfers();
    expect(res.status).toBe(200);
  });
});

describe('POST /api/knowledge/search', () => {
  function makeRequest(body: unknown) {
    return {
      json: async () => body,
    } as import('next/server').NextRequest;
  }

  it('returns provenance-rich search results with query', async () => {
    mockSearchKnowledge.mockResolvedValueOnce([
      {
        entry_id: 'entry-1',
        question: 'How do I reduce scope?',
        answer: 'Trim to the critical path.',
        sources: [{ type: 'expert', reference: 'playbook', reliability: 'high' }],
        confidence: 0.92,
        acquired_at: '2026-04-08T00:00:00.000Z',
        acquisition_task_id: 'task-1',
        superseded_by: null,
        tags: ['scope', 'planning'],
        embedding_id: 'entry-1',
        source_goal_ids: ['goal-a'],
        domain_stability: 'moderate',
        revalidation_due_at: null,
        similarity: 0.98,
      },
    ]);

    const res = await postSearch(makeRequest({ query: 'test query', topK: 3 }));
    const body = await res.json();
    expect(Array.isArray(body.results)).toBe(true);
    expect(body.results).toHaveLength(1);
    expect(body.results[0].sources[0].reference).toBe('playbook');
    expect(body.results[0].source_goal_ids).toEqual(['goal-a']);
    expect(body.query).toBe('test query');
    expect(body.topK).toBe(3);
  });

  it('uses default topK=5 when not specified', async () => {
    mockSearchKnowledge.mockResolvedValueOnce([]);
    const res = await postSearch(makeRequest({ query: 'my query' }));
    const body = await res.json();
    expect(body.topK).toBe(5);
  });

  it('returns 400 when query is missing', async () => {
    const res = await postSearch(makeRequest({ topK: 5 }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('query');
  });

  it('returns 400 when query is not a string', async () => {
    const res = await postSearch(makeRequest({ query: 42 }));
    expect(res.status).toBe(400);
  });
});
