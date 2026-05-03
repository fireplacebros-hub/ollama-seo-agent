import { useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import { useState, useRef, useEffect } from "react";

export async function loader({ request }) {
  const { admin } = await authenticate.admin(request);

  const query = `{ products(first: 50) { pageInfo { hasNextPage endCursor } nodes { id title description seo { description } media(first: 10) { nodes { ... on MediaImage { id image { url altText } } } } } } }`;
  const response = await admin.graphql(query);
  const { data } = await response.json();
  const { nodes, pageInfo } = data.products;

  return { products: nodes, hasNextPage: pageInfo.hasNextPage, endCursor: pageInfo.endCursor };
}

const TABS = [
  { label: "Alt Text",          href: "/app/seo-alttext"  },
  { label: "Meta Descriptions", href: "/app/seo-metadesc" },
  { label: "Run Both",          href: "/app/seo-runner"   },
];

function TabBar({ active }) {
  return (
    <s-section>
      <div style={{ display: "flex", gap: "0", borderBottom: "2px solid #e1e3e5" }}>
        {TABS.map(({ label, href }) => {
          const isActive = href === active;
          return (
            <a key={href} href={href} style={{ padding: "10px 24px", fontWeight: "600", fontSize: "14px", color: isActive ? "#008060" : "#6d7175", borderBottom: isActive ? "2px solid #008060" : "2px solid transparent", marginBottom: "-2px", textDecoration: "none" }}>
              {label}
            </a>
          );
        })}
      </div>
    </s-section>
  );
}

export default function SeoRunner() {
  const initialData = useLoaderData();
  const [products, setProducts]       = useState(initialData.products);
  const [hasNextPage, setHasNextPage] = useState(initialData.hasNextPage);
  const [endCursor, setEndCursor]     = useState(initialData.endCursor);
  const [running, setRunning]         = useState(false);
  const [logEntries, setLogEntries]   = useState([]);
  const [stats, setStats]             = useState({ altDone: 0, altGenerated: 0, metaDone: 0, metaGenerated: 0, errors: 0, processed: 0, total: 0 });
  const stopRef  = useRef(false);
  const logRef   = useRef(null);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [logEntries]);

  const addLog = (message, type = "info") => {
    const time = new Date().toLocaleTimeString();
    setLogEntries(prev => [...prev, { time, message, type }]);
  };

  const runAll = async () => {
    setRunning(true);
    setLogEntries([]);
    stopRef.current = false;

    // ── Load all products ──────────────────────────────────────────────────────
    addLog("Loading all products...");
    let allProducts = [...products];
    let cursor = endCursor;
    let hasMore = hasNextPage;

    while (hasMore) {
      if (stopRef.current) break;
      try {
        const res  = await fetch(`/app/seo-runner-api?cursor=${cursor}`);
        const data = await res.json();
        allProducts = [...allProducts, ...data.products];
        setProducts(allProducts);
        hasMore = data.hasNextPage;
        cursor  = data.endCursor;
        setHasNextPage(hasMore);
        setEndCursor(cursor);
        addLog(`Loaded ${allProducts.length} products...`);
      } catch {
        addLog("Failed to load a page of products — stopping early.", "error");
        break;
      }
    }

    const total = allProducts.length;
    addLog(`Starting run on ${total} products.`);
    setStats(s => ({ ...s, total }));

    // ── Process each product ───────────────────────────────────────────────────
    for (let i = 0; i < allProducts.length; i++) {
      if (stopRef.current) { addLog("Stopped by user.", "warn"); break; }

      const product = allProducts[i];
      const images  = product.media.nodes.filter(m => m.image);
      const missingAlt  = images.filter(m => !m.image.altText);
      const hasMeta     = !!product.seo?.description;

      if (missingAlt.length === 0 && hasMeta) {
        addLog(`[${i + 1}/${total}] ${product.title} — already complete, skipped.`);
        setStats(s => ({ ...s, altDone: s.altDone + images.filter(m => m.image.altText).length, metaDone: s.metaDone + 1, processed: s.processed + 1 }));
        continue;
      }

      addLog(`[${i + 1}/${total}] ${product.title}`);

      // Alt text for each missing image
      for (const media of missingAlt) {
        if (stopRef.current) break;
        try {
          const fd = new FormData();
          fd.append("imageId",            media.id);
          fd.append("productTitle",       product.title);
          fd.append("productDescription", product.description || "");
          fd.append("productId",          product.id);
          const res  = await fetch("https://ollama-seo-agent.onrender.com/app/seo-alttext", { method: "POST", body: fd });
          const data = await res.json();
          if (data.success) {
            addLog(`  ✓ Alt text saved (${data.altText?.length} chars)`, "success");
            setStats(s => ({ ...s, altGenerated: s.altGenerated + 1 }));
          } else {
            addLog(`  ✗ Alt text failed: ${data.error}`, "error");
            setStats(s => ({ ...s, errors: s.errors + 1 }));
          }
        } catch {
          addLog(`  ✗ Alt text request failed`, "error");
          setStats(s => ({ ...s, errors: s.errors + 1 }));
        }
      }

      // Meta description if missing
      if (!hasMeta && !stopRef.current) {
        try {
          const fd = new FormData();
          fd.append("productId",          product.id);
          fd.append("productTitle",       product.title);
          fd.append("productDescription", product.description || "");
          const res  = await fetch("https://ollama-seo-agent.onrender.com/app/seo-metadesc", { method: "POST", body: fd });
          const data = await res.json();
          if (data.success) {
            addLog(`  ✓ Meta description saved (${data.metaDesc?.length} chars)`, "success");
            setStats(s => ({ ...s, metaGenerated: s.metaGenerated + 1 }));
          } else {
            addLog(`  ✗ Meta description failed: ${data.error}`, "error");
            setStats(s => ({ ...s, errors: s.errors + 1 }));
          }
        } catch {
          addLog(`  ✗ Meta description request failed`, "error");
          setStats(s => ({ ...s, errors: s.errors + 1 }));
        }
      }

      setStats(s => ({ ...s, processed: s.processed + 1 }));
    }

    addLog("Run complete.");
    setRunning(false);
  };

  const logColor = { info: "#333", success: "#008060", error: "#d72c0d", warn: "#c4481a" };

  const statCell = (label, value, color) => (
    <td style={{ padding: "10px 20px", textAlign: "center", borderRight: "1px solid #e1e3e5" }}>
      <div style={{ fontSize: "22px", fontWeight: "700", color }}>{value}</div>
      <div style={{ fontSize: "12px", color: "#6d7175", marginTop: "2px" }}>{label}</div>
    </td>
  );

  const pct = stats.total ? Math.round((stats.processed / stats.total) * 100) : 0;

  return (
    <s-page heading="SEO Tools">
      <TabBar active="/app/seo-runner" />

      {/* Stats table */}
      <s-section>
        <table style={{ width: "100%", borderCollapse: "collapse", border: "1px solid #e1e3e5", borderRadius: "8px", overflow: "hidden" }}>
          <tbody>
            <tr>
              {statCell("Alt already done",   stats.altDone,       "#008060")}
              {statCell("Alt generated",       stats.altGenerated,  "#008060")}
              {statCell("Meta already done",   stats.metaDone,      "#008060")}
              {statCell("Meta generated",      stats.metaGenerated, "#008060")}
              {statCell("Errors",              stats.errors,        stats.errors > 0 ? "#d72c0d" : "#6d7175")}
              <td style={{ padding: "10px 20px", textAlign: "center" }}>
                <div style={{ fontSize: "22px", fontWeight: "700", color: "#333" }}>{stats.processed}/{stats.total || products.length}</div>
                <div style={{ fontSize: "12px", color: "#6d7175", marginTop: "2px" }}>Products processed</div>
              </td>
            </tr>
          </tbody>
        </table>
      </s-section>

      {/* Controls */}
      <s-section>
        <s-paragraph>
          Runs alt text and meta description generation in a single pass across all products.
          Skips anything that already has both. Same Ollama prompts as the individual pages.
        </s-paragraph>
        <div style={{ marginTop: "12px", display: "flex", gap: "12px", alignItems: "center", flexWrap: "wrap" }}>
          {!running ? (
            <button
              onClick={runAll}
              style={{ padding: "8px 20px", cursor: "pointer", background: "#008060", color: "#fff", border: "none", borderRadius: "4px", fontSize: "14px", fontWeight: "600" }}
            >
              Run Both — All Products
            </button>
          ) : (
            <>
              <button
                onClick={() => { stopRef.current = true; }}
                style={{ padding: "8px 20px", cursor: "pointer", background: "#d72c0d", color: "#fff", border: "none", borderRadius: "4px", fontSize: "14px", fontWeight: "600" }}
              >
                Stop
              </button>
              <div style={{ flex: 1, minWidth: "200px" }}>
                <div style={{ fontSize: "13px", color: "#333", marginBottom: "4px" }}>{pct}% — {stats.processed} of {stats.total} products</div>
                <div style={{ height: "6px", background: "#e1e3e5", borderRadius: "3px", overflow: "hidden" }}>
                  <div style={{ height: "100%", background: "#008060", borderRadius: "3px", width: `${pct}%`, transition: "width 0.3s ease" }} />
                </div>
              </div>
            </>
          )}
        </div>
      </s-section>

      {/* Log panel */}
      {logEntries.length > 0 && (
        <s-section heading="Log">
          <div
            ref={logRef}
            style={{ fontFamily: "monospace", fontSize: "12px", lineHeight: "1.6", background: "#f6f6f7", border: "1px solid #e1e3e5", borderRadius: "6px", padding: "12px", maxHeight: "400px", overflowY: "auto" }}
          >
            {logEntries.map((entry, i) => (
              <div key={i} style={{ color: logColor[entry.type] || "#333" }}>
                <span style={{ color: "#aaa", marginRight: "8px" }}>{entry.time}</span>{entry.message}
              </div>
            ))}
          </div>
        </s-section>
      )}
    </s-page>
  );
}
