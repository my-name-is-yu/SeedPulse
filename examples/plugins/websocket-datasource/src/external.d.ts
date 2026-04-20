declare module "ws" {
  export interface ClientOptions {
    headers?: Record<string, string>;
  }

  export default class WebSocket {
    static readonly OPEN: number;
    static readonly CONNECTING: number;
    readonly readyState: number;
    onopen: (() => void) | null;
    onerror: ((error: unknown) => void) | null;
    onmessage: ((event: { data: unknown }) => void) | null;
    constructor(url: string, protocols?: string | string[] | ClientOptions);
    on(event: "open", listener: () => void): void;
    on(event: "message", listener: (data: { toString(): string }) => void): void;
    on(event: "error", listener: (error: unknown) => void): void;
    on(event: "close", listener: () => void): void;
    close(): void;
  }
}
