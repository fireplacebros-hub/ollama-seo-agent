import { useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { useState } from "react";

const DEFAULT_NOINDEX_TITLES = [
  "Price Category 1",
  "Price Category 2",
  "Price Category 3",
  "Price Category 4",
  "Google Ads",
  "Dimplex 2025 Blog",
];

const NS = "noindex_manager";
const KEY = "enabled";

async function ensureMetafieldDefinition(admin) {
  const res = await admin.graphql(
    `mutation metafieldDefinitionCreate($def: MetafieldDefinitionInput!) {
      metafieldDefinitionCreate(definition: $def) {
        createdDefinition { id }
        userErrors { code field message }
      }
    }`,
    {
      variables: {
        def: {
          name: "Noindex Enabled",
          namespace: NS,
          key: KEY,
          type: "boolean",
          ownerType: "COLLECTION",
          access: { storefront: "PUBLIC_READ" },
        },
      },
    }
  );
  await res.json(); // fire and forget — TAKEN error is fine
}

async function loadAllCollections(admin) {
  let collections = [];
  let cursor = null;
  let hasNext = true;

  while (hasNext && collections.length < 250) {
    const after = cursor ? `, after: "${cursor}"` : "";
    const res = await admin.graphql(
      `{ collections(first: 50${after}) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id title handle
            metafield(namespace: "${NS}", key: "${KEY}") { value }
          }
        }
      }`
    );
    const json = await res.json();
    const nodes = json.data?.collections?.nodes ?? [];
    collections = [...collections, ...nodes];
    hasNext = json.data?.collections?.pageInfo?.hasNextPage ?? false;
    cursor = json.data?.collections?.pageInfo?.endCursor ?? null;
  }

  return collections;
}

export async function loader({ request }) {
  const { admin, session } = await authenticate.admin(request);

  await ensureMetafieldDefinition(admin);

  const collections = await loadAllCollections(admin);

  const records = await prisma.noindexCollection.findMany({
    where: { shop: session.shop },
  });
  const noindexHandles = records.map((r) => r.handle);

  return { collections, noindexHandles };
}

export async function action({ request }) {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("_intent");

  if (intent === "toggle") {
    const gid = formData.get("gid");
    const handle = formData.get("handle");
    const enable = formData.get("enable") === "true";

    if (enable) {
      await prisma.noindexCollection.upsert({
        where: { shop_handle: { shop: session.shop, handle } },
        update: { gid },
        create: { shop: session.shop, handle, gid },
      });
    } else {
      await prisma.noindexCollection.deleteMany({
        where: { shop: session.shop, handle },
      });
    }

    await admin.graphql(
      `mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) {
          metafields { id value }
          userErrors { field message }
        }
      }`,
      {
        variables: {
          metafields: [
            {
              ownerId: gid,
              namespace: NS,
              key: KEY,
              value: enable ? "true" : "false",
              type: "boolean",
            },
          ],
        },
      }
    );

    return Response.json({ success: true, handle, enabled: enable });
  }

  if (intent === "apply_defaults") {
    const collections = await loadAllCollections(admin);
    const targets = collections.filter((c) =>
      DEFAULT_NOINDEX_TITLES.includes(c.title)
    );
    const applied = [];

    for (const col of targets) {
      await prisma.noindexCollection.upsert({
        where: { shop_handle: { shop: session.shop, handle: col.handle } },
        update: { gid: col.id },
        create: { shop: session.shop, handle: col.handle, gid: col.id },
      });

      await admin.graphql(
        `mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
          metafieldsSet(metafields: $metafields) {
            metafields { id value }
            userErrors { field message }
          }
        }`,
        {
          variables: {
            metafields: [
              {
                ownerId: col.id,
                namespace: NS,
                key: KEY,
                value: "true",
                type: "boolean",
              },
            ],
          },
        }
      );

      applied.push(col.title);
    }

    return Response.json({ success: true, applied });
  }

  return Response.json({ error: "Unknown intent" }, { status: 400 });
}

export default function NoindexManager() {
  const { collections, noindexHandles } = useLoaderData();

  const [noindex, setNoindex] = useState(new Set(noindexHandles));
  const [toggling, setToggling] = useState({});
  const [applyingDefaults, setApplyingDefaults] = useState(false);
  const [applyError, setApplyError] = useState(null);

  const hasAllDefaults = DEFAULT_NOINDEX_TITLES.every((title) => {
    const col = collections.find((c) => c.title === title);
    return !col || noindex.has(col.handle);
  });

  const toggle = async (col) => {
    const enable = !noindex.has(col.handle);
    setToggling((prev) => ({ ...prev, [col.id]: true }));
    const form = new FormData();
    form.append("_intent", "toggle");
    form.append("gid", col.id);
    form.append("handle", col.handle);
    form.append("enable", String(enable));
    try {
      const res = await fetch(
        "https://ollama-seo-agent.onrender.com/app/noindex",
        { method: "POST", body: form }
      );
      const data = await res.json();
      if (data.success) {
        setNoindex((prev) => {
          const next = new Set(prev);
          enable ? next.add(col.handle) : next.delete(col.handle);
          return next;
        });
      }
    } catch {
      /* ignore */
    }
    setToggling((prev) => ({ ...prev, [col.id]: false }));
  };

  const applyDefaults = async () => {
    setApplyingDefaults(true);
    setApplyError(null);
    const form = new FormData();
    form.append("_intent", "apply_defaults");
    try {
      const res = await fetch(
        "https://ollama-seo-agent.onrender.com/app/noindex",
        { method: "POST", body: form }
      );
      const data = await res.json();
      if (data.success) {
        const applied = data.applied ?? [];
        setNoindex((prev) => {
          const next = new Set(prev);
          collections
            .filter((c) => applied.includes(c.title))
            .forEach((c) => next.add(c.handle));
          return next;
        });
      } else {
        setApplyError("Failed to apply defaults.");
      }
    } catch {
      setApplyError("Request failed.");
    }
    setApplyingDefaults(false);
  };

  const noindexCount = noindex.size;

  const btn = (label, onClick, disabled, variant = "primary") => ({
    style: {
      padding: "6px 16px",
      cursor: disabled ? "not-allowed" : "pointer",
      background: variant === "danger" ? "#fff" : variant === "primary" ? "#008060" : "#fff",
      color: variant === "danger" ? "#d72c0d" : variant === "primary" ? "#fff" : "#d72c0d",
      border: variant === "primary" ? "none" : `1px solid ${variant === "danger" ? "#d72c0d" : "#008060"}`,
      borderRadius: "4px",
      fontSize: "13px",
      fontWeight: "600",
      opacity: disabled ? 0.5 : 1,
    },
  });

  return (
    <s-page heading="Noindex Manager">
      <s-section>
        <table
          style={{
            width: "100%",
            borderCollapse: "collapse",
            border: "1px solid #e1e3e5",
            borderRadius: "8px",
            overflow: "hidden",
          }}
        >
          <tbody>
            <tr>
              <td
                style={{
                  padding: "10px 20px",
                  textAlign: "center",
                  borderRight: "1px solid #e1e3e5",
                }}
              >
                <div style={{ fontSize: "22px", fontWeight: "700", color: "#c4481a" }}>
                  {noindexCount}
                </div>
                <div style={{ fontSize: "12px", color: "#6d7175", marginTop: "2px" }}>
                  Noindexed
                </div>
              </td>
              <td style={{ padding: "10px 20px", textAlign: "center" }}>
                <div style={{ fontSize: "22px", fontWeight: "700", color: "#333" }}>
                  {collections.length}
                </div>
                <div style={{ fontSize: "12px", color: "#6d7175", marginTop: "2px" }}>
                  Total collections
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </s-section>

      {!hasAllDefaults && (
        <s-section>
          <div
            style={{
              padding: "12px 16px",
              background: "#fff3cd",
              border: "1px solid #ffc107",
              borderRadius: "6px",
              color: "#856404",
              fontSize: "14px",
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              gap: "16px",
              flexWrap: "wrap",
            }}
          >
            <div>
              <strong>Default noindex collections not fully applied.</strong>
              <br />
              Price Category 1–4, Google Ads, and Dimplex 2025 Blog should be
              noindexed.
            </div>
            <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
              {applyError && (
                <span style={{ fontSize: "12px", color: "#d72c0d" }}>
                  {applyError}
                </span>
              )}
              <button
                onClick={applyDefaults}
                disabled={applyingDefaults}
                style={{
                  padding: "6px 16px",
                  background: "#ffc107",
                  color: "#333",
                  border: "none",
                  borderRadius: "4px",
                  fontWeight: "600",
                  cursor: applyingDefaults ? "not-allowed" : "pointer",
                  opacity: applyingDefaults ? 0.6 : 1,
                  whiteSpace: "nowrap",
                }}
              >
                {applyingDefaults ? "Applying..." : "Apply Defaults"}
              </button>
            </div>
          </div>
        </s-section>
      )}

      <s-section>
        <s-paragraph>
          Enable noindex on collections you don't want indexed by Google.
          Changes take effect via the Theme App Extension — enable the
          "Noindex Manager" App Embed in your Shopify theme editor after
          running <code>shopify app deploy</code>.
        </s-paragraph>
      </s-section>

      {collections.map((col) => {
        const isNoindex = noindex.has(col.handle);
        const isToggling = toggling[col.id];

        return (
          <s-section key={col.id}>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                gap: "12px",
              }}
            >
              <div>
                <div style={{ fontWeight: "600", fontSize: "14px" }}>
                  {col.title}
                </div>
                <div style={{ fontSize: "12px", color: "#6d7175", marginTop: "2px" }}>
                  /collections/{col.handle}
                </div>
              </div>
              <div style={{ display: "flex", gap: "8px", alignItems: "center", flexShrink: 0 }}>
                {isNoindex && (
                  <span
                    style={{
                      padding: "2px 8px",
                      borderRadius: "4px",
                      fontSize: "12px",
                      background: "#ffd7d7",
                      color: "#d72c0d",
                      fontWeight: "600",
                    }}
                  >
                    Noindex On
                  </span>
                )}
                <button
                  onClick={() => toggle(col)}
                  disabled={isToggling}
                  style={{
                    padding: "6px 16px",
                    cursor: isToggling ? "not-allowed" : "pointer",
                    background: isNoindex ? "#fff" : "#d72c0d",
                    color: isNoindex ? "#008060" : "#fff",
                    border: isNoindex ? "1px solid #008060" : "none",
                    borderRadius: "4px",
                    fontSize: "13px",
                    fontWeight: "600",
                    opacity: isToggling ? 0.5 : 1,
                    whiteSpace: "nowrap",
                  }}
                >
                  {isToggling
                    ? "..."
                    : isNoindex
                    ? "Remove Noindex"
                    : "Enable Noindex"}
                </button>
              </div>
            </div>
          </s-section>
        );
      })}
    </s-page>
  );
}
