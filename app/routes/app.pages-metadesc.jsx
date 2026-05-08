import { useLoaderData, useFetcher } from "react-router";
import { authenticate, sessionStorage } from "../shopify.server";
import { useState } from "react";

const MAX_CHARS = 155;

function emptyTab(error = null) {
  return { items: [], hasNextPage: false, endCursor: null, error };
}

export async function loader({ request }) {
  const { admin, session } = await authenticate.admin(request);

  const grantedScopes = (session.scope || "").split(",").map(s => s.trim());
  const hasContentScope = grantedScopes.includes("read_content") || grantedScopes.includes("write_content");

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
      `{ collections(first: 50) { pageInfo { hasNextPage endCursor } nodes { id title handle description metafield(namespace: "global", key: "description_tag") { id value } } } }`
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

  // eslint-disable-next-line no-undef
  const ollamaHost = (process.env.OLLAMA_HOST || "").replace(/\/$/, "");
  return { pages, collections, hasContentScope, shop: session.shop, ollamaHost };
}

export async function action({ request }) {
  let admin, session;
  try {
    ({ admin, session } = await authenticate.admin(request));
  } catch (thrown) {
    if (thrown instanceof Response) {
      return Response.json({ error: "Session expired — please reload the app to re-authenticate." }, { status: 401 });
    }
    throw thrown;
  }
  const formData = await request.formData();
  const intent = formData.get("_intent");

  if (intent === "reauth") {
    try {
      const allSessions = await sessionStorage.findSessionsByShop(session.shop);
      await Promise.all(allSessions.map(s => sessionStorage.deleteSession(s.id)));
    } catch (e) {
      console.error("[pages-metadesc] reauth session clear error:", e.message);
    }
    return Response.json({ redirectUrl: `/auth?shop=${session.shop}` });
  }


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


export default function PagesMetaDesc() {
  const initial = useLoaderData();
  const saveFetcher = useFetcher();

  const [tab, setTab] = useState("pages");

  const [pages, setPages] = useState(initial.pages.items);
  const [pagesHasNext, setPagesHasNext] = useState(initial.pages.hasNextPage);
  const [pagesCursor, setPagesCursor] = useState(initial.pages.endCursor);
  const [pagesLoading, setPagesLoading] = useState(false);

  const [collections, setCollections] = useState(initial.collections.items);
  const [collectionsHasNext, setCollectionsHasNext] = useState(initial.collections.hasNextPage);
  const [collectionsCursor, setCollectionsCursor] = useState(initial.collections.endCursor);
  const [collectionsLoading, setCollectionsLoading] = useState(false);

  const [drafts, setDrafts] = useState({});
  const [saving, setSaving] = useState({});
  const [generating, setGenerating] = useState({});
  const [generatingAll, setGeneratingAll] = useState(false);
  const [generateAllProgress, setGenerateAllProgress] = useState({ done: 0, total: 0 });
  const [savingAll, setSavingAll] = useState(false);
  const [saveAllProgress, setSaveAllProgress] = useState({ done: 0, total: 0 });
  const [results, setResults] = useState({});
  const [reauthLoading, setReauthLoading] = useState(false);

  const getDraft = (item) =>
    drafts[item.id] !== undefined ? drafts[item.id] : (item.metafield?.value || "");

  const generateOne = async (item) => {
    const isCollection = tab === "collections";
    setGenerating(prev => ({ ...prev, [item.id]: true }));
    setResults(prev => ({ ...prev, [item.id]: undefined }));

    if (!initial.ollamaHost) {
      setResults(prev => ({ ...prev, [item.id]: { error: "OLLAMA_HOST is not configured on the server." } }));
      setGenerating(prev => ({ ...prev, [item.id]: false }));
      return;
    }

    const prompt = isCollection
      ? `You are an SEO copywriter. Write a meta description for this product collection page.\n\nCollection name: ${item.title}\nCollection description: ${item.description || "None provided"}\n\nSTRICT RULES:\n- Total length must be 120-155 characters. Count every character including spaces before submitting.\n- Describe what products are in this collection.\n- End with a short action phrase.\n- Return ONLY the meta description on a single line. No quotes. No labels. No explanation.`
      : `You are an SEO copywriter. Write a meta description for this page.\n\nPage title: ${item.title}\n\nSTRICT RULES:\n- Total length must be 120-155 characters. Count every character including spaces before submitting.\n- Describe what the page is about clearly and specifically.\n- End with a short action phrase or benefit.\n- Return ONLY the meta description on a single line. No quotes. No labels. No explanation.`;

    try {
      const res = await fetch(`${initial.ollamaHost}/api/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "ngrok-skip-browser-warning": "true" },
        body: JSON.stringify({ model: "llama3.1:8b", prompt, stream: false }),
      });
      const text = await res.text();
      if (!res.ok || text.trimStart().startsWith("<")) {
        setResults(prev => ({ ...prev, [item.id]: { error: `Ollama unavailable (HTTP ${res.status}) — is ngrok + Ollama running?` } }));
      } else {
        const data = JSON.parse(text);
        let generated = data.response?.trim().split("\n")[0].replace(/^["\']|["\']$/g, "") || "";
        if (generated.length > MAX_CHARS) {
          const cut = generated.slice(0, MAX_CHARS - 3);
          generated = cut.slice(0, cut.lastIndexOf(" ")) + "...";
        }
        if (!generated) {
          setResults(prev => ({ ...prev, [item.id]: { error: "Ollama returned an empty response." } }));
        } else {
          setDrafts(prev => ({ ...prev, [item.id]: generated }));
        }
      }
    } catch (e) {
      setResults(prev => ({ ...prev, [item.id]: { error: "Network error: " + e.message } }));
    }
    setGenerating(prev => ({ ...prev, [item.id]: false }));
  };

  const generateAllMissing = async () => {
    const currentItems = tab === "pages" ? pages : collections;
    const missing = currentItems.filter(i => {
      const hasMeta = results[i.id]?.success ? results[i.id].value : i.metafield?.value;
      return !hasMeta && !drafts[i.id];
    });
    if (missing.length === 0) return;
    setGeneratingAll(true);
    setGenerateAllProgress({ done: 0, total: missing.length });
    for (const item of missing) {
      await generateOne(item);
      setGenerateAllProgress(prev => ({ ...prev, done: prev.done + 1 }));
    }
    setGeneratingAll(false);
  };

  const saveAll = async () => {
    const currentItems = tab === "pages" ? pages : collections;
    const toSave = currentItems.filter(i => {
      const draft = drafts[i.id] !== undefined ? drafts[i.id] : (i.metafield?.value || "");
      return draft.trim() && draft.length <= MAX_CHARS;
    });
    if (toSave.length === 0) return;
    setSavingAll(true);
    setSaveAllProgress({ done: 0, total: toSave.length });
    for (const item of toSave) {
      await saveOne(item);
      setSaveAllProgress(prev => ({ ...prev, done: prev.done + 1 }));
    }
    setSavingAll(false);
  };

  const shopParam = initial.shop ? `?shop=${initial.shop}` : "";

  const saveOne = (item) => new Promise((resolve) => {
    const value = (drafts[item.id] ?? item.metafield?.value ?? "").trim();
    setSaving(prev => ({ ...prev, [item.id]: true }));
    saveFetcher.submit(
      { ownerId: item.id, value },
      { method: "POST", action: `/app/pages-metadesc${shopParam}` }
    );
    const check = setInterval(() => {
      if (saveFetcher.state === "idle") {
        clearInterval(check);
        const data = saveFetcher.data || { error: "No response" };
        setResults(prev => ({ ...prev, [item.id]: data }));
        setSaving(prev => ({ ...prev, [item.id]: false }));
        resolve(data);
      }
    }, 100);
  });

  const handleReauth = () => {
    saveFetcher.submit(
      { _intent: "reauth" },
      { method: "POST", action: `/app/pages-metadesc${shopParam}` }
    );
    setReauthLoading(true);
  };

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
  const hasMeta = items.filter(i => results[i.id]?.success ? results[i.id].value : i.metafield?.value).length;
  const missing = items.length - hasMeta;
  const missingWithoutDraft = items.filter(i => {
    const hasMeta = results[i.id]?.success ? results[i.id].value : i.metafield?.value;
    return !hasMeta && !drafts[i.id];
  }).length;
  const savableCount = items.filter(i => {
    const draft = drafts[i.id] !== undefined ? drafts[i.id] : (i.metafield?.value || "");
    return draft.trim() && draft.length <= MAX_CHARS;
  }).length;

  const tabStyle = (t) => ({
    padding: "10px 24px", fontWeight: "600", fontSize: "14px", textDecoration: "none",
    color: tab === t ? "#008060" : "#6d7175",
    borderBottom: tab === t ? "2px solid #008060" : "2px solid transparent",
    marginBottom: "-2px", cursor: "pointer", background: "none",
    borderTop: "none", borderLeft: "none", borderRight: "none",
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

      {!initial.hasContentScope && (
        <s-section>
          <div style={{ padding: "12px 16px", background: "#fff3cd", border: "1px solid #ffc107", borderRadius: "6px", color: "#856404", fontSize: "14px" }}>
            <strong>Missing read_content permission.</strong> The app's access token was granted before this scope was added.
            <br /><br />
            Click below to clear your session and re-authorize — this will request the correct permissions.
            <br /><br />
            <button
              onClick={handleReauth}
              disabled={reauthLoading}
              style={{ padding: "6px 16px", background: "#ffc107", color: "#333", border: "none", borderRadius: "4px", fontWeight: "600", cursor: "pointer" }}
            >
              {reauthLoading ? "Redirecting..." : "Fix Permissions & Re-authorize"}
            </button>
          </div>
        </s-section>
      )}

      {tabError && (
        <s-section>
          <div style={{ padding: "12px 16px", background: "#fff3cd", border: "1px solid #ffc107", borderRadius: "6px", color: "#856404", fontSize: "14px" }}>
            <strong>Could not load {tab}.</strong> Error: {tabError}
            <br /><br />
            If this says "Access denied", click <strong>Fix Permissions & Re-authorize</strong> above, or uninstall and reinstall the app from your Shopify admin.
          </div>
        </s-section>
      )}

      <s-section>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "12px" }}>
          <s-paragraph>
            Set the meta description for each {tab === "pages" ? "page" : "collection"} — appears as the snippet in Google search results.
            Aim for 120–155 characters.
          </s-paragraph>
          {items.length > 0 && (
            <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
              <button
                onClick={generateAllMissing}
                disabled={generatingAll || missingWithoutDraft === 0}
                style={{
                  padding: "8px 20px", cursor: generatingAll || missingWithoutDraft === 0 ? "not-allowed" : "pointer",
                  background: "#008060", color: "#fff", border: "none", borderRadius: "4px",
                  fontSize: "13px", fontWeight: "600", opacity: generatingAll || missingWithoutDraft === 0 ? 0.6 : 1,
                  whiteSpace: "nowrap",
                }}
              >
                {generatingAll
                  ? `Generating... (${generateAllProgress.done}/${generateAllProgress.total})`
                  : `Generate All Missing (${missingWithoutDraft})`}
              </button>
              <button
                onClick={saveAll}
                disabled={savingAll || generatingAll || savableCount === 0}
                style={{
                  padding: "8px 20px", cursor: savingAll || generatingAll || savableCount === 0 ? "not-allowed" : "pointer",
                  background: "#fff", color: "#008060", border: "1px solid #008060", borderRadius: "4px",
                  fontSize: "13px", fontWeight: "600", opacity: savingAll || generatingAll || savableCount === 0 ? 0.6 : 1,
                  whiteSpace: "nowrap",
                }}
              >
                {savingAll
                  ? `Saving... (${saveAllProgress.done}/${saveAllProgress.total})`
                  : `Save All (${savableCount})`}
              </button>
            </div>
          )}
        </div>
      </s-section>

      {items.map(item => {
        const draft = getDraft(item);
        const result = results[item.id];
        const isSaving = saving[item.id];
        const isGenerating = generating[item.id];
        const isOver = draft.length > MAX_CHARS;
        const charCountColor = draft.length === 0 ? "#6d7175" : isOver ? "#d72c0d" : draft.length >= 120 ? "#008060" : "#856404";
        const displayValue = result?.success ? result.value : item.metafield?.value;

        return (
          <s-section key={item.id} heading={item.title}>
            <div style={{ marginBottom: "8px", display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center" }}>
              <span style={{ fontSize: "12px", color: "#6d7175" }}>/{item.handle}</span>
              {displayValue ? (
                <span style={{ padding: "2px 8px", borderRadius: "4px", fontSize: "12px", background: "#d4edda", color: "#155724" }}>
                  Has meta description ({displayValue.length} chars)
                </span>
              ) : (
                <span style={{ padding: "2px 8px", borderRadius: "4px", fontSize: "12px", background: "#f8d7da", color: "#721c24" }}>
                  Missing meta description
                </span>
              )}
              {result?.success && (
                <span style={{ padding: "2px 8px", borderRadius: "4px", fontSize: "12px", background: "#d4edda", color: "#155724" }}>✓ Saved</span>
              )}
            </div>
            <textarea
              value={draft}
              onChange={e => setDrafts(prev => ({ ...prev, [item.id]: e.target.value }))}
              placeholder="Write a meta description (120–155 characters)..."
              rows={3}
              style={{
                width: "100%", boxSizing: "border-box", padding: "8px 10px",
                border: `1px solid ${isOver ? "#d72c0d" : "#ccc"}`, borderRadius: "4px",
                fontSize: "13px", resize: "vertical", fontFamily: "inherit", display: "block",
              }}
            />
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: "8px" }}>
              <span style={{ fontSize: "12px", color: charCountColor, fontWeight: "600" }}>
                {draft.length} / {MAX_CHARS}{isOver ? ` — ${draft.length - MAX_CHARS} over limit` : ""}
              </span>
              <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
                {result?.error && <span style={{ fontSize: "12px", color: "#d72c0d" }}>{result.error}</span>}
                <button
                  onClick={() => generateOne(item)}
                  disabled={isGenerating || isSaving || generatingAll}
                  style={{
                    padding: "6px 18px", cursor: isGenerating || isSaving || generatingAll ? "not-allowed" : "pointer",
                    background: "#fff", color: "#008060", border: "1px solid #008060", borderRadius: "4px",
                    fontSize: "13px", fontWeight: "600", opacity: isGenerating || isSaving || generatingAll ? 0.5 : 1,
                  }}
                >
                  {isGenerating ? "Generating..." : "Generate with AI"}
                </button>
                <button
                  onClick={() => saveOne(item)}
                  disabled={isSaving || isGenerating || isOver || !draft.trim() || savingAll}
                  style={{
                    padding: "6px 18px", cursor: isSaving || isGenerating || isOver || !draft.trim() || savingAll ? "not-allowed" : "pointer",
                    background: "#008060", color: "#fff", border: "none", borderRadius: "4px",
                    fontSize: "13px", fontWeight: "600", opacity: isSaving || isGenerating || isOver || !draft.trim() || savingAll ? 0.5 : 1,
                  }}
                >
                  {isSaving ? "Saving..." : "Save"}
                </button>
              </div>
            </div>
          </s-section>
        );
      })}

      {(tab === "pages" ? pagesHasNext : collectionsHasNext) && (
        <s-section>
          <button
            onClick={tab === "pages" ? loadMorePages : loadMoreCollections}
            disabled={tab === "pages" ? pagesLoading : collectionsLoading}
            style={{ padding: "8px 16px", cursor: "pointer", background: "#fff", color: "#333", border: "1px solid #ccc", borderRadius: "4px", fontSize: "14px" }}
          >
            {(tab === "pages" ? pagesLoading : collectionsLoading) ? "Loading..." : `Load More ${tab === "pages" ? "Pages" : "Collections"}`}
          </button>
        </s-section>
      )}
    </s-page>
  );
}
