import { useLoaderData, useSubmit, useNavigation, useActionData } from "react-router";
import { authenticate } from "../shopify.server";

export async function loader({ request }) {
  const { admin } = await authenticate.admin(request);
  const response = await admin.graphql(`{
    products(first: 20) {
      nodes {
        id title description
        media(first: 5) {
          nodes {
            ... on MediaImage {
              id
              image { url altText }
            }
          }
        }
      }
    }
  }`);
  const { data } = await response.json();
  return { products: data.products.nodes };
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
        prompt: `You are an SEO specialist. Write concise alt text for a product image. Product: ${productTitle}. Description: ${productDescription || "None"}. Rules: max 125 chars, include product name, be specific, do NOT start with Image of, return ONLY the alt text on a single line, no explanations, no bullet points.`,
        stream: false,
      }),
    });
    const ollamaData = await ollamaRes.json();
    altText = ollamaData.response?.trim().split("\n")[0].replace(/^["\']|["\']$/g, "") || "";
  } catch (e) {
    return { error: "Ollama error: " + e.message };
  }

  if (!altText) return { error: "Ollama returned empty response" };

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

  const handleGenerate = (image, product) => {
    const formData = new FormData();
    formData.append("imageId", image.id);
    formData.append("productTitle", product.title);
    formData.append("productDescription", product.description || "");
    formData.append("productId", product.id);
    submit(formData, { method: "POST" });
  };

  const totalImages = products.reduce((acc, p) => acc + p.media.nodes.length, 0);
  const missingAlt = products.reduce((acc, p) => acc + p.media.nodes.filter((i) => !i.image?.altText).length, 0);

  return (
    <s-page heading="SEO Alt Text Generator">
      <s-section heading={`${missingAlt} of ${totalImages} images missing alt text`}>
        <s-paragraph>Click Generate to create SEO alt text using Ollama llama3.1:8b locally. Saved directly to Shopify.</s-paragraph>
        {actionData?.error && <p style={{ color: "red" }}>{actionData.error}</p>}
        {actionData?.success && <p style={{ color: "green" }}>✓ Saved: {actionData.altText}</p>}
      </s-section>
      {products.map((product) => (
        <s-section key={product.id} heading={product.title}>
          {product.media.nodes.filter(m => m.image).map((media) => {
            const currentAlt = media.image.altText;
            return (
              <div key={media.id} style={{ display: "flex", gap: "16px", alignItems: "flex-start", marginBottom: "16px", padding: "12px", border: "1px solid #e1e3e5", borderRadius: "8px" }}>
                <img src={media.image.url} alt={currentAlt || ""} style={{ width: "80px", height: "80px", objectFit: "cover", borderRadius: "4px" }} />
                <div style={{ flex: 1 }}>
                  <div style={{ marginBottom: "8px" }}>
                    <span style={{ padding: "2px 8px", borderRadius: "4px", fontSize: "12px", background: currentAlt ? "#d4edda" : "#f8d7da", color: currentAlt ? "#155724" : "#721c24" }}>
                      {currentAlt ? "Has alt text" : "Missing alt text"}
                    </span>
                  </div>
                  {currentAlt && <p style={{ fontSize: "13px", color: "#6d7175", margin: "4px 0 8px" }}>{currentAlt}</p>}
                  <button
                    onClick={() => handleGenerate(media, product)}
                    disabled={isSubmitting}
                    style={{ padding: "6px 12px", cursor: isSubmitting ? "not-allowed" : "pointer", background: currentAlt ? "#fff" : "#008060", color: currentAlt ? "#333" : "#fff", border: "1px solid #ccc", borderRadius: "4px" }}
                  >
                    {isSubmitting ? "Generating..." : currentAlt ? "Regenerate" : "Generate Alt Text"}
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
