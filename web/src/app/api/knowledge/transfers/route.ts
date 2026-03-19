import { NextResponse } from 'next/server';

export async function GET() {
  try {
    // KnowledgeTransfer requires LLM client for instantiation.
    // Return placeholder for now; full integration in 18.5.
    return NextResponse.json({
      transfers: [],
      message: 'Knowledge transfer listing — integration pending 18.5',
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
