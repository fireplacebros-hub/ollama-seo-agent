import { authenticate } from "../shopify.server";

export async function action({ request }) {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const filename = formData.get("filename");
  const fileSize = formData.get("fileSize");

  const res = await admin.graphql(
    `mutation stagedUploadsCreate($input: [StagedUploadInput!]!) {
      stagedUploadsCreate(input: $input) {
        stagedTargets { url resourceUrl }
        userErrors { field message }
      }
    }`,
    {
      variables: {
        input: [{
          filename,
          mimeType: "image/webp",
          fileSize: String(fileSize),
          resource: "PRODUCT_IMAGE",
          httpMethod: "PUT",
        }],
      },
    }
  );

  const data = await res.json();
  const errors = data.data?.stagedUploadsCreate?.userErrors;
  if (errors?.length) return Response.json({ error: errors[0].message }, { status: 422 });
  const target = data.data?.stagedUploadsCreate?.stagedTargets?.[0];
  if (!target) return Response.json({ error: "No staged target returned" }, { status: 500 });
  return Response.json({ url: target.url, resourceUrl: target.resourceUrl });
}
