import { authenticate } from "../shopify.server";
import db from "../db.server";
import { isAlreadyWebP, compressAndReplaceImage } from "../image-compress.server";

async function processProductImages(admin, shop, productId) {
  const response = await admin.graphql(
    `query getProductMedia($id: ID!) {
      product(id: $id) {
        id
        media(first: 20) {
          nodes {
            ... on MediaImage {
              id
              image { url altText }
            }
          }
        }
      }
    }`,
    { variables: { id: productId } }
  );

  const { data } = await response.json();
  const mediaNodes = data?.product?.media?.nodes ?? [];

  for (const node of mediaNodes) {
    if (!node.image) continue;
    if (isAlreadyWebP(node.image.url)) continue;

    // Claim this mediaId atomically to prevent duplicate processing across webhook retries
    try {
      await db.compressedImage.create({ data: { shop, mediaId: node.id } });
    } catch (e) {
      if (e.code === "P2002") continue; // unique constraint — already claimed
      throw e;
    }

    try {
      const result = await compressAndReplaceImage({
        admin,
        productId,
        mediaId: node.id,
        imageUrl: node.image.url,
        altText: node.image.altText,
      });
      console.log(
        `[webhook] compressed ${node.id} for ${shop}: ${(result.originalSize / 1024).toFixed(1)}KB → ${(result.compressedSize / 1024).toFixed(1)}KB`
      );
    } catch (e) {
      console.error(`[webhook] compression failed for ${node.id} on ${shop}:`, e.message);
      // Release the claim so it can be retried on the next webhook delivery
      await db.compressedImage.delete({ where: { shop_mediaId: { shop, mediaId: node.id } } }).catch(() => {});
    }
  }
}

export const action = async ({ request }) => {
  const { shop, topic, payload, admin } = await authenticate.webhook(request);
  console.log(`[webhook] ${topic} for ${shop}`);

  // products/update REST payload uses numeric id; convert to GID
  const productGid = `gid://shopify/Product/${payload.id}`;

  // Return 200 immediately — Shopify requires response within 5s
  setImmediate(() => {
    processProductImages(admin, shop, productGid).catch((e) =>
      console.error(`[webhook] processProductImages error for ${productGid}:`, e.message)
    );
  });

  return new Response();
};
