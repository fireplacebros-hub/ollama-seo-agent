const MAX_CHARS = 155;

export async function action({ request }) {
  const formData = await request.formData();
  const title = formData.get("title") || "";
  const body = formData.get("body") || "";
  const resourceType = formData.get("resourceType") || "page";
  const isCollection = resourceType === "collection";

  try {
    const ollamaRes = await fetch("https://impose-eatery-goofball.ngrok-free.dev/api/generate", {
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
    const ollamaData = await ollamaRes.json();
    let generated = ollamaData.response?.trim().split("\n")[0].replace(/^["\']|["\']$/g, "") || "";
    if (generated.length > MAX_CHARS) {
      const cut = generated.slice(0, MAX_CHARS - 3);
      generated = cut.slice(0, cut.lastIndexOf(" ")) + "...";
    }
    if (!generated) return Response.json({ error: "Ollama returned empty response" });
    return Response.json({ generated });
  } catch (e) {
    return Response.json({ error: `Ollama unreachable: ${e.message} — is the ngrok tunnel running?` });
  }
}
