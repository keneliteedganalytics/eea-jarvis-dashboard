import { build as esbuild } from "esbuild";
import { build as viteBuild } from "vite";
import { rm, readFile, mkdir, cp } from "node:fs/promises";

// server deps to bundle to reduce openat(2) syscalls
// which helps cold start times
const allowlist = [
  "@google/generative-ai",
  "axios",
  "cors",
  "date-fns",
  "drizzle-orm",
  "drizzle-zod",
  "express",
  "express-rate-limit",
  "express-session",
  "jsonwebtoken",
  "memorystore",
  "multer",
  "nanoid",
  "nodemailer",
  "openai",
  "passport",
  "passport-local",
  "stripe",
  "uuid",
  "ws",
  "xlsx",
  "zod",
  "zod-validation-error",
];

async function buildAll() {
  await rm("dist", { recursive: true, force: true });

  console.log("building client...");
  await viteBuild();

  console.log("building server...");
  const pkg = JSON.parse(await readFile("package.json", "utf-8"));
  const allDeps = [
    ...Object.keys(pkg.dependencies || {}),
    ...Object.keys(pkg.devDependencies || {}),
  ];
  const externals = allDeps.filter((dep) => !allowlist.includes(dep));

  await esbuild({
    entryPoints: ["server/index.ts"],
    platform: "node",
    bundle: true,
    format: "cjs",
    outfile: "dist/index.cjs",
    define: {
      "process.env.NODE_ENV": '"production"',
    },
    minify: true,
    external: externals,
    logLevel: "info",
  });

  // Daily Show keyframes are read at runtime but the runtime image omits the
  // server/ tree, so copy them into dist/ where show-keyframes.ts can find them.
  console.log("copying show keyframes...");
  await mkdir("dist/show-keyframes", { recursive: true });
  await cp("server/assets/show-keyframes", "dist/show-keyframes", { recursive: true });

  // TTS pronunciation dictionary is read at runtime (server/services/pronunciation.ts)
  // but the runtime image omits the server/ tree, so ship it under dist/data/.
  console.log("copying pronunciation overrides...");
  await mkdir("dist/data", { recursive: true });
  await cp("server/data/pronunciation_overrides.json", "dist/data/pronunciation_overrides.json");
}

buildAll().catch((err) => {
  console.error(err);
  process.exit(1);
});
