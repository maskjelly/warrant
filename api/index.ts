// Vercel entry point for the paid agent check.
import app from "../service/app.js";

export const GET = (request: Request) => app.fetch(request);
export const HEAD = GET;
