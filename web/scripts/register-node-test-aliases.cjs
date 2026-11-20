// Stylesheets, images and other non-JS imports survive transpilation as bare
// require() calls; stub them so tests can load components that pull them in.
for (const ext of [
  ".css",
  ".scss",
  ".sass",
  ".less",
  ".svg",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".ico",
  ".woff",
  ".woff2",
  ".mp3",
  ".wav",
  ".mp4",
  ".webm",
]) {
  require.extensions[ext] = () => ({});
}

const Module = require("node:module");
const path = require("node:path");

const distRoot = path.join(process.cwd(), "dist", "node-tests");
const originalResolveFilename = Module._resolveFilename;

Module._resolveFilename = function (request, parent, isMain, options) {
  if (typeof request === "string" && request.startsWith("@/")) {
    return originalResolveFilename.call(
      this,
      path.join(distRoot, request.slice(2)),
      parent,
      isMain,
      options,
    );
  }

  return originalResolveFilename.call(this, request, parent, isMain, options);
};
