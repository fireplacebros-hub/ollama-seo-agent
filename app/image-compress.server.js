import sharp from "sharp";
export { isAlreadyWebP } from "./image-utils.js";

const MAX_SIZE_BYTES = 100 * 1024; // 100KB
const MAX_DIMENSION = 2048;

export async function downloadImage(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`Download failed: ${res.status} ${res.statusText}`);
  return Buffer.from(await res.arrayBuffer());
}

export async function compressToWebP(imageBuffer) {
  let quality = 85;
  let output;
  do {
    output = await sharp(imageBuffer)
      .resize(MAX_DIMENSION, MAX_DIMENSION, { fit: "inside", withoutEnlargement: true })
      .webp({ quality })
      .toBuffer();
    quality -= 10;
  } while (output.length > MAX_SIZE_BYTES && quality > 10);
  return output;
}

export async function stagedUploadWebP(admin, buffer, filename) {
  const fileSize = String(buffer.length);

  const stageRes = await admin.graphql(
    `mutation stagedUploadsCreate($input: [StagedUploadInput!]!) {
      stagedUploadsCreate(input: $input) {
        stagedTargets {
          url
          resourceUrl
          parameters { name value }
        }
        userErrors { field message }
      }
    }`,
    {
      variables: {
        input: [{
          filename,
          mimeType: "image/webp",
          fileSize,
          resource: "PRODUCT_IMAGE",
          httpMethod: "PUT",
        }],
      },
    }
  );

  const stageData = await stageRes.json();
  const userErrors = stageData.data?.stagedUploadsCreate?.userErrors;
  if (userErrors?.length) throw new Error(`Staged upload create failed: ${userErrors[0].message}`);
  if (!stageData.data?.stagedUploadsCreate?.stagedTargets?.[0]) {
    throw new Error(`Staged upload create returned no target: ${JSON.stringify(stageData).slice(0, 200)}`);
  }

  const target = stageData.data.stagedUploadsCreate.stagedTargets[0];

  // Signed GCS PUT URLs embed auth in query params — only Content-Type header is needed
  const putRes = await fetch(target.url, {
    method: "PUT",
    headers: { "Content-Type": "image/webp" },
    body: buffer,
    signal: AbortSignal.timeout(60000),
  });
  if (!putRes.ok) {
    const errBody = await putRes.text().catch(() => "");
    throw new Error(`Staged upload PUT failed (${putRes.status}): ${errBody.slice(0, 200)}`);
  }

  return target.resourceUrl;
}

export async function replaceProductImage(admin, productId, oldMediaId, resourceUrl, altText) {
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
        media: [{
          originalSource: resourceUrl,
          mediaContentType: "IMAGE",
          alt: altText || "",
        }],
      },
    }
  );

  const createData = await createRes.json();
  const createErrors = createData.data?.productCreateMedia?.userErrors;
  if (createErrors?.length) throw new Error(`Create media failed: ${createErrors[0].message}`);

  const deleteRes = await admin.graphql(
    `mutation productDeleteMedia($productId: ID!, $mediaIds: [ID!]!) {
      productDeleteMedia(productId: $productId, mediaIds: $mediaIds) {
        deletedMediaIds
        userErrors { field message }
      }
    }`,
    { variables: { productId, mediaIds: [oldMediaId] } }
  );

  const deleteData = await deleteRes.json();
  const deleteErrors = deleteData.data?.productDeleteMedia?.userErrors;
  if (deleteErrors?.length) {
    console.error(`[image-compress] delete error for ${oldMediaId}:`, deleteErrors[0].message);
  }

  return createData.data.productCreateMedia.media[0];
}

export async function compressAndReplaceImage({ admin, productId, mediaId, imageUrl, altText }) {
  const originalBuffer = await downloadImage(imageUrl);
  const originalSize = originalBuffer.length;
  const webpBuffer = await compressToWebP(originalBuffer);
  const compressedSize = webpBuffer.length;

  const urlPath = new URL(imageUrl).pathname;
  const baseName = urlPath.split("/").pop().split("?")[0].replace(/\.[^.]+$/, "");
  const filename = `${baseName}.webp`;

  const resourceUrl = await stagedUploadWebP(admin, webpBuffer, filename);
  const newMedia = await replaceProductImage(admin, productId, mediaId, resourceUrl, altText);

  return { originalSize, compressedSize, newMedia };
}
