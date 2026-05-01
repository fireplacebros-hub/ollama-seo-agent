import { useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import { useState, useRef } from "react";

export async function loader({ request }) {
  const { admin } = await authenticate.admin(request);
  const url = new URL(request.url);
  const cursor = url.searchParams.get("cursor");

  const query = cursor
    ? `{ products(first: 50, after: "${cursor}") { pageInfo { hasNextPage endCursor } nodes { id title description media(first: 10) { nodes { ... on MediaImage { id image { url altText } } } } } } }`
    : `{ products(first: 50) { pageInfo { hasNextPage endCursor } nodes { id title description media(first: 10) { nodes { ... on MediaImage { id image { url altText } } } } } } }`;

  const response = await admin.graphql(query);
  const { data } = await response.json();
  const { nodes, pageInfo } = data.products;

  return {
    products: nodes,
    hasNextPage: pageInfo.hasNextPage,
    endCursor: pageInfo.endCursor
  };
}

export async function action({ request }) {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const imageId = formData.get("imageId");
  const productTitle = formData.get("productTitle");
  const productDescription = formData.get("productDescription");
  const productId = formData.get("productId");

  let altText = "";
  try {
    const ollamaRes = await fetch("https://impose-eatery-goofball.ngrok-free.dev/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json", "ngrok-skip-browser-warning": "true" },
      body: JSON.stringify({
        model: "llama3.1:8b",
        prompt: `You are an SEO specialist. Write descriptive alt text for a product image. Product: ${productTitle}. Description: ${productDescription || "None"}. Rules: minimum 80 characters, maximum 125 characters, include product name, be specific and descriptive, do NOT start with Image of, return ONLY the alt text on a single line, no explanations, no bullet points.`,
        stream: false,
      }),
    });
    const ollamaData = await ollamaRes.json();
    altText = ollamaData.response?.trim().split("\n")[0].replace(/^["\']|["\']$/g, "") || "";
  } catch (e) {
    return { error: "Ollama error: " + e.message };
  }

  if (!altText) return { error: "Ollama returned empty response" };
  if (altText.length < 80) return { error: `Alt text too short (${altText.length} chars). Try regenerating.` };

  try {
    const updateRes = await admin.graphql(
      `mutation updateProductImage($productId: ID!, $media: [UpdateMediaInput!]!) {
        productUpdateMedia(productId: $productId, media: $media) {
          media { ... on MediaImage { id image { altText } } }
          userErrors { field message }
        }
      }`,
      { variables: { productId, media: [{ id: imageId, alt: altText }] } }
    );
    const updateData = await updateRes.json();
    const errors = updateData.data?.productUpdateMedia?.userErrors;
    if (errors?.length > 0) return { error: errors[0].message };
  } catch (e) {
    return { error: "Shopify error: " + e.message };
  }

  return { success: true, altText, imageId };
}

export default function SeoAltText() {
  const initialData = useLoaderData();
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(false);
  const [progress, setProgress] = useState({ generated: 0, skipped: 0, failed: 0, current: "" });
  const stopRef = useRef(false);

  const generateOne = async (mediaId, productTitle, productDescription, productId) => {
    const formData = new FormData();
    formData.append("imageId", mediaId);
    formData.append("productTitle", productTitle);
    formData.append("productDescription", productDescription || "");
    formData.append("productId", productId);
    try {
      const res = await fetch("https://ollama-seo-agent.onrender.com/app/seo-alttext", { method: "POST", body: formData });
      const data = await res.json();
      return data;
    } catch {
      return { error: "Request failed" };
    }
  };

  const handleRunAll = async () => {
    setRunning(true);
    setDone(false);
    stopRef.current = false;
    const keepAlive = setInterval(() => fetch("https://ollama-seo-agent.onrender.com/app/seo-alttext"), 60000);
    let cursor = null;
    let hasMore = true;
    let generated = 0, skipped = 0, failed = 0;

    while (hasMore && !stopRef.current) {
      const url = cursor
        ? `/app/seo-products-api?cursor=${cursor}`
        : "/app/seo-products-api";

      let pageData;
      try {
        const res = await fetch(url.replace("/app/seo-alttext", "/app/seo-products-api"), { headers: { "Accept": "application/json" } });
        const text = await res.text(); console.log("Page response:", text.substring(0, 200)); pageData = JSON.parse(text);
      } catch {
        break;
      }

      for (const product of pageData.products) {
        if (stopRef.current) break;
        for (const media of product.media.nodes.filter(m => m.image)) {
          if (stopRef.current) break;
          if (media.image.altText) {
            skipped++;
            setProgress({ generated, skipped, failed, current: product.title });
            continue;
          }
          setProgress({ generated, skipped, failed, current: product.title });
          const result = await generateOne(media.id, product.title, product.description, product.id);
          if (result.success) generated++;
          else failed++;
          setProgress({ generated, skipped, failed, current: product.title });
        }
      }

      hasMore = pageData.hasNextPage;
      cursor = pageData.endCursor;
    }

    clearInterval(keepAlive);
    setRunning(false);
    setDone(true);
    setProgress(prev => ({ ...prev, current: "Complete!" }));
  };

  const handleStop = () => {
    stopRef.current = true;
  };

  return (
    <s-page heading="SEO Alt Text Generator">
      <s-section heading="Bulk Alt Text Generator">
        <s-paragraph>
          Automatically generates SEO alt text (80-125 chars) for all products using Ollama llama3.1:8b on your Mac.
          Products are processed silently in batches. Do not close this page while running.
        </s-paragraph>

        <div style={{ marginTop: "16px", display: "flex", gap: "12px" }}>
          {!running && !done && (
            <button
              onClick={handleRunAll}
              style={{ padding: "10px 20px", cursor: "pointer", background: "#008060", color: "#fff", border: "none", borderRadius: "4px", fontSize: "15px", fontWeight: "bold" }}
            >
              Start Generating All Alt Text
            </button>
          )}
          {running && (
            <button
              onClick={handleStop}
              style={{ padding: "10px 20px", cursor: "pointer", background: "#d82c0d", color: "#fff", border: "none", borderRadius: "4px", fontSize: "15px" }}
            >
              Stop
            </button>
          )}
          {done && (
            <button
              onClick={handleRunAll}
              style={{ padding: "10px 20px", cursor: "pointer", background: "#008060", color: "#fff", border: "none", borderRadius: "4px", fontSize: "15px" }}
            >
              Run Again
            </button>
          )}
        </div>

        {(running || done) && (
          <div style={{ marginTop: "24px", padding: "20px", background: "#f6f6f7", borderRadius: "8px" }}>
            <div style={{ fontSize: "18px", fontWeight: "bold", marginBottom: "12px", color: done ? "#008060" : "#333" }}>
              {done ? "✅ Complete!" : "⚙️ Running..."}
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "16px", marginBottom: "16px" }}>
              <div style={{ textAlign: "center", padding: "12px", background: "#d4edda", borderRadius: "6px" }}>
                <div style={{ fontSize: "28px", fontWeight: "bold", color: "#155724" }}>{progress.generated}</div>
                <div style={{ fontSize: "13px", color: "#155724" }}>Generated</div>
              </div>
              <div style={{ textAlign: "center", padding: "12px", background: "#fff3cd", borderRadius: "6px" }}>
                <div style={{ fontSize: "28px", fontWeight: "bold", color: "#856404" }}>{progress.skipped}</div>
                <div style={{ fontSize: "13px", color: "#856404" }}>Already Had Alt Text</div>
              </div>
              <div style={{ textAlign: "center", padding: "12px", background: "#f8d7da", borderRadius: "6px" }}>
                <div style={{ fontSize: "28px", fontWeight: "bold", color: "#721c24" }}>{progress.failed}</div>
                <div style={{ fontSize: "13px", color: "#721c24" }}>Failed</div>
              </div>
            </div>
            {running && (
              <div style={{ fontSize: "13px", color: "#6d7175" }}>
                Currently processing: <strong>{progress.current}</strong>
              </div>
            )}
          </div>
        )}
      </s-section>
    </s-page>
  );
}
