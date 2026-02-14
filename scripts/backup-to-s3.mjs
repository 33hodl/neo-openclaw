import { execFileSync, spawnSync } from "node:child_process";
import { createReadStream, statSync } from "node:fs";

function fail(message) {
  console.error(`backup_to_s3_error: ${message}`);
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

  const endpoint = requiredEnv("OPENCLAW_BACKUP_S3_ENDPOINT");
  const bucket = requiredEnv("OPENCLAW_BACKUP_S3_BUCKET");
  const region = requiredEnv("OPENCLAW_BACKUP_S3_REGION") ?? "auto";
  const accessKeyId = requiredEnv("OPENCLAW_BACKUP_S3_ACCESS_KEY_ID");
  const secretAccessKey = requiredEnv("OPENCLAW_BACKUP_S3_SECRET_ACCESS_KEY");
  const rawPrefix = requiredEnv("OPENCLAW_BACKUP_S3_PREFIX") ?? "openclaw";
  const prefix = rawPrefix.replace(/^\/+|\/+$/g, "");

  return {
    endpoint,
    bucket,
    region,
    accessKeyId,
    secretAccessKey,
    prefix,
  };
}

async function loadS3Client() {
  try {
    return await import("@aws-sdk/client-s3");
  } catch {
    fail("Missing dependency @aws-sdk/client-s3. Install with: pnpm add -w @aws-sdk/client-s3");
  }
}

function createArchive(archivePath) {
  const create = spawnSync(
    "tar",
    ["-czf", archivePath, "-C", "/", "data/.openclaw", "data/workspace"],
    { stdio: "inherit" },
  );
  if (create.status !== 0) {
    fail("tar create failed");
  }
}

function validateArchive(archivePath) {
  let listing = "";
  try {
    listing = execFileSync("tar", ["-tzf", archivePath], {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch {
    fail("tar validation failed");
  }
  const preview = listing.split("\n").filter(Boolean).slice(0, 40);
  console.log("archive_preview:");
  for (const line of preview) {
    console.log(`  ${line}`);
  }
}

async function main() {
  const cfg = readConfig();
  const stamp = formatStamp();
  const archivePath = `/tmp/openclaw-backup-${stamp}.tar.gz`;
  const fileName = archivePath.split("/").pop();
  const key = cfg.prefix ? `${cfg.prefix}/${fileName}` : fileName;

  console.log(`creating_archive: ${archivePath}`);
  createArchive(archivePath);
  validateArchive(archivePath);

  const size = statSync(archivePath).size;
  const { S3Client, PutObjectCommand } = await loadS3Client();
  const client = new S3Client({
    region: cfg.region,
    endpoint: cfg.endpoint,
    forcePathStyle: true,
    credentials: {
      accessKeyId: cfg.accessKeyId,
      secretAccessKey: cfg.secretAccessKey,
    },
  });

  await client.send(
    new PutObjectCommand({
      Bucket: cfg.bucket,
      Key: key,
      Body: createReadStream(archivePath),
      ContentType: "application/gzip",
    }),
  );

  console.log(`backup_to_s3_ok: bucket=${cfg.bucket} key=${key} sizeBytes=${size}`);
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});
