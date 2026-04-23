export type GlobalCrossPlatformChatSessionManagerGetter = () => Promise<unknown>;

interface PulseedRuntimeGlobal {
  __pulseedGetGlobalCrossPlatformChatSessionManager?: GlobalCrossPlatformChatSessionManagerGetter;
}

let registeredGetter: GlobalCrossPlatformChatSessionManagerGetter | undefined;

export function registerGlobalCrossPlatformChatSessionManager(
  getter: GlobalCrossPlatformChatSessionManagerGetter,
): void {
  registeredGetter = getter;
}

export function exposeRegisteredCrossPlatformChatSessionManager(): void {
  const runtimeGlobal = globalThis as typeof globalThis & PulseedRuntimeGlobal;
  if (registeredGetter) {
    runtimeGlobal.__pulseedGetGlobalCrossPlatformChatSessionManager = registeredGetter;
    return;
  }
  delete runtimeGlobal.__pulseedGetGlobalCrossPlatformChatSessionManager;
}

export function clearRegisteredCrossPlatformChatSessionManager(): void {
  registeredGetter = undefined;
  delete (globalThis as typeof globalThis & PulseedRuntimeGlobal).__pulseedGetGlobalCrossPlatformChatSessionManager;
}
