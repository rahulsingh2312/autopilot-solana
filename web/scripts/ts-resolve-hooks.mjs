/**
 * Lets Node resolve the app's extensionless imports.
 *
 * `src/lib/**` is written for a bundler (`moduleResolution: "bundler"`), so it
 * imports `"./program"` rather than `"./program.ts"`. Node's ESM resolver
 * requires the extension and fails on those specifiers. Rather than rewriting
 * application code to suit a script, this hook retries a failed relative
 * specifier with the extensions a bundler would have tried.
 *
 * It also maps the `@/` path alias, which is a tsconfig `paths` entry the
 * bundler understands and Node does not.
 *
 * The alternative — scripts re-deriving accounts instead of importing the
 * app's builders — is how a test ends up passing while the site it is meant to
 * cover fails.
 */

import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const CANDIDATES = [".ts", ".tsx", ".js", "/index.ts", "/index.tsx"];

/** Mirrors `"@/*": ["./src/*"]` in tsconfig.json. */
const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

export async function resolve(specifier, context, next) {
  if (specifier.startsWith("@/")) {
    specifier = pathToFileURL(join(SRC, specifier.slice(2))).href;
  }
  try {
    return await next(specifier, context);
  } catch (error) {
    if (!specifier.startsWith(".") && !specifier.startsWith("file:")) throw error;
    for (const ext of CANDIDATES) {
      try {
        return await next(specifier + ext, context);
      } catch {
        /* try the next one */
      }
    }
    throw error;
  }
}
