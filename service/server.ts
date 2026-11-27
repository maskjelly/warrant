import { serve } from "@hono/node-server";
import app from "./app";

const port = Number(process.env.PORT ?? 4022);
serve({ fetch: app.fetch, port });
console.log(`Agent check listening on http://localhost:${port}`);
