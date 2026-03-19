/**
 * SSE endpoint — placeholder for 18.4 real-time updates.
 * Will connect to EventServer.subscribe() when integrated.
 */
export async function GET() {
  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      // Send initial heartbeat
      controller.enqueue(encoder.encode('data: {"type":"connected"}\n\n'));

      // Keep-alive every 30s
      const interval = setInterval(() => {
        try {
          controller.enqueue(encoder.encode('data: {"type":"heartbeat"}\n\n'));
        } catch {
          clearInterval(interval);
        }
      }, 30000);

      // Clean up on abort (handled by Next.js)
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}
