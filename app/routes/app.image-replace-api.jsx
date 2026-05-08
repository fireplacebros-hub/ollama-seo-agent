import { authenticate } from "../shopify.server";

export async function action({ request }) {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const productId = formData.get("productId");
  const oldMediaId = formData.get("oldMediaId");
  const resourceUrl = formData.get("resourceUrl");
  const altText = formData.get("altText") || "";

  const createRes = await admin.graphql(
    `mutation productCreateMedia($productId: ID!, $media: [CreateMediaInput!]!) {
      productCreateMedia(productId: $productId, media: $media) {
        media { ... on MediaImage { id image { url } } }
        userErrors { field message }
      }
    }`,
    {
      variables: {
        productId,
        media: [{ originalSource: resourceUrl, mediaContentType: "IMAGE", alt: altText }],
      },
    }
  );

  const createData = await createRes.json();
  const createErrors = createData.data?.productCreateMedia?.userErrors;
  if (createErrors?.length) return Response.json({ error: createErrors[0].message }, { status: 422 });

  await admin.graphql(
    `mutation productDeleteMedia($productId: ID!, $mediaIds: [ID!]!) {
      productDeleteMedia(productId: $productId, mediaIds: $mediaIds) {
        deletedMediaIds
        userErrors { field message }
      }
    }`,
    { variables: { productId, mediaIds: [oldMediaId] } }
  );

  return Response.json({ success: true, newUrl: createData.data.productCreateMedia.media[0]?.image?.url });
}
