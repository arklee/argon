import { EnvHttpProxyAgent, getGlobalDispatcher, setGlobalDispatcher, type Dispatcher } from "undici";

export interface ProxyEnvironment {
  httpProxy?: string;
  httpsProxy?: string;
  noProxy?: string;
}

type ResolvedProxyEnvironment = ProxyEnvironment & {
  signature: string;
};

let originalDispatcher: Dispatcher | undefined;
let activeProxyDispatcher: Dispatcher | undefined;
let activeProxySignature: string | undefined;

export function configureGlobalProxyFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  const proxy = resolveProxyEnv(env);
  if (!proxy) {
    restoreOriginalDispatcher();
    return false;
  }

  if (proxy.signature === activeProxySignature) return true;
  if (!originalDispatcher) originalDispatcher = getGlobalDispatcher();

  const { signature, ...agentOptions } = proxy;
  const nextDispatcher = new EnvHttpProxyAgent(agentOptions);
  const previousDispatcher = activeProxyDispatcher;

  setGlobalDispatcher(nextDispatcher);
  activeProxyDispatcher = nextDispatcher;
  activeProxySignature = signature;

  closeDispatcher(previousDispatcher);
  return true;
}

export function resolveProxyEnv(env: NodeJS.ProcessEnv = process.env): ResolvedProxyEnvironment | undefined {
  const explicitHttpProxy = firstEnv(env, "http_proxy", "HTTP_PROXY");
  const explicitHttpsProxy = firstEnv(env, "https_proxy", "HTTPS_PROXY");
  const allProxy = firstEnv(env, "all_proxy", "ALL_PROXY");
  const noProxy = firstEnv(env, "no_proxy", "NO_PROXY");

  const httpProxy = explicitHttpProxy ?? allProxy;
  const httpsProxy = explicitHttpsProxy ?? allProxy ?? explicitHttpProxy;
  if (!httpProxy && !httpsProxy) return undefined;

  const proxy: ProxyEnvironment = {
    ...(httpProxy ? { httpProxy } : {}),
    ...(httpsProxy ? { httpsProxy } : {}),
    ...(noProxy ? { noProxy } : {})
  };
  return {
    ...proxy,
    signature: JSON.stringify(proxy)
  };
}

function restoreOriginalDispatcher(): void {
  if (!originalDispatcher || !activeProxyDispatcher) return;

  const previousDispatcher = activeProxyDispatcher;
  setGlobalDispatcher(originalDispatcher);
  activeProxyDispatcher = undefined;
  activeProxySignature = undefined;
  closeDispatcher(previousDispatcher);
}

function closeDispatcher(dispatcher: Dispatcher | undefined): void {
  if (!dispatcher) return;
  void dispatcher.close().catch(() => undefined);
}

function firstEnv(env: NodeJS.ProcessEnv, lowerName: string, upperName: string): string | undefined {
  return nonEmpty(env[lowerName]) ?? nonEmpty(env[upperName]);
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
