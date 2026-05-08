import { useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import { useState, useRef } from "react";
import { isAlreadyWebP, formatBytes } from "../image-utils.js";

export async function loader({ request }) {
  const { admin } = await authenticate.admin(request);
  const url = new URL(request.url);
  const cursor = url.searchParams.get("cursor");

  const query = cursor
    ? `{ products(first: 50, after: "${cursor}") { pageInfo { hasNextPage endCursor } nodes { id title media(first: 10) { nodes { ... on MediaImage { id image { url altText } } } } } } }`
    : `{ products(first: 50) { pageInfo { hasNextPage endCursor } nodes { id title media(first: 10) { nodes { ... on MediaImage { id image { url altText } } } } } } }`;

  const response = await admin.graphql(query);
  const { data } = await response.json();
  const { nodes, pageInfo } = data.products;

  return {
    products: nodes,
    hasNextPage: pageInfo.hasNextPage,
    endCursor: pageInfo.endCursor,
  };
}

export default function ImageCompress() {
  const initialData = useLoaderData();
  const [products, setProducts] = useState(initialData.products);
  const [hasNextPage, setHasNextPage] = useState(initialData.hasNextPage);
  const [endCursor, setEndCursor] = useState(initialData.endCursor);
  const [loadingMore, setLoadingMore] = useState(false);
  const [results, setResults] = useState({});
  const [compressing, setCompressing] = useState({});
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

  const compressOne = async (mediaId, productId, imageUrl, altText) => {
    setCompressing(prev => ({ ...prev, [mediaId]: true }));
    const form = new FormData();
    form.append("mediaId", mediaId);
    form.append("productId", productId);
    form.append("imageUrl", imageUrl);
    form.append("altText", altText || "");
    try {
      const res = await fetch("/app/image-compress-api", { method: "POST", body: form });
      let data;
      try {
        data = await res.json();
      } catch {
        const text = await res.text().catch(() => "");
        data = { error: `Server error (${res.status}): ${text.slice(0, 300)}` };
      }
      setResults(prev => ({ ...prev, [mediaId]: data }));
    } catch (e) {
      setResults(prev => ({ ...prev, [mediaId]: { error: `Network error: ${e.message}` } }));
    }
    setCompressing(prev => ({ ...prev, [mediaId]: false }));
  };

  const compressAll = async () => {
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
      p.media.nodes
        .filter(m => m.image && !isAlreadyWebP(m.image.url) && !results[m.id]?.success)
        .map(m => ({ mediaId: m.id, productId: p.id, imageUrl: m.image.url, altText: m.image.altText }))
    );
    setBulkProgress({ done: 0, total: queue.length });

    for (let i = 0; i < queue.length; i++) {
      if (bulkStopRef.current) break;
      const { mediaId, productId, imageUrl, altText } = queue[i];
      await compressOne(mediaId, productId, imageUrl, altText);
      setBulkProgress({ done: i + 1, total: queue.length });
    }

    setBulkRunning(false);
  };

  const allImages = products.flatMap(p => p.media.nodes.filter(m => m.image));
  const alreadyWebP = allImages.filter(m => isAlreadyWebP(m.image.url) && !results[m.id]?.success).length;
  const compressedNow = Object.values(results).filter(r => r.success).length;
  const failed = Object.values(results).filter(r => r.error).length;
  const needsCompression = allImages.filter(m => !isAlreadyWebP(m.image.url) && !results[m.id]?.success).length;
  const totalSaved = Object.values(results).filter(r => r.success).reduce((sum, r) => sum + (r.savedBytes || 0), 0);

  const mediaToProduct = {};
  products.forEach(p => p.media.nodes.forEach(m => {
    if (m.image) mediaToProduct[m.id] = { title: p.title, url: m.image.url };
  }));

  const errorGroups = {};
  Object.entries(results).forEach(([mediaId, result]) => {
    if (!result?.error) return;
    const err = result.error;
    const category =
      err.startsWith("Download failed") ? "Download failed" :
      err.startsWith("Staged upload PUT failed") ? "Staged upload PUT failed" :
      err.startsWith("Staged upload create failed") ? "Staged upload create failed" :
      err.startsWith("Create media failed") ? "Create media failed" :
      err.startsWith("Network error") ? "Network error" :
      err.startsWith("Server error") ? "Server error" :
      err.slice(0, 60);
    if (!errorGroups[category]) errorGroups[category] = [];
    errorGroups[category].push({ mediaId, error: err, ...mediaToProduct[mediaId] });
  });

  const statCell = (label, value, color) => (
    <td style={{ padding: "10px 20px", textAlign: "center", borderRight: "1px solid #e1e3e5" }}>
      <div style={{ fontSize: "22px", fontWeight: "700", color }}>{value}</div>
      <div style={{ fontSize: "12px", color: "#6d7175", marginTop: "2px" }}>{label}</div>
    </td>
  );

  return (
    <s-page heading="Image Compression">
      <s-section>
        <div style={{ display: "flex", gap: "0", borderBottom: "2px solid #e1e3e5", marginBottom: "4px" }}>
          <a href="/app/image-compress" style={{ padding: "10px 24px", fontWeight: "600", fontSize: "14px", color: "#008060", borderBottom: "2px solid #008060", marginBottom: "-2px", textDecoration: "none" }}>Compress Images</a>
        </div>
      </s-section>

      <s-section>
        <table style={{ width: "100%", borderCollapse: "collapse", border: "1px solid #e1e3e5", borderRadius: "8px", overflow: "hidden" }}>
          <tbody>
            <tr>
              {statCell("Already WebP", alreadyWebP, "#008060")}
              {statCell("Compressed this session", compressedNow, "#008060")}
              {statCell("Failed", failed, failed > 0 ? "#d72c0d" : "#6d7175")}
              {statCell("Needs compression", needsCompression, needsCompression > 0 ? "#c4481a" : "#6d7175")}
              <td style={{ padding: "10px 20px", textAlign: "center" }}>
                <div style={{ fontSize: "22px", fontWeight: "700", color: "#333" }}>{formatBytes(totalSaved)}</div>
                <div style={{ fontSize: "12px", color: "#6d7175", marginTop: "2px" }}>Saved this session</div>
              </td>
            </tr>
          </tbody>
        </table>
      </s-section>

      {failed > 0 && (
        <s-section>
          <div style={{ padding: "12px 16px", background: "#fff3cd", border: "1px solid #ffc107", borderRadius: "6px" }}>
            <div style={{ fontWeight: "700", fontSize: "14px", color: "#856404", marginBottom: "12px" }}>
              {failed} image{failed > 1 ? "s" : ""} failed — grouped by error type:
            </div>
            {Object.entries(errorGroups).map(([category, items]) => (
              <div key={category} style={{ marginBottom: "16px" }}>
                <div style={{ fontWeight: "600", fontSize: "13px", color: "#d72c0d", marginBottom: "4px" }}>
                  [{items.length}] {category}
                </div>
                <div style={{ fontSize: "12px", color: "#555", marginBottom: "4px", fontStyle: "italic" }}>
                  {items[0]?.error}
                </div>
                <ul style={{ margin: "4px 0 0 16px", padding: 0, fontSize: "12px", color: "#333" }}>
                  {items.map(item => (
                    <li key={item.mediaId} style={{ marginBottom: "2px" }}>
                      <strong>{item.title || "Unknown product"}</strong>
                      {item.url && (
                        <span style={{ color: "#6d7175", marginLeft: "6px" }}>
                          {item.url.split("/").pop().split("?")[0].slice(0, 40)}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </s-section>
      )}

      <s-section>
        <s-paragraph>
          Convert product images to WebP format under 100KB. New uploads are compressed automatically via webhook.
          Non-WebP images are detected by URL extension — compress all or individually.
        </s-paragraph>
        <div style={{ marginTop: "12px", display: "flex", gap: "12px", alignItems: "center", flexWrap: "wrap" }}>
          {!bulkRunning ? (
            <button
              onClick={compressAll}
              disabled={needsCompression === 0}
              style={{ padding: "8px 20px", cursor: needsCompression === 0 ? "not-allowed" : "pointer", background: "#008060", color: "#fff", border: "none", borderRadius: "4px", fontSize: "14px", fontWeight: "600" }}
            >
              Compress All ({needsCompression})
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
                  Compressing {bulkProgress.done} of {bulkProgress.total}...
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
            const result = results[media.id];
            const isCompressing = compressing[media.id];
            const webp = isAlreadyWebP(media.image.url) || result?.success;
            const format = webp ? "WebP" : media.image.url.match(/\.(png|jpg|jpeg|gif)/i)?.[1]?.toUpperCase() || "Image";

            return (
              <div key={media.id} style={{ display: "flex", gap: "16px", alignItems: "flex-start", marginBottom: "16px", padding: "12px", border: "1px solid #e1e3e5", borderRadius: "8px" }}>
                <img src={media.image.url} alt={media.image.altText || ""} style={{ width: "80px", height: "80px", objectFit: "cover", borderRadius: "4px", flexShrink: 0 }} />
                <div style={{ flex: 1 }}>
                  <div style={{ marginBottom: "8px", display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center" }}>
                    <span style={{ padding: "2px 8px", borderRadius: "4px", fontSize: "12px", background: webp ? "#d4edda" : "#fff3cd", color: webp ? "#155724" : "#856404" }}>
                      {format}
                    </span>
                    {result?.success && (
                      <span style={{ padding: "2px 8px", borderRadius: "4px", fontSize: "12px", background: "#d4edda", color: "#155724" }}>
                        ✓ Compressed — saved {formatBytes(result.savedBytes)} ({formatBytes(result.originalSize)} → {formatBytes(result.compressedSize)})
                      </span>
                    )}
                  </div>
                  {result?.error && <p style={{ color: "#d72c0d", fontSize: "13px", margin: "4px 0 8px" }}>{result.error}</p>}
                  {!webp && (
                    <button
                      onClick={() => compressOne(media.id, product.id, media.image.url, media.image.altText)}
                      disabled={isCompressing}
                      style={{ padding: "6px 12px", cursor: isCompressing ? "not-allowed" : "pointer", background: "#008060", color: "#fff", border: "none", borderRadius: "4px", fontSize: "13px" }}
                    >
                      {isCompressing ? "Compressing..." : "Compress to WebP"}
                    </button>
                  )}
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
