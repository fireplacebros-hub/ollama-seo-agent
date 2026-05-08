import { authenticate } from "../shopify.server";

export async function loader({ request }) {
  const { admin } = await authenticate.admin(request);
  const url = new URL(request.url);
  const cursor = url.searchParams.get("cursor");

  const query = cursor
    ? `{ pages(first: 50, after: "${cursor}") { pageInfo { hasNextPage endCursor } nodes { id title handle metafield(namespace: "global", key: "description_tag") { id value } } } }`
    : `{ pages(first: 50) { pageInfo { hasNextPage endCursor } nodes { id title handle metafield(namespace: "global", key: "description_tag") { id value } } } }`;

  const response = await admin.graphql(query);
  const { data } = await response.json();
  const { nodes, pageInfo } = data.pages;

  return Response.json({
    items: nodes,
    hasNextPage: pageInfo.hasNextPage,
    endCursor: pageInfo.endCursor,
  });
}
