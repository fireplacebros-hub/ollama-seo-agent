-- CreateTable
CREATE TABLE "CompressedImage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "mediaId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE UNIQUE INDEX "CompressedImage_shop_mediaId_key" ON "CompressedImage"("shop", "mediaId");
