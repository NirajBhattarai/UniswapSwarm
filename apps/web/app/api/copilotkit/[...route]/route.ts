/**
 * Catch-all CopilotKit endpoint that re-uses the same handler as
 * `/api/copilotkit/route.ts`. Some CopilotKit clients post to subpaths
 * (e.g. `/api/copilotkit/<endpoint>/info`) so we keep this route as a
 * pass-through to avoid 404s.
 */

import { GET as RootGet, POST as RootPost } from "../route";

export const GET = RootGet;
export const POST = RootPost;
