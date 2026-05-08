-- CreateTable
CREATE TABLE "NoindexCollection" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "handle" TEXT NOT NULL,
    "gid" TEXT NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "NoindexCollection_shop_handle_key" ON "NoindexCollection"("shop", "handle");
