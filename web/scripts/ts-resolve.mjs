/** Entry point for `node --import ./scripts/ts-resolve.mjs`. */
import { register } from "node:module";
register("./ts-resolve-hooks.mjs", import.meta.url);
