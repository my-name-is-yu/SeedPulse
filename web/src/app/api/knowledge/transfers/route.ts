import { NextResponse } from 'next/server';
import { listKnowledgeTransfers } from '../../../../lib/pulseed-client';

export async function GET() {
  try {
    const snapshot = await listKnowledgeTransfers();
    return NextResponse.json({
      transfers: snapshot.transfers,
      results: snapshot.results,
      effectiveness_records: snapshot.effectiveness_records,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
