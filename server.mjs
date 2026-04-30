import { createRequestHandler } from "@react-router/express";
import express from "express";

const app = express();
const port = process.env.PORT || 10000;

app.use(express.static("build/client", { immutable: true, maxAge: "1y" }));
app.use(express.static("build/client"));

app.all("*", createRequestHandler({
  build: await import("./build/server/index.js"),
}));

app.listen(port, "0.0.0.0", () => {
  console.log(`Server running on 0.0.0.0:${port}`);
});
