import fs from "fs";
import path from "path";
import crypto from "crypto";

const projectRoot = process.cwd();
const envPath = path.join(projectRoot, ".env");

function upsertEnvKey(content: string, key: string, value: string): string {
  const line = `${key}=${value}`;
  const regex = new RegExp(`^${key}=.*$`, "m");
  if (regex.test(content)) {
    return content.replace(regex, line);
  }
  const trimmed = content.trimEnd();
  return trimmed.length ? `${trimmed}\n${line}\n` : `${line}\n`;
}

const apiKey = crypto.randomBytes(32).toString("hex");

let existing = "";
if (fs.existsSync(envPath)) {
  existing = fs.readFileSync(envPath, "utf-8");
}

const updated = upsertEnvKey(existing, "API_KEY", apiKey);
fs.writeFileSync(envPath, updated);

console.log("Generated API_KEY and wrote to .env");
console.log(`API_KEY=${apiKey}`);
