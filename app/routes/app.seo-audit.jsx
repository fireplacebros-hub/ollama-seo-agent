import { useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import { useState } from "react";

function scoreItem(item) {
  const issues = [];
  const title = item.title || "";
  const metaDesc = item.metafield?.value || "";
  const body = item.description || item.bodySummary || item.body || "";

  if (!metaDesc) issues.push({ severity: "critical", msg: "No meta description" });
  else if (metaDesc.length < 120) issues.push({ severity: "warning", msg: `Meta description too short (${metaDesc.length} chars, aim 120–155)` });
  else if (metaDesc.length > 155) issues.push({ severity: "warning", msg: `Meta description too long (${metaDesc.length} chars, max 155)` });

  if (title.length < 20) issues.push({ severity: "warning", msg: `Title very short (${title.length} chars)` });
  else if (title.length > 70) issues.push({ severity: "warning", msg: `Title too long (${title.length} chars, aim under 70)` });

  if (!body || body.replace(/<[^>]+>/g, "").trim().length < 50) {
    issues.push({ severity: "warning", msg: "No or very thin description/content" });
  }

  if (item._type === "product" && item.images) {
    const missingAlt = item.images.filter(img => !img.altText || img.altText.trim() === "").length;
    const tooLong = item.images.filter(img => img.altText && img.altText.length > 125).length;
    if (missingAlt > 0) issues.push({ severity: "critical", msg: `${missingAlt} image${missingAlt > 1 ? "s" : ""} missing alt text` });
    if (tooLong > 0) issues.push({ severity: "warning", msg: `${tooLong} image alt text${tooLong > 1 ? "s" : ""} over 125 chars` });
  }

  const score = Math.max(0, 100 - issues.filter(i => i.severity === "critical").length * 30 - issues.filter(i => i.severity === "warning").length * 10);
  return { issues, score };
}

function scoreGrade(score) {
  if (score >= 90) return { grade: "A", color: "#008060" };
  if (score >= 75) return { grade: "B", color: "#4a7c59" };
  if (score >= 55) return { grade: "C", color: "#856404" };
  if (score >= 35) return { grade: "D", color: "#c4481a" };
  return { grade: "F", color: "#d72c0d" };
}

export async function loader({ request }) {
  const { admin } = await authenticate.admin(request);

  const [productsRes, collectionsRes, pagesRes] = await Promise.allSettled([
    admin.graphql(`{
      products(first: 100) {
        nodes {
          id title handle
          metafield(namespace: "global", key: "description_tag") { value }
          description
          images(first: 10) { nodes { altText } }
        }
      }
    }`),
    admin.graphql(`{
      collections(first: 100) {
        nodes {
          id title handle
          description
          metafield(namespace: "global", key: "description_tag") { value }
        }
      }
    }`),
    admin.graphql(`{
      pages(first: 50) {
        nodes {
          id title handle
          bodySummary
          metafield(namespace: "global", key: "description_tag") { value }
        }
      }
    }`),
  ]);

  const products = productsRes.status === "fulfilled"
    ? (await productsRes.value.json()).data?.products?.nodes ?? []
    : [];
  const collections = collectionsRes.status === "fulfilled"
    ? (await collectionsRes.value.json()).data?.collections?.nodes ?? []
    : [];
  const pages = pagesRes.status === "fulfilled"
    ? (await pagesRes.value.json()).data?.pages?.nodes ?? []
    : [];

  const taggedProducts = products.map(p => ({ ...p, _type: "product", images: p.images?.nodes ?? [] }));
  const taggedCollections = collections.map(c => ({ ...c, _type: "collection" }));
  const taggedPages = pages.map(p => ({ ...p, _type: "page" }));

  return { products: taggedProducts, collections: taggedCollections, pages: taggedPages };
}

export default function SeoAudit() {
  const { products, collections, pages } = useLoaderData();
  const [tab, setTab] = useState("overview");
  const [filter, setFilter] = useState("all");

  const allItems = [
    ...products.map(p => ({ ...p, _type: "product" })),
    ...collections.map(c => ({ ...c, _type: "collection" })),
    ...pages.map(p => ({ ...p, _type: "page" })),
  ];

  const scored = allItems.map(item => ({ item, ...scoreItem(item) }));
  const avgScore = scored.length ? Math.round(scored.reduce((s, x) => s + x.score, 0) / scored.length) : 0;
  const critical = scored.filter(x => x.issues.some(i => i.severity === "critical")).length;
  const warnings = scored.filter(x => x.issues.some(i => i.severity === "warning") && !x.issues.some(i => i.severity === "critical")).length;
  const passing = scored.filter(x => x.issues.length === 0).length;

  const noMetaDesc = scored.filter(x => x.issues.some(i => i.msg.includes("No meta description"))).length;
  const noAlt = scored.filter(x => x.issues.some(i => i.msg.includes("missing alt text"))).length;
  const thinContent = scored.filter(x => x.issues.some(i => i.msg.includes("thin"))).length;

  const tabItems = tab === "products" ? scored.filter(x => x.item._type === "product")
    : tab === "collections" ? scored.filter(x => x.item._type === "collection")
    : tab === "pages" ? scored.filter(x => x.item._type === "page")
    : scored;

  const filtered = filter === "critical" ? tabItems.filter(x => x.issues.some(i => i.severity === "critical"))
    : filter === "warning" ? tabItems.filter(x => x.issues.some(i => i.severity === "warning") && !x.issues.some(i => i.severity === "critical"))
    : filter === "passing" ? tabItems.filter(x => x.issues.length === 0)
    : tabItems;

  const sorted = [...filtered].sort((a, b) => a.score - b.score);

  const overall = scoreGrade(avgScore);

  const tabStyle = (t) => ({
    padding: "8px 18px", fontWeight: "600", fontSize: "13px", cursor: "pointer",
    color: tab === t ? "#008060" : "#6d7175", background: "none",
    borderTop: "none", borderLeft: "none", borderRight: "none",
    borderBottom: tab === t ? "2px solid #008060" : "2px solid transparent",
    marginBottom: "-2px",
  });

  const filterBtn = (f, label, color) => (
    <button
      onClick={() => setFilter(f)}
      style={{
        padding: "4px 12px", fontSize: "12px", fontWeight: "600", borderRadius: "4px",
        cursor: "pointer", border: filter === f ? "none" : "1px solid #e1e3e5",
        background: filter === f ? color : "#fff",
        color: filter === f ? "#fff" : "#333",
      }}
    >
      {label}
    </button>
  );

  const typeLabel = (type) =>
    type === "product" ? { label: "Product", bg: "#e3f0ff", color: "#1a4b8c" }
    : type === "collection" ? { label: "Collection", bg: "#e8f5e9", color: "#1b5e20" }
    : { label: "Page", bg: "#f3e5f5", color: "#4a148c" };

  return (
    <s-page heading="SEO Audit">
      <s-section>
        <div style={{ display: "flex", gap: "0", borderBottom: "2px solid #e1e3e5", marginBottom: "4px" }}>
          {["overview", "products", "collections", "pages"].map(t => (
            <button key={t} style={tabStyle(t)} onClick={() => { setTab(t); setFilter("all"); }}>
              {t.charAt(0).toUpperCase() + t.slice(1)}
              {t !== "overview" && (
                <span style={{ marginLeft: "6px", fontSize: "11px", color: "#6d7175" }}>
                  ({t === "products" ? products.length : t === "collections" ? collections.length : pages.length})
                </span>
              )}
            </button>
          ))}
        </div>
      </s-section>

      <s-section>
        <table style={{ width: "100%", borderCollapse: "collapse", border: "1px solid #e1e3e5", borderRadius: "8px", overflow: "hidden" }}>
          <tbody>
            <tr>
              <td style={{ padding: "16px 20px", textAlign: "center", borderRight: "1px solid #e1e3e5" }}>
                <div style={{ fontSize: "36px", fontWeight: "800", color: overall.color }}>{overall.grade}</div>
                <div style={{ fontSize: "13px", color: "#6d7175", marginTop: "2px" }}>Overall ({avgScore}/100)</div>
              </td>
              <td style={{ padding: "12px 20px", textAlign: "center", borderRight: "1px solid #e1e3e5" }}>
                <div style={{ fontSize: "22px", fontWeight: "700", color: "#d72c0d" }}>{critical}</div>
                <div style={{ fontSize: "12px", color: "#6d7175", marginTop: "2px" }}>Critical issues</div>
              </td>
              <td style={{ padding: "12px 20px", textAlign: "center", borderRight: "1px solid #e1e3e5" }}>
                <div style={{ fontSize: "22px", fontWeight: "700", color: "#856404" }}>{warnings}</div>
                <div style={{ fontSize: "12px", color: "#6d7175", marginTop: "2px" }}>Warnings</div>
              </td>
              <td style={{ padding: "12px 20px", textAlign: "center" }}>
                <div style={{ fontSize: "22px", fontWeight: "700", color: "#008060" }}>{passing}</div>
                <div style={{ fontSize: "12px", color: "#6d7175", marginTop: "2px" }}>Passing</div>
              </td>
            </tr>
          </tbody>
        </table>
      </s-section>

      {tab === "overview" && (
        <s-section heading="Top Issues">
          {[
            { count: noMetaDesc, label: "pages missing meta description", color: "#d72c0d", link: "/app/seo-metadesc" },
            { count: noAlt, label: "products with images missing alt text", color: "#d72c0d", link: "/app/seo-alttext" },
            { count: thinContent, label: "pages with thin or no content", color: "#856404", link: null },
          ].map(({ count, label, color, link }) => count > 0 && (
            <div key={label} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 0", borderBottom: "1px solid #f1f1f1" }}>
              <span style={{ fontSize: "14px" }}>
                <strong style={{ color }}>{count}</strong> {label}
              </span>
              {link && (
                <a href={link} style={{ fontSize: "13px", color: "#008060", fontWeight: "600", textDecoration: "none" }}>
                  Fix →
                </a>
              )}
            </div>
          ))}
        </s-section>
      )}

      <s-section>
        <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center" }}>
          <span style={{ fontSize: "12px", color: "#6d7175", fontWeight: "600" }}>Filter:</span>
          {filterBtn("all", `All (${tabItems.length})`, "#333")}
          {filterBtn("critical", `Critical (${tabItems.filter(x => x.issues.some(i => i.severity === "critical")).length})`, "#d72c0d")}
          {filterBtn("warning", `Warnings (${tabItems.filter(x => x.issues.some(i => i.severity === "warning") && !x.issues.some(i => i.severity === "critical")).length})`, "#856404")}
          {filterBtn("passing", `Passing (${tabItems.filter(x => x.issues.length === 0).length})`, "#008060")}
        </div>
      </s-section>

      {sorted.map(({ item, score, issues }) => {
        const { grade, color } = scoreGrade(score);
        const type = typeLabel(item._type);

        return (
          <s-section key={item.id}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "12px" }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: "flex", gap: "8px", alignItems: "center", marginBottom: "4px", flexWrap: "wrap" }}>
                  <span style={{ padding: "1px 6px", borderRadius: "3px", fontSize: "11px", fontWeight: "600", background: type.bg, color: type.color }}>
                    {type.label}
                  </span>
                  <span style={{ fontWeight: "600", fontSize: "14px" }}>{item.title}</span>
                </div>
                <div style={{ fontSize: "11px", color: "#6d7175", marginBottom: "8px" }}>
                  /{item._type === "product" ? "products" : item._type === "collection" ? "collections" : "pages"}/{item.handle}
                </div>
                {issues.length === 0 ? (
                  <span style={{ fontSize: "12px", color: "#008060", fontWeight: "600" }}>✓ No issues found</span>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                    {issues.map((issue, i) => (
                      <div key={i} style={{ display: "flex", gap: "6px", alignItems: "center" }}>
                        <span style={{ fontSize: "11px", fontWeight: "700", color: issue.severity === "critical" ? "#d72c0d" : "#856404" }}>
                          {issue.severity === "critical" ? "●" : "○"}
                        </span>
                        <span style={{ fontSize: "12px", color: issue.severity === "critical" ? "#d72c0d" : "#856404" }}>
                          {issue.msg}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
              <div style={{ textAlign: "center", flexShrink: 0 }}>
                <div style={{ fontSize: "24px", fontWeight: "800", color, lineHeight: 1 }}>{grade}</div>
                <div style={{ fontSize: "10px", color: "#6d7175", marginTop: "2px" }}>{score}/100</div>
              </div>
            </div>
          </s-section>
        );
      })}

      {sorted.length === 0 && (
        <s-section>
          <div style={{ textAlign: "center", padding: "24px", color: "#6d7175", fontSize: "14px" }}>
            No items match this filter.
          </div>
        </s-section>
      )}
    </s-page>
  );
}
