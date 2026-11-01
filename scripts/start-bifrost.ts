// Starts a STOCK Bifrost (npx @maximhq/bifrost) with ./bifrost as its app dir,
// passing the variables from .env so config.json's "env.*" references resolve.
// Equivalent shell command:
//   cd bifrost && npx -y @maximhq/bifrost -app-dir . -port 8080
// The app dir is passed as "." with cwd set, so paths containing spaces work
// on Windows (where npx must be started through a shell).

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

if (existsSync(".env")) process.loadEnvFile(".env");
const port = (process.env.BIFROST_PORT ?? "8080").replace(/[^0-9]/g, "");
const version = (process.env.BIFROST_TRANSPORT_VERSION ?? "").replace(/[^0-9a-zA-Z.-]/g, "");
const args = ["-y", "@maximhq/bifrost", "-app-dir", ".", "-port", port, "-log-style", "pretty"];
if (version) args.push("--transport-version", version);
console.log(`(cd bifrost) npx ${args.join(" ")}`);
const command = `npx ${args.join(" ")}`;
const child = spawn(command, { cwd: resolve("bifrost"), stdio: "inherit", env: process.env, shell: true });
child.on("exit", (code) => process.exit(code ?? 0));
