// netlify/edge-functions/claude-proxy.js
//
// Proxies AI requests from the Kinetiq client to the Anthropic API.
//
// WHY THIS EXISTS:
// The Anthropic API key used to live directly in index.html (window.ANTHROPIC_API_KEY),
// which means it was visible to anyone who viewed the page source on the live site.
// This function moves the key server-side. Set ANTHROPIC_API_KEY in:
//   Netlify dashboard > Site configuration > Environment variables
// (scope it to "Functions" / "All scopes" so Edge Functions can read it via Netlify.env).
// A new deploy is required after adding/changing the env var.
//
// The client now calls POST /api/claude with the same body shape it used to send
// straight to Anthropic: { model, max_tokens, system, messages, stream }.
// This function fills in the API key + required headers and forwards the request.
// Streaming responses are piped straight through so callClaudeStream() keeps working.

export default async (request, context) => {
  if (request.method !== "POST") {
    return new Response(
      JSON.stringify({ error: { message: "Method not allowed" } }),
      { status: 405, headers: { "Content-Type": "application/json" } }
    );
  }

  const apiKey = Netlify.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) {
    return new Response(
      JSON.stringify({
        error: {
          message:
            "Server is missing ANTHROPIC_API_KEY. Add it in Netlify > Site configuration > Environment variables, then redeploy.",
        },
      }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }

  let payload;
  try {
    payload = await request.json();
  } catch {
    return new Response(
      JSON.stringify({ error: { message: "Invalid JSON body" } }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  const { messages, system, max_tokens, model, stream } = payload || {};

  if (!Array.isArray(messages) || messages.length === 0) {
    return new Response(
      JSON.stringify({ error: { message: '"messages" array is required' } }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  const anthropicBody = {
    model: typeof model === "string" && model ? model : "claude-sonnet-4-5-20250929",
    // Clamp to a sane ceiling so a malformed/abusive request can't ask for an
    // enormous completion.
    max_tokens: Math.min(Math.max(Number(max_tokens) || 1024, 1), 8000),
    messages,
  };
  if (system) anthropicBody.system = system;
  if (stream) anthropicBody.stream = true;

  let upstream;
  try {
    upstream = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(anthropicBody),
    });
  } catch (err) {
    return new Response(
      JSON.stringify({ error: { message: "Could not reach Anthropic: " + String(err) } }),
      { status: 502, headers: { "Content-Type": "application/json" } }
    );
  }

  // Pass the response straight through — works for both the streamed
  // (text/event-stream) and non-streamed (application/json) cases.
  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      "Content-Type": upstream.headers.get("Content-Type") || "application/json",
    },
  });
};

export const config = {
  path: "/api/claude",
  // Basic abuse/cost protection on this now-public endpoint. 40 requests per
  // minute per IP is generous for a trainer + their clients but caps a
  // runaway loop or scripted abuse. Raise this if it starts rejecting real
  // usage (check function logs / 429 rate in Netlify).
  rateLimit: {
    windowLimit: 40,
    windowSize: 60,
    aggregateBy: ["ip", "domain"],
  },
};
