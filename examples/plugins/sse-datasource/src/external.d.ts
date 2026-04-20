declare module "eventsource" {
  export interface MessageEvent {
    data: unknown;
  }

  export interface EventSourceInit {
    headers?: Record<string, string>;
  }

  export default class EventSource {
    static readonly OPEN: number;
    readonly readyState: number;
    onopen: (() => void) | null;
    onerror: ((error: unknown) => void) | null;
    onmessage: ((event: MessageEvent) => void) | null;
    constructor(url: string, init?: EventSourceInit);
    addEventListener(eventType: string, listener: (event: MessageEvent) => void): void;
    close(): void;
  }
}
