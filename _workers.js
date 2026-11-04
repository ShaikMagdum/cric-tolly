export default {
  async fetch(request, env) {
    const reqUrl = new URL(request.url);

    // Route /api/proxy requests to the Edge Proxy
    if (reqUrl.pathname === "/api/proxy") {
      if (request.method === "OPTIONS") {
        return new Response(null, {
          status: 204,
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, HEAD, POST, OPTIONS",
            "Access-Control-Allow-Headers": "*",
            "Access-Control-Max-Age": "86400"
          }
        });
      }

      const targetUrl = reqUrl.searchParams.get("url");
      const customReferer = reqUrl.searchParams.get("referer") || "";
      const customOrigin = reqUrl.searchParams.get("origin") || "";
      const customCookie = reqUrl.searchParams.get("cookie") || "";
      const customUA =
        reqUrl.searchParams.get("ua") ||
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

      if (!targetUrl) {
        return new Response(JSON.stringify({ error: "Missing ?url= parameter" }), {
          status: 400,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
        });
      }

      let parsedTarget;
      try {
        parsedTarget = new URL(targetUrl);
      } catch (_) {
        return new Response(JSON.stringify({ error: "Invalid target URL" }), {
          status: 400,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
        });
      }

      const upstreamHeaders = new Headers();
      upstreamHeaders.set("User-Agent", customUA);
      upstreamHeaders.set("Accept", "*/*");
      upstreamHeaders.set("Accept-Language", "en-US,en;q=0.9");
      upstreamHeaders.set("Referer", customReferer || `${parsedTarget.protocol}//${parsedTarget.host}/`);

      if (customOrigin) upstreamHeaders.set("Origin", customOrigin);
      if (customCookie) upstreamHeaders.set("Cookie", customCookie);
      if (request.headers.get("Range")) upstreamHeaders.set("Range", request.headers.get("Range"));
      if (request.headers.get("Content-Type")) upstreamHeaders.set("Content-Type", request.headers.get("Content-Type"));

      const buildProxyLink = (absUrl) => {
        const p = new URL("/api/proxy", reqUrl.origin);
        p.searchParams.set("url", absUrl);
        if (customReferer) p.searchParams.set("referer", customReferer);
        if (customOrigin) p.searchParams.set("origin", customOrigin);
        if (customCookie) p.searchParams.set("cookie", customCookie);
        return p.href;
      };

      try {
        const fetchOpts = { method: request.method, headers: upstreamHeaders, redirect: "follow" };
        if (request.method === "POST") fetchOpts.body = await request.arrayBuffer();

        const upstreamRes = await fetch(parsedTarget.href, fetchOpts);
        const finalUrl = upstreamRes.url || parsedTarget.href;
        const baseUrl = new URL(".", finalUrl).href;
        const contentType = (upstreamRes.headers.get("content-type") || "").toLowerCase();
        const cleanPath = new URL(finalUrl).pathname.toLowerCase();

        const responseHeaders = new Headers({
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, HEAD, POST, OPTIONS",
          "Access-Control-Allow-Headers": "*",
          "Access-Control-Expose-Headers": "Content-Length, Content-Range, Content-Type, Date",
          "Cache-Control": "no-store, no-cache, must-revalidate"
        });

        if (upstreamRes.headers.get("content-range")) {
          responseHeaders.set("Content-Range", upstreamRes.headers.get("content-range"));
        }

        const isM3u8 = cleanPath.endsWith(".m3u8") || contentType.includes("mpegurl") || contentType.includes("x-mpegurl");
        if (isM3u8 && upstreamRes.ok) {
          const text = await upstreamRes.text();
          const rewritten = text
            .split(/\r?\n/)
            .map((line) => {
              const trimmed = line.trim();
              if (!trimmed) return line;
              if (trimmed.startsWith("#")) {
                return line.replace(/URI="([^"]+)"/g, (_, uri) => {
                  try { return `URI="${buildProxyLink(new URL(uri, baseUrl).href)}"`; }
                  catch (_) { return `URI="${uri}"`; }
                });
              }
              try { return buildProxyLink(new URL(trimmed, baseUrl).href); }
              catch (_) { return line; }
            })
            .join("\n");

          responseHeaders.set("Content-Type", "application/vnd.apple.mpegurl");
          return new Response(rewritten, { status: upstreamRes.status, headers: responseHeaders });
        }

        const isMpd = cleanPath.endsWith(".mpd") || contentType.includes("dash+xml");
        if (isMpd && upstreamRes.ok) {
          let xml = await upstreamRes.text();
          if (!/<BaseURL>/i.test(xml)) {
            xml = xml.replace(/<MPD([^>]*)>/i, `<MPD$1>\n  <BaseURL>${baseUrl}</BaseURL>`);
          }
          responseHeaders.set("Content-Type", "application/dash+xml");
          return new Response(xml, { status: upstreamRes.status, headers: responseHeaders });
        }

        if (contentType) responseHeaders.set("Content-Type", contentType);
        return new Response(upstreamRes.body, { status: upstreamRes.status, headers: responseHeaders });
      } catch (err) {
        return new Response(JSON.stringify({ error: "Proxy Error", details: err.message }), {
          status: 502,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
        });
      }
    }

    // Serve static files (index.html, player.html, admin.html, data.json)
    return env.ASSETS.fetch(request);
  }
};