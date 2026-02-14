import { spawnSync } from "node:child_process";
import { createWriteStream, existsSync, readdirSync, writeFileSync } from "node:fs";
import { pipeline } from "node:stream/promises";

function fail(message) {
  console.error(`restore_from_s3_error: ${message}`);
  process.exit(1);
}

function formatStamp(date = new Date()) {
  const y = String(date.getFullYear());
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  const ss = String(date.getSeconds()).padStart(2, "0");
  return `${y}${m}${d}-${hh}${mm}${ss}`;
}

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  return value ? value : null;
}

function readConfig() {
  const required = [
    "OPENCLAW_BACKUP_S3_ENDPOINT",
    "OPENCLAW_BACKUP_S3_BUCKET",
    "OPENCLAW_BACKUP_S3_ACCESS_KEY_ID",
    "OPENCLAW_BACKUP_S3_SECRET_ACCESS_KEY",
  ];
  const missing = required.filter((name) => !requiredEnv(name));
  if (missing.length > 0) {
    fail(`Missing required env vars: ${missing.join(", ")}`);
  }

  return {
    endpoint: requiredEnv("OPENCLAW_BACKUP_S3_ENDPOINT"),
    bucket: requiredEnv("OPENCLAW_BACKUP_S3_BUCKET"),
    region: requiredEnv("OPENCLAW_BACKUP_S3_REGION") ?? "auto",
    accessKeyId: requiredEnv("OPENCLAW_BACKUP_S3_ACCESS_KEY_ID"),
    secretAccessKey: requiredEnv("OPENCLAW_BACKUP_S3_SECRET_ACCESS_KEY"),
  };
}

async function loadS3Client() {
  try {
    return await import("@aws-sdk/client-s3");
  } catch {
    fail("Missing dependency @aws-sdk/client-s3. Install with: pnpm add -w @aws-sdk/client-s3");
  }
}

async function downloadToFile(body, filePath) {
  if (body && typeof body.pipe === "function") {
    await pipeline(body, createWriteStream(filePath));
    return;
  }
  if (body && typeof body.transformToByteArray === "function") {
    const bytes = await body.transformToByteArray();
    writeFileSync(filePath, Buffer.from(bytes));
    return;
  }
  fail("S3 response body is not readable");
}

function ensureRestored(dirPath) {
  if (!existsSync(dirPath)) {
    fail(`Missing restored directory: ${dirPath}`);
  }
  const entries = readdirSync(dirPath);
  if (entries.length === 0) {
    fail(`Restored directory is empty: ${dirPath}`);
  }
}

async function main() {
  const key = process.argv[2]?.trim();
  if (!key) {
    fail("Usage: node scripts/restore-from-s3.mjs <object-key>");
  }

  const cfg = readConfig();
  const { S3Client, GetObjectCommand } = await loadS3Client();
  const client = new S3Client({
    region: cfg.region,
    endpoint: cfg.endpoint,
    forcePathStyle: true,
    credentials: {
      accessKeyId: cfg.accessKeyId,
      secretAccessKey: cfg.secretAccessKey,
    },
  });

  const archivePath = `/tmp/openclaw-restore-${formatStamp()}.tar.gz`;
  const response = await client.send(
    new GetObjectCommand({
      Bucket: cfg.bucket,
      Key: key,
    }),
  );

  if (!response.Body) {
    fail(`Object has no body: ${key}`);
  }

  await downloadToFile(response.Body, archivePath);

  const extract = spawnSync("tar", ["-xzf", archivePath, "-C", "/"], { stdio: "inherit" });
  if (extract.status !== 0) {
    fail("tar extract failed");
  }

  ensureRestored("/data/.openclaw");
  ensureRestored("/data/workspace");

  console.log(`restore_from_s3_ok: key=${key} archive=${archivePath}`);
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});
