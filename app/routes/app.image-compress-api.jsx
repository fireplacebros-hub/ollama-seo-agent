import { authenticate } from "../shopify.server";
import { isAlreadyWebP, compressAndReplaceImage } from "../image-compress.server";

export async function action({ request }) {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();

  const mediaId = formData.get("mediaId");
  const productId = formData.get("productId");
  const imageUrl = formData.get("imageUrl");
  const altText = formData.get("altText") || "";

  if (!mediaId || !productId || !imageUrl) {
    return Response.json({ error: "Missing required fields" }, { status: 400 });
  }

  if (isAlreadyWebP(imageUrl)) {
    return Response.json({ error: "Image is already WebP" }, { status: 400 });
  }

  try {
    const result = await compressAndReplaceImage({ admin, productId, mediaId, imageUrl, altText });
    return Response.json({
      success: true,
      originalSize: result.originalSize,
      compressedSize: result.compressedSize,
      savedBytes: result.originalSize - result.compressedSize,
    });
  } catch (e) {
    console.error("[image-compress-api] error:", e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
