import { useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import { useState } from "react";

const MAX_CHARS = 155;

function emptyTab(error = null) {
  return { items: [], hasNextPage: false, endCursor: null, error };
}

export async function loader({ request }) {
  const { admin } = await authenticate.admin(request);

  let pages = emptyTab();
  let collections = emptyTab();

  try {
    const res = await admin.graphql(
      `{ pages(first: 50) { pageInfo { hasNextPage endCursor } nodes { id title handle metafield(namespace: "global", key: "description_tag") { id value } } } }`
    );
    const json = await res.json();
    if (json.data?.pages) {
      pages = {
        items: json.data.pages.nodes,
        hasNextPage: json.data.pages.pageInfo.hasNextPage,
        endCursor: json.data.pages.pageInfo.endCursor,
        error: null,
      };
    } else {
      const msg = json.errors?.[0]?.message ?? "Could not load pages";
      console.error("[pages-metadesc] pages query error:", msg);
      pages = emptyTab(msg);
    }
  } catch (e) {
    console.error("[pages-metadesc] pages exception:", e.message);
    pages = emptyTab(e.message);
  }

  try {
    const res = await admin.graphql(
      `{ collections(first: 50) { pageInfo { hasNextPage endCursor } nodes { id title handle metafield(namespace: "global", key: "description_tag") { id value } } } }`
    );
    const json = await res.json();
    if (json.data?.collections) {
      collections = {
        items: json.data.collections.nodes,
        hasNextPage: json.data.collections.pageInfo.hasNextPage,
        endCursor: json.data.collections.pageInfo.endCursor,
        error: null,
      };
    } else {
      const msg = json.errors?.[0]?.message ?? "Could not load collections";
      console.error("[pages-metadesc] collections query error:", msg);
      collections = emptyTab(msg);
    }
  } catch (e) {
    console.error("[pages-metadesc] collections exception:", e.message);
    collections = emptyTab(e.message);
  }

  return { pages, collections };
}

export async function action({ request }) {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const ownerId = formData.get("ownerId");
  const value = (formData.get("value") || "").trim();

  if (!ownerId) return Response.json({ error: "Missing ownerId" }, { status: 400 });
  if (value.length > MAX_CHARS) return Response.json({ error: `Too long — max ${MAX_CHARS} characters` }, { status: 400 });

  try {
    const res = await admin.graphql(
      `mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) {
          metafields { id value }
          userErrors { field message }
        }
      }`,
      {
        variables: {
          metafields: [{
            ownerId,
            namespace: "global",
            key: "description_tag",
            value,
            type: "single_line_text_field",
          }],
        },
      }
    );
    const resData = await res.json();
    const errors = resData.data?.metafieldsSet?.userErrors;
    if (errors?.length) return Response.json({ error: errors[0].message }, { status: 422 });
    return Response.json({ success: true, value });
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}

function charColor(len) {
  if (len === 0) return "#6d7175";
  if (len <= MAX_CHARS) return "#008060";
  return "#d72c0d";
}

function ItemRow({ item, onSaved }) {
  const existing = item.metafield?.value || "";
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(existing);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState(null);

  const currentValue = result?.value ?? existing;
  const isOver = draft.length > MAX_CHARS;

  const save = async () => {
    setSaving(true);
    const form = new FormData();
    form.append("ownerId", item.id);
    form.append("value", draft);
    try {
      const res = await fetch("https://ollama-seo-agent.onrender.com/app/pages-metadesc", { method: "POST", body: form });
      const data = await res.json();
      if (data.success) {
        setResult(data);
        setOpen(false);
        onSaved(item.id, data.value);
      } else {
        setResult({ error: data.error });
      }
    } catch {
      setResult({ error: "Request failed" });
    }
    setSaving(false);
  };

  return (
    <div style={{ padding: "14px 16px", border: "1px solid #e1e3e5", borderRadius: "8px", marginBottom: "10px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "12px", flexWrap: "wrap" }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: "600", fontSize: "14px", color: "#202223" }}>{item.title}</div>
          <div style={{ fontSize: "12px", color: "#6d7175", marginTop: "2px" }}>/{item.handle}</div>
        </div>
        <div style={{ display: "flex", gap: "8px", alignItems: "center", flexShrink: 0 }}>
          {currentValue ? (
            <span style={{ padding: "2px 8px", borderRadius: "4px", fontSize: "12px", background: "#d4edda", color: "#155724" }}>
              {currentValue.length} chars
            </span>
          ) : (
            <span style={{ padding: "2px 8px", borderRadius: "4px", fontSize: "12px", background: "#f8d7da", color: "#721c24" }}>
              Missing
            </span>
          )}
          {result?.success && (
            <span style={{ padding: "2px 8px", borderRadius: "4px", fontSize: "12px", background: "#d4edda", color: "#155724" }}>✓ Saved</span>
          )}
          <button
            onClick={() => { setOpen(o => !o); setDraft(currentValue); setResult(null); }}
            style={{ padding: "5px 12px", cursor: "pointer", background: "#fff", color: "#333", border: "1px solid #ccc", borderRadius: "4px", fontSize: "13px" }}
          >
            {open ? "Cancel" : currentValue ? "Edit" : "Add"}
          </button>
        </div>
      </div>

      {!open && currentValue && (
        <p style={{ fontSize: "13px", color: "#6d7175", margin: "8px 0 0", fontStyle: "italic" }}>{currentValue}</p>
      )}

      {open && (
        <div style={{ marginTop: "12px" }}>
          <textarea
            value={draft}
            onChange={e => setDraft(e.target.value)}
            placeholder="Write a meta description..."
            rows={3}
            style={{
              width: "100%", boxSizing: "border-box", padding: "8px 10px",
              border: `1px solid ${isOver ? "#d72c0d" : "#ccc"}`, borderRadius: "4px",
              fontSize: "13px", resize: "vertical", fontFamily: "inherit",
            }}
          />
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: "6px" }}>
            <span style={{ fontSize: "12px", color: charColor(draft.length), fontWeight: "600" }}>
              {draft.length} / {MAX_CHARS}
              {isOver ? ` (${draft.length - MAX_CHARS} over)` : ""}
            </span>
            <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
              {result?.error && <span style={{ fontSize: "12px", color: "#d72c0d" }}>{result.error}</span>}
              <button
                onClick={save}
                disabled={saving || isOver || draft.trim() === ""}
                style={{
                  padding: "6px 16px", cursor: saving || isOver || !draft.trim() ? "not-allowed" : "pointer",
                  background: "#008060", color: "#fff", border: "none", borderRadius: "4px", fontSize: "13px", fontWeight: "600",
                  opacity: saving || isOver || !draft.trim() ? 0.6 : 1,
                }}
              >
                {saving ? "Saving..." : "Save"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default function PagesMetaDesc() {
  const initial = useLoaderData();

  const [tab, setTab] = useState("pages");

  const [pages, setPages] = useState(initial.pages.items);
  const [pagesHasNext, setPagesHasNext] = useState(initial.pages.hasNextPage);
  const [pagesCursor, setPagesCursor] = useState(initial.pages.endCursor);
  const [pagesLoading, setPagesLoading] = useState(false);

  const [collections, setCollections] = useState(initial.collections.items);
  const [collectionsHasNext, setCollectionsHasNext] = useState(initial.collections.hasNextPage);
  const [collectionsCursor, setCollectionsCursor] = useState(initial.collections.endCursor);
  const [collectionsLoading, setCollectionsLoading] = useState(false);

  const [savedValues, setSavedValues] = useState({});

  const handleSaved = (id, value) => setSavedValues(prev => ({ ...prev, [id]: value }));

  const loadMorePages = async () => {
    setPagesLoading(true);
    try {
      const res = await fetch(`/app/pages-metadesc-api?cursor=${pagesCursor}`);
      const data = await res.json();
      setPages(prev => [...prev, ...data.items]);
      setPagesHasNext(data.hasNextPage);
      setPagesCursor(data.endCursor);
    } catch { /* ignore */ }
    setPagesLoading(false);
  };

  const loadMoreCollections = async () => {
    setCollectionsLoading(true);
    try {
      const res = await fetch(`/app/collections-metadesc-api?cursor=${collectionsCursor}`);
      const data = await res.json();
      setCollections(prev => [...prev, ...data.items]);
      setCollectionsHasNext(data.hasNextPage);
      setCollectionsCursor(data.endCursor);
    } catch { /* ignore */ }
    setCollectionsLoading(false);
  };

  const tabError = tab === "pages" ? initial.pages.error : initial.collections.error;
  const items = tab === "pages" ? pages : collections;
  const hasMeta = items.filter(i => savedValues[i.id] !== undefined ? savedValues[i.id] : i.metafield?.value).length;
  const missing = items.length - hasMeta;

  const tabStyle = (t) => ({
    padding: "10px 24px", fontWeight: "600", fontSize: "14px", textDecoration: "none",
    color: tab === t ? "#008060" : "#6d7175",
    borderBottom: tab === t ? "2px solid #008060" : "2px solid transparent",
    marginBottom: "-2px", cursor: "pointer", background: "none", border: "none",
  });

  const statCell = (label, value, color) => (
    <td style={{ padding: "10px 20px", textAlign: "center", borderRight: "1px solid #e1e3e5" }}>
      <div style={{ fontSize: "22px", fontWeight: "700", color }}>{value}</div>
      <div style={{ fontSize: "12px", color: "#6d7175", marginTop: "2px" }}>{label}</div>
    </td>
  );

  return (
    <s-page heading="Pages & Collections Meta Descriptions">
      <s-section>
        <div style={{ display: "flex", gap: "0", borderBottom: "2px solid #e1e3e5", marginBottom: "4px" }}>
          <button style={tabStyle("pages")} onClick={() => setTab("pages")}>Pages</button>
          <button style={tabStyle("collections")} onClick={() => setTab("collections")}>Collections</button>
        </div>
      </s-section>

      <s-section>
        <table style={{ width: "100%", borderCollapse: "collapse", border: "1px solid #e1e3e5", borderRadius: "8px", overflow: "hidden" }}>
          <tbody>
            <tr>
              {statCell("Have meta description", hasMeta, "#008060")}
              {statCell("Missing", missing, missing > 0 ? "#c4481a" : "#6d7175")}
              <td style={{ padding: "10px 20px", textAlign: "center" }}>
                <div style={{ fontSize: "22px", fontWeight: "700", color: "#333" }}>{items.length}</div>
                <div style={{ fontSize: "12px", color: "#6d7175", marginTop: "2px" }}>
                  {tab === "pages" ? "Pages" : "Collections"} loaded{(tab === "pages" ? pagesHasNext : collectionsHasNext) ? " (more available)" : ""}
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </s-section>

      {tabError && (
        <s-section>
          <div style={{ padding: "12px 16px", background: "#fff3cd", border: "1px solid #ffc107", borderRadius: "6px", color: "#856404", fontSize: "14px" }}>
            <strong>Could not load {tab}.</strong> Error: {tabError}
            <br /><br />
            If this says "Access denied", the app needs <strong>read_content</strong> and <strong>write_content</strong> permissions.
            Close and re-open the app from your Shopify admin — Shopify will ask you to re-authorize.
          </div>
        </s-section>
      )}

      <s-section>
        <s-paragraph>
          Set the meta description for each {tab === "pages" ? "page" : "collection"} — this appears as the snippet in Google search results.
          Aim for 120–155 characters. Saved to the <code>global.description_tag</code> metafield.
        </s-paragraph>
      </s-section>

      <s-section>
        {items.map(item => (
          <ItemRow key={item.id} item={item} onSaved={handleSaved} />
        ))}

        {(tab === "pages" ? pagesHasNext : collectionsHasNext) && (
          <button
            onClick={tab === "pages" ? loadMorePages : loadMoreCollections}
            disabled={tab === "pages" ? pagesLoading : collectionsLoading}
            style={{ marginTop: "8px", padding: "8px 16px", cursor: "pointer", background: "#fff", color: "#333", border: "1px solid #ccc", borderRadius: "4px", fontSize: "14px" }}
          >
            {(tab === "pages" ? pagesLoading : collectionsLoading) ? "Loading..." : `Load More ${tab === "pages" ? "Pages" : "Collections"}`}
          </button>
        )}
      </s-section>
    </s-page>
  );
}
