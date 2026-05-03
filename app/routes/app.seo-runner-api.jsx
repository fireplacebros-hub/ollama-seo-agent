import { authenticate } from "../shopify.server";

export async function loader({ request }) {
  const { admin } = await authenticate.admin(request);
  const url = new URL(request.url);
  const cursor = url.searchParams.get("cursor");

  const query = cursor
    ? `{ products(first: 50, after: "${cursor}") { pageInfo { hasNextPage endCursor } nodes { id title description seo { description } media(first: 10) { nodes { ... on MediaImage { id image { url altText } } } } } } }`
    : `{ products(first: 50) { pageInfo { hasNextPage endCursor } nodes { id title description seo { description } media(first: 10) { nodes { ... on MediaImage { id image { url altText } } } } } } }`;

  const response = await admin.graphql(query);
  const { data } = await response.json();
  const { nodes, pageInfo } = data.products;

  return Response.json({
    products: nodes,
    hasNextPage: pageInfo.hasNextPage,
    endCursor: pageInfo.endCursor,
  });
}
