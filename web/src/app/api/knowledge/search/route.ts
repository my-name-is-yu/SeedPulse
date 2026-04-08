import { NextRequest, NextResponse } from 'next/server';
import { searchKnowledge } from '../../../../lib/pulseed-client';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { query, topK = 5 } = body;
    if (!query || typeof query !== 'string') {
      return NextResponse.json({ error: 'query is required' }, { status: 400 });
    }

    const normalizedTopK =
      typeof topK === 'number' && Number.isFinite(topK) && topK > 0
        ? Math.min(Math.floor(topK), 20)
        : 5;
    const results = await searchKnowledge(query, normalizedTopK);

    return NextResponse.json({
      query,
      topK: normalizedTopK,
      results,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
