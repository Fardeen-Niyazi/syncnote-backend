// Line 1: Load environment variables from the .env file into process.env.
import "dotenv/config";
// Line 2: Import the Postgres connection-pool class.
import { Pool } from "pg";

// Line 3-5: Fail fast with a clear message if DATABASE_URL is missing,
// so a misconfigured Render/+.env+ shows up immediately instead of timing out.
if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is missing from .env");
}

// Line 6-11: Create ONE shared pool for the whole server.
// - connectionString: points at Neon (pooled URL works best on Render free tier).
// - ssl: Neon requires SSL; rejectUnauthorized:false lets Node accept its cert.
// - max: 5 caps concurrent connections so we never exhaust Neon's limit.
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 5,
});

// Line 12-14: A pool can emit errors on idle clients (e.g. Neon restarts).
// Without this listener Node would crash; here we just log it.
pool.on("error", (error) => {
  console.error("Unexpected PostgreSQL pool error:", error.message);
});
