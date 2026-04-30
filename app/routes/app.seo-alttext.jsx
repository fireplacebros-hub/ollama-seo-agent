import { useLoaderData, useSubmit, useNavigation, useActionData } from "react-router";
import { authenticate } from "../shopify.server";
import { useState } from "react";

export async function loader({ request }) {
  const { admin } = await authenticate.admin(request);
  
  // Paginate through all products
  let allProducts = [];
  let cursor = null;
  let hasMore = true;

  while (hasMore) {
    const query = cursor
      ? `{ products(first: 250, after: "${cursor}") { pageInfo { hasNextPage endCursor } nodes { id title description media(first: 10) { nodes { ... on MediaImage { id image { url altText } } } } } } }`
      : `{ products(first: 250) { pageInfo { hasNextPage endCursor } nodes { id title description media(first: 10) { nodes { ... on MediaImage { id image { url altText } } } } } } }`;

    const response = await admin.graphql(query);
    const { data } = await response.json();
    const { nodes, pageInfo } = data.products;
    allProducts = allProducts.concat(nodes);
    hasMore = pageInfo.hasNextPage;
    cursor = pageInfo.endCursor;
  }

  return { products: allProducts };
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
  const { products } = useLoaderData();
  const actionData = useActionData();
  const submit = useSubmit();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";
  const [generatingAll, setGeneratingAll] = useState(false);
  const [allResults, setAllResults] = useState({});
  const [allGenerating, setAllGenerating] = useState({});

  const generateOne = async (mediaId, productTitle, productDescription, productId) => {
    setAllGenerating(prev => ({ ...prev, [mediaId]: true }));
    const formData = new FormData();
    formData.append("imageId", mediaId);
    formData.append("productTitle", productTitle);
    formData.append("productDescription", productDescription || "");
    formData.append("productId", productId);
    try {
      const res = await fetch(window.location.href, { method: "POST", body: formData });
      const data = await res.json();
      setAllResults(prev => ({ ...prev, [mediaId]: data }));
    } catch {
      setAllResults(prev => ({ ...prev, [mediaId]: { error: "Request failed" } }));
    }
    setAllGenerating(prev => ({ ...prev, [mediaId]: false }));
  };

  const handleGenerateAll = async () => {
    setGeneratingAll(true);
    const missing = [];
    products.forEach(product => {
      product.media.nodes.filter(m => m.image).forEach(media => {
        if (!media.image.altText && !allGenerating[media.id]) {
          missing.push({ mediaId: media.id, productTitle: product.title, productDescription: product.description, productId: product.id });
        }
      });
    });
    for (const item of missing) {
      await generateOne(item.mediaId, item.productTitle, item.productDescription, item.productId);
    }
    setGeneratingAll(false);
  };

  const totalImages = products.reduce((acc, p) => acc + p.media.nodes.filter(m => m.image).length, 0);
  const missingAlt = products.reduce((acc, p) => acc + p.media.nodes.filter(m => m.image && !m.image.altText).length, 0);

  return (
    <s-page heading="SEO Alt Text Generator">
      <s-section heading={`${missingAlt} of ${totalImages} images missing alt text`}>
        <s-paragraph>Generate SEO alt text (120-125 chars) using Ollama llama3.1:8b locally. Saved directly to Shopify.</s-paragraph>
        <div style={{ marginTop: "12px" }}>
          <button
            onClick={handleGenerateAll}
            disabled={generatingAll || missingAlt === 0}
            style={{ padding: "8px 16px", cursor: generatingAll ? "not-allowed" : "pointer", background: "#008060", color: "#fff", border: "none", borderRadius: "4px", fontSize: "14px" }}
          >
            {generatingAll ? "Generating All... (this may take a while)" : `Generate All ${missingAlt} Missing`}
          </button>
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
    </s-page>
  );
}
