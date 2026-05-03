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
  const [products, setProducts] = useState(initialData.products);
  const [hasNextPage, setHasNextPage] = useState(initialData.hasNextPage);
  const [endCursor, setEndCursor] = useState(initialData.endCursor);
  const [loadingMore, setLoadingMore] = useState(false);
  const [allResults, setAllResults] = useState({});
  const [allGenerating, setAllGenerating] = useState({});
  const [bulkRunning, setBulkRunning] = useState(false);
  const [bulkProgress, setBulkProgress] = useState({ done: 0, total: 0 });
  const bulkStopRef = useRef(false);

  const loadMore = async () => {
    setLoadingMore(true);
    try {
      const res = await fetch(`/app/seo-products-api?cursor=${endCursor}`);
      const data = await res.json();
      setProducts(prev => [...prev, ...data.products]);
      setHasNextPage(data.hasNextPage);
      setEndCursor(data.endCursor);
    } catch {
      alert("Failed to load more products");
    }
    setLoadingMore(false);
  };

  const generateOne = async (mediaId, productTitle, productDescription, productId) => {
    setAllGenerating(prev => ({ ...prev, [mediaId]: true }));
    const formData = new FormData();
    formData.append("imageId", mediaId);
    formData.append("productTitle", productTitle);
    formData.append("productDescription", productDescription || "");
    formData.append("productId", productId);
    try {
      const res = await fetch("https://ollama-seo-agent.onrender.com/app/seo-alttext", { method: "POST", body: formData });
      const data = await res.json();
      setAllResults(prev => ({ ...prev, [mediaId]: data }));
    } catch {
      setAllResults(prev => ({ ...prev, [mediaId]: { error: "Request failed" } }));
    }
    setAllGenerating(prev => ({ ...prev, [mediaId]: false }));
  };

  const generateAll = async () => {
    setBulkRunning(true);
    bulkStopRef.current = false;

    let allProducts = [...products];
    let cursor = endCursor;
    let hasMore = hasNextPage;
    while (hasMore) {
      try {
        const res = await fetch(`/app/seo-products-api?cursor=${cursor}`);
        const data = await res.json();
        allProducts = [...allProducts, ...data.products];
        setProducts(allProducts);
        hasMore = data.hasNextPage;
        cursor = data.endCursor;
        setHasNextPage(hasMore);
        setEndCursor(cursor);
      } catch {
        break;
      }
    }

    const queue = allProducts.flatMap(p =>
      p.media.nodes.filter(m => m.image && !m.image.altText).map(m => ({ mediaId: m.id, productTitle: p.title, productDescription: p.description, productId: p.id }))
    );
    setBulkProgress({ done: 0, total: queue.length });

    for (let i = 0; i < queue.length; i++) {
      if (bulkStopRef.current) break;
      const { mediaId, productTitle, productDescription, productId } = queue[i];
      await generateOne(mediaId, productTitle, productDescription, productId);
      setBulkProgress({ done: i + 1, total: queue.length });
    }

    setBulkRunning(false);
  };

  const allImages = products.flatMap(p => p.media.nodes.filter(m => m.image));
  const totalImages = allImages.length;
  const alreadyDone = allImages.filter(m => m.image.altText && !allResults[m.id]).length;
  const generatedNow = Object.values(allResults).filter(r => r.success).length;
  const failed = Object.values(allResults).filter(r => r.error).length;
  const missingAlt = allImages.filter(m => !m.image.altText && !allResults[m.id]?.success).length;

  const statCell = (label, value, color) => (
    <td style={{ padding: "10px 20px", textAlign: "center", borderRight: "1px solid #e1e3e5" }}>
      <div style={{ fontSize: "22px", fontWeight: "700", color }}>{value}</div>
      <div style={{ fontSize: "12px", color: "#6d7175", marginTop: "2px" }}>{label}</div>
    </td>
  );

  return (
    <s-page heading="SEO Tools">
      <s-section>
        <div style={{ display: "flex", gap: "0", borderBottom: "2px solid #e1e3e5", marginBottom: "4px" }}>
          <a href="/app/seo-alttext"  style={{ padding: "10px 24px", fontWeight: "600", fontSize: "14px", color: "#008060", borderBottom: "2px solid #008060", marginBottom: "-2px", textDecoration: "none", background: "none" }}>Alt Text</a>
          <a href="/app/seo-metadesc" style={{ padding: "10px 24px", fontWeight: "600", fontSize: "14px", color: "#6d7175", borderBottom: "2px solid transparent", marginBottom: "-2px", textDecoration: "none" }}>Meta Descriptions</a>
          <a href="/app/seo-runner"   style={{ padding: "10px 24px", fontWeight: "600", fontSize: "14px", color: "#6d7175", borderBottom: "2px solid transparent", marginBottom: "-2px", textDecoration: "none" }}>Run Both</a>
        </div>
      </s-section>
      <s-section>
        <table style={{ width: "100%", borderCollapse: "collapse", border: "1px solid #e1e3e5", borderRadius: "8px", overflow: "hidden" }}>
          <tbody>
            <tr>
              {statCell("Already complete", alreadyDone, "#008060")}
              {statCell("Generated this session", generatedNow, "#008060")}
              {statCell("Failed", failed, failed > 0 ? "#d72c0d" : "#6d7175")}
              {statCell("Missing", missingAlt, missingAlt > 0 ? "#c4481a" : "#6d7175")}
              <td style={{ padding: "10px 20px", textAlign: "center" }}>
                <div style={{ fontSize: "22px", fontWeight: "700", color: "#333" }}>{totalImages}</div>
                <div style={{ fontSize: "12px", color: "#6d7175", marginTop: "2px" }}>Images loaded{hasNextPage ? " (more available)" : ""}</div>
              </td>
            </tr>
          </tbody>
        </table>
      </s-section>
      <s-section>
        <s-paragraph>Generate SEO alt text (80-125 chars) using Ollama. Generate All loads remaining products automatically then runs through every missing image.</s-paragraph>
        <div style={{ marginTop: "12px", display: "flex", gap: "12px", alignItems: "center", flexWrap: "wrap" }}>
          {!bulkRunning ? (
            <button
              onClick={generateAll}
              disabled={missingAlt === 0}
              style={{ padding: "8px 20px", cursor: missingAlt === 0 ? "not-allowed" : "pointer", background: "#008060", color: "#fff", border: "none", borderRadius: "4px", fontSize: "14px", fontWeight: "600" }}
            >
              Generate All Missing ({missingAlt})
            </button>
          ) : (
            <>
              <button
                onClick={() => { bulkStopRef.current = true; }}
                style={{ padding: "8px 20px", cursor: "pointer", background: "#d72c0d", color: "#fff", border: "none", borderRadius: "4px", fontSize: "14px", fontWeight: "600" }}
              >
                Stop
              </button>
              <div style={{ flex: 1, minWidth: "200px" }}>
                <div style={{ fontSize: "13px", color: "#333", marginBottom: "4px" }}>
                  Generating {bulkProgress.done} of {bulkProgress.total}...
                </div>
                <div style={{ height: "6px", background: "#e1e3e5", borderRadius: "3px", overflow: "hidden" }}>
                  <div style={{ height: "100%", background: "#008060", borderRadius: "3px", width: `${bulkProgress.total ? (bulkProgress.done / bulkProgress.total) * 100 : 0}%`, transition: "width 0.3s ease" }} />
                </div>
              </div>
            </>
          )}
          {hasNextPage && !bulkRunning && (
            <button
              onClick={loadMore}
              disabled={loadingMore}
              style={{ padding: "8px 16px", cursor: loadingMore ? "not-allowed" : "pointer", background: "#fff", color: "#333", border: "1px solid #ccc", borderRadius: "4px", fontSize: "14px" }}
            >
              {loadingMore ? "Loading..." : "Load Next 50 Products"}
            </button>
          )}
        </div>
      </s-section>
      {products.map((product) => (
        <s-section key={product.id} heading={product.title}>
          {product.media.nodes.filter(m => m.image).map((media) => {
            const result = allResults[media.id];
            const isGenerating = allGenerating[media.id];
            const currentAlt = result?.altText || media.image.altText;
            return (
              <div key={media.id} style={{ display: "flex", gap: "16px", alignItems: "flex-start", marginBottom: "16px", padding: "12px", border: "1px solid #e1e3e5", borderRadius: "8px" }}>
                <img src={media.image.url} alt={currentAlt || ""} style={{ width: "80px", height: "80px", objectFit: "cover", borderRadius: "4px" }} />
                <div style={{ flex: 1 }}>
                  <div style={{ marginBottom: "8px" }}>
                    <span style={{ padding: "2px 8px", borderRadius: "4px", fontSize: "12px", background: currentAlt ? "#d4edda" : "#f8d7da", color: currentAlt ? "#155724" : "#721c24" }}>
                      {currentAlt ? `Has alt text (${currentAlt.length} chars)` : "Missing alt text"}
                    </span>
                    {result?.success && <span style={{ marginLeft: "8px", padding: "2px 8px", borderRadius: "4px", fontSize: "12px", background: "#d4edda", color: "#155724" }}>✓ Saved</span>}
                  </div>
                  {currentAlt && <p style={{ fontSize: "13px", color: "#6d7175", margin: "4px 0 8px" }}>{currentAlt}</p>}
                  {result?.error && <p style={{ color: "red", fontSize: "13px" }}>{result.error}</p>}
                  <button
                    onClick={() => generateOne(media.id, product.title, product.description, product.id)}
                    disabled={isGenerating}
                    style={{ padding: "6px 12px", cursor: isGenerating ? "not-allowed" : "pointer", background: currentAlt ? "#fff" : "#008060", color: currentAlt ? "#333" : "#fff", border: "1px solid #ccc", borderRadius: "4px" }}
                  >
                    {isGenerating ? "Generating..." : currentAlt ? "Regenerate" : "Generate Alt Text"}
                  </button>
                </div>
              </div>
            );
          })}
        </s-section>
      ))}
      {hasNextPage && (
        <s-section>
          <button
            onClick={loadMore}
            disabled={loadingMore}
            style={{ padding: "8px 16px", cursor: loadingMore ? "not-allowed" : "pointer", background: "#fff", color: "#333", border: "1px solid #ccc", borderRadius: "4px", fontSize: "14px" }}
          >
            {loadingMore ? "Loading..." : "Load Next 50 Products"}
          </button>
        </s-section>
      )}
    </s-page>
  );
}
