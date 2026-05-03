import { useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import { useState, useRef } from "react";

export async function loader({ request }) {
  const { admin } = await authenticate.admin(request);
  const url = new URL(request.url);
  const cursor = url.searchParams.get("cursor");

  const query = cursor
    ? `{ products(first: 50, after: "${cursor}") { pageInfo { hasNextPage endCursor } nodes { id title description seo { title description } } } }`
    : `{ products(first: 50) { pageInfo { hasNextPage endCursor } nodes { id title description seo { title description } } } }`;

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
  const productId = formData.get("productId");
  const productTitle = formData.get("productTitle");
  const productDescription = formData.get("productDescription");

  let metaDesc = "";
  try {
    const ollamaRes = await fetch("https://impose-eatery-goofball.ngrok-free.dev/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json", "ngrok-skip-browser-warning": "true" },
      body: JSON.stringify({
        model: "llama3.1:8b",
        prompt: `You are an SEO copywriter. Write a meta description for this product page.

Product title: ${productTitle}
Product description: ${productDescription || "None provided"}

STRICT RULES:
- Total length must be 150-160 characters. Count every character including spaces before submitting.
- Include the product name or a key spec from the title (size, wattage, BTU, material, model number).
- Mention at least one concrete feature or benefit (not vague phrases like "perfect for any room" or "experience the ultimate").
- End with a short action phrase or differentiator.
- Return ONLY the meta description on a single line. No quotes. No labels. No explanation.

Good example (155 chars): Litedeer Latitude 48-inch wall-mounted electric fireplace with WiFi app, 5 flame colors, crackling sounds, and 1500W heat for up to 400 sq ft.`,
        stream: false,
      }),
    });
    const ollamaData = await ollamaRes.json();
    metaDesc = ollamaData.response?.trim().split("\n")[0].replace(/^["\']|["\']$/g, "") || "";
  } catch (e) {
    return { error: "Ollama error: " + e.message };
  }

  if (!metaDesc) return { error: "Ollama returned empty response" };
  if (metaDesc.length < 145) return { error: `Meta description too short (${metaDesc.length} chars, need 150-160). Try regenerating.` };
  if (metaDesc.length > 160) {
    const cut = metaDesc.slice(0, 157);
    metaDesc = cut.slice(0, cut.lastIndexOf(" ")) + "...";
  }

  try {
    const updateRes = await admin.graphql(
      `mutation productUpdate($input: ProductInput!) {
        productUpdate(input: $input) {
          product { id seo { title description } }
          userErrors { field message }
        }
      }`,
      { variables: { input: { id: productId, seo: { description: metaDesc } } } }
    );
    const updateData = await updateRes.json();
    const errors = updateData.data?.productUpdate?.userErrors;
    if (errors?.length > 0) return { error: errors[0].message };
  } catch (e) {
    return { error: "Shopify error: " + e.message };
  }

  return { success: true, metaDesc, productId };
}

export default function SeoMetaDesc() {
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
      const res = await fetch(`/app/seo-metadesc-api?cursor=${endCursor}`);
      const data = await res.json();
      setProducts(prev => [...prev, ...data.products]);
      setHasNextPage(data.hasNextPage);
      setEndCursor(data.endCursor);
    } catch {
      alert("Failed to load more products");
    }
    setLoadingMore(false);
  };

  const generateOne = async (productId, productTitle, productDescription) => {
    setAllGenerating(prev => ({ ...prev, [productId]: true }));
    const formData = new FormData();
    formData.append("productId", productId);
    formData.append("productTitle", productTitle);
    formData.append("productDescription", productDescription || "");
    try {
      const res = await fetch("https://ollama-seo-agent.onrender.com/app/seo-metadesc", { method: "POST", body: formData });
      const data = await res.json();
      setAllResults(prev => ({ ...prev, [productId]: data }));
    } catch {
      setAllResults(prev => ({ ...prev, [productId]: { error: "Request failed" } }));
    }
    setAllGenerating(prev => ({ ...prev, [productId]: false }));
  };

  const generateAll = async () => {
    setBulkRunning(true);
    bulkStopRef.current = false;

    // Load all remaining pages before starting
    let allProducts = [...products];
    let cursor = endCursor;
    let hasMore = hasNextPage;
    while (hasMore) {
      try {
        const res = await fetch(`/app/seo-metadesc-api?cursor=${cursor}`);
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

    // Only queue products that don't already have a description
    const queue = allProducts.filter(p => !p.seo?.description);
    setBulkProgress({ done: 0, total: queue.length });

    for (let i = 0; i < queue.length; i++) {
      if (bulkStopRef.current) break;
      const p = queue[i];
      await generateOne(p.id, p.title, p.description);
      setBulkProgress({ done: i + 1, total: queue.length });
    }

    setBulkRunning(false);
  };

  const missingMeta = products.filter(p => !p.seo?.description && !allResults[p.id]?.success).length;

  return (
    <s-page heading="SEO Meta Description Generator">
      <s-section heading={`${missingMeta} of ${products.length} loaded products missing meta description`}>
        <s-paragraph>
          Generate SEO meta descriptions (150-160 chars) for each product using Ollama.
          These appear as the snippet under your link in Google search results and directly affect click-through rate.
        </s-paragraph>
        <div style={{ marginTop: "12px", display: "flex", gap: "12px", alignItems: "center", flexWrap: "wrap" }}>
          {!bulkRunning ? (
            <button
              onClick={generateAll}
              disabled={missingMeta === 0}
              style={{ padding: "8px 20px", cursor: missingMeta === 0 ? "not-allowed" : "pointer", background: "#008060", color: "#fff", border: "none", borderRadius: "4px", fontSize: "14px", fontWeight: "600" }}
            >
              Generate All Missing ({missingMeta})
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
      {products.map((product) => {
        const result = allResults[product.id];
        const isGenerating = allGenerating[product.id];
        const currentMeta = result?.metaDesc || product.seo?.description;
        const charCount = currentMeta?.length || 0;
        const charColor = charCount >= 150 && charCount <= 160 ? "#155724" : charCount >= 120 ? "#856404" : "#721c24";
        return (
          <s-section key={product.id} heading={product.title}>
            <div style={{ padding: "12px", border: "1px solid #e1e3e5", borderRadius: "8px" }}>
              <div style={{ marginBottom: "8px", display: "flex", gap: "8px", flexWrap: "wrap" }}>
                <span style={{ padding: "2px 8px", borderRadius: "4px", fontSize: "12px", background: currentMeta ? "#d4edda" : "#f8d7da", color: currentMeta ? "#155724" : "#721c24" }}>
                  {currentMeta ? `${charCount} chars` : "Missing meta description"}
                </span>
                {currentMeta && (
                  <span style={{ padding: "2px 8px", borderRadius: "4px", fontSize: "12px", background: charCount >= 150 && charCount <= 160 ? "#d4edda" : "#fff3cd", color: charColor }}>
                    {charCount >= 150 && charCount <= 160 ? "Ideal length" : charCount > 160 ? "Too long" : "A bit short"}
                  </span>
                )}
                {result?.success && (
                  <span style={{ padding: "2px 8px", borderRadius: "4px", fontSize: "12px", background: "#d4edda", color: "#155724" }}>✓ Saved</span>
                )}
              </div>
              {currentMeta && (
                <p style={{ fontSize: "13px", color: "#6d7175", margin: "4px 0 8px", fontStyle: "italic" }}>{currentMeta}</p>
              )}
              {result?.error && (
                <p style={{ color: "red", fontSize: "13px", margin: "4px 0 8px" }}>{result.error}</p>
              )}
              <button
                onClick={() => generateOne(product.id, product.title, product.description)}
                disabled={isGenerating}
                style={{ padding: "6px 12px", cursor: isGenerating ? "not-allowed" : "pointer", background: currentMeta ? "#fff" : "#008060", color: currentMeta ? "#333" : "#fff", border: "1px solid #ccc", borderRadius: "4px" }}
              >
                {isGenerating ? "Generating..." : currentMeta ? "Regenerate" : "Generate Meta Description"}
              </button>
            </div>
          </s-section>
        );
      })}
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
