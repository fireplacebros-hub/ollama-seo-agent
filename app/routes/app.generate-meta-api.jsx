const MAX_CHARS = 155;

// eslint-disable-next-line no-undef
const OLLAMA_BASE = (process.env.OLLAMA_HOST || "").replace(/\/$/, "");

export async function action({ request }) {
  if (!OLLAMA_BASE) {
    return Response.json({ error: "OLLAMA_HOST environment variable is not set on the server." });
  }

  const formData = await request.formData();
  const title = formData.get("title") || "";
  const body = formData.get("body") || "";
  const resourceType = formData.get("resourceType") || "page";
  const isCollection = resourceType === "collection";

  let ollamaRes;
  try {
    ollamaRes = await fetch(`${OLLAMA_BASE}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "ngrok-skip-browser-warning": "true" },
      body: JSON.stringify({
        model: "llama3.1:8b",
        prompt: isCollection
          ? `You are an SEO copywriter. Write a meta description for this product collection page.\n\nCollection name: ${title}\nCollection description: ${body || "None provided"}\n\nSTRICT RULES:\n- Total length must be 120-155 characters. Count every character including spaces before submitting.\n- Describe what products are in this collection.\n- End with a short action phrase.\n- Return ONLY the meta description on a single line. No quotes. No labels. No explanation.`
          : `You are an SEO copywriter. Write a meta description for this page.\n\nPage title: ${title}\n\nSTRICT RULES:\n- Total length must be 120-155 characters. Count every character including spaces before submitting.\n- Describe what the page is about clearly and specifically.\n- End with a short action phrase or benefit.\n- Return ONLY the meta description on a single line. No quotes. No labels. No explanation.`,
        stream: false,
      }),
      signal: AbortSignal.timeout(30000),
    });
  } catch (e) {
    return Response.json({ error: `Cannot reach Ollama at ${OLLAMA_BASE} — start ngrok and Ollama, then try again. (${e.message})` });
  }

  const text = await ollamaRes.text();

  if (!ollamaRes.ok || text.trimStart().startsWith("<")) {
    const hint = ollamaRes.status === 404
      ? "ngrok tunnel is offline"
      : ollamaRes.status === 502
      ? "ngrok tunnel is running but Ollama is not"
      : `HTTP ${ollamaRes.status}`;
    return Response.json({ error: `Ollama unavailable (${hint}) — run: ngrok http --domain=impose-eatery-goofball.ngrok-free.dev 11434` });
  }

  let ollamaData;
  try {
    ollamaData = JSON.parse(text);
  } catch {
    return Response.json({ error: `Ollama returned unexpected response: ${text.slice(0, 120)}` });
  }

  let generated = ollamaData.response?.trim().split("\n")[0].replace(/^["\']|["\']$/g, "") || "";
  if (generated.length > MAX_CHARS) {
    const cut = generated.slice(0, MAX_CHARS - 3);
    generated = cut.slice(0, cut.lastIndexOf(" ")) + "...";
  }
  if (!generated) return Response.json({ error: "Ollama returned an empty response" });
  return Response.json({ generated });
}
