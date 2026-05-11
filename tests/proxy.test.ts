import { describe, expect, it } from "vitest";
import { resolveProxyEnv } from "../src/provider/proxy.js";

describe("proxy environment", () => {
  it("returns undefined when no proxy is configured", () => {
    expect(resolveProxyEnv({})).toBeUndefined();
  });

  it("resolves lowercase proxy variables before uppercase ones", () => {
    expect(
      resolveProxyEnv({
        http_proxy: "http://lower-http:8080",
        HTTP_PROXY: "http://upper-http:8080",
        https_proxy: "http://lower-https:8080",
        HTTPS_PROXY: "http://upper-https:8080",
        no_proxy: "localhost",
        NO_PROXY: "example.com"
      })
    ).toMatchObject({
      httpProxy: "http://lower-http:8080",
      httpsProxy: "http://lower-https:8080",
      noProxy: "localhost"
    });
  });

  it("uses all_proxy as the scheme-specific fallback", () => {
    expect(
      resolveProxyEnv({
        all_proxy: "socks5://127.0.0.1:1080"
      })
    ).toMatchObject({
      httpProxy: "socks5://127.0.0.1:1080",
      httpsProxy: "socks5://127.0.0.1:1080"
    });
  });

  it("uses http_proxy for HTTPS when no HTTPS or all-proxy fallback exists", () => {
    expect(
      resolveProxyEnv({
        HTTP_PROXY: "http://proxy:8080"
      })
    ).toMatchObject({
      httpProxy: "http://proxy:8080",
      httpsProxy: "http://proxy:8080"
    });
  });
});
