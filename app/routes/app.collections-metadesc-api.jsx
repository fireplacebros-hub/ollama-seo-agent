import { authenticate } from "../shopify.server";

export async function loader({ request }) {
  const { admin } = await authenticate.admin(request);
  const url = new URL(request.url);
  const cursor = url.searchParams.get("cursor");

  const query = cursor
    ? `{ collections(first: 50, after: "${cursor}") { pageInfo { hasNextPage endCursor } nodes { id title handle description metafield(namespace: "global", key: "description_tag") { id value } } } }`
    : `{ collections(first: 50) { pageInfo { hasNextPage endCursor } nodes { id title handle description metafield(namespace: "global", key: "description_tag") { id value } } } }`;

  const response = await admin.graphql(query);
  const { data } = await response.json();
  const { nodes, pageInfo } = data.collections;

  return Response.json({
    items: nodes,
    hasNextPage: pageInfo.hasNextPage,
    endCursor: pageInfo.endCursor,
  });
}
