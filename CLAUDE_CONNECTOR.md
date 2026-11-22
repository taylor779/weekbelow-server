# BSMNT · AI connector (Claude and Grok)

Lets Claude or Grok read the studio's data and set up and update BSMNT directly: create a project,
write the shot list, run sheet and storyboard, pull storyboard frames out of a PDF, and add or edit
tasks, time, clients and client requests. Nothing can be deleted through it. No screen control.
The assistant acts as the signed-in member and sees what they see (rates and business costs: admins only).

Code: `mcp-connector.js` (MCP endpoint, OAuth, tools) and `mcp-pdf-frames.js` (PDF frames).
Security model: `SECURITY_NOTES.md` → "Claude connector".

## Setup (once)

1. **Railway → weekbelow-server → Variables**
   - `MCP_OAUTH_SECRET` = output of `openssl rand -hex 32`
   - `SUPABASE_ANON_KEY` = the public anon key (same as `SUPABASE_KEY` in the web app)
   - `PUBLIC_URL` = `https://weekbelow-server-production.up.railway.app`
2. **Deploy** (package.json now includes `pdf-lib`). Boot log should say
   `[mcp] connector on at https://…/mcp`.
3. **Supabase → Authentication → URL Configuration → Redirect URLs**: add
   `https://weekbelow-server-production.up.railway.app/oauth/authorize**`
   (needed for "Continue with Google" on the sign-in page; email/password works without it).
4. **Claude → Settings → Connectors → Add custom connector**
   - Name: `BSMNT`
   - URL: `https://weekbelow-server-production.up.railway.app/mcp`
   - Connect, sign in with your BSMNT account.
5. In the connector's settings, set the tools you're happy with to **Always allow** so Claude
   doesn't ask before each one.
6. **Grok → grok.com/connectors → New Connector → Custom**
   - URL: `https://weekbelow-server-production.up.railway.app/mcp`
   - Connect, sign in with your BSMNT account.
   - Grok's sign-in callback is allowed automatically (any https URL on grok.com / x.ai). If xAI ever
     uses another domain, registration fails with "Redirect URI not allowed: <uri>": add that URI to
     `MCP_REDIRECT_URIS` in Railway.

## Tools

| Tool | What it does |
|---|---|
| `bsmnt_list_studios` | Studios you belong to |
| `bsmnt_list_clients` | Clients (to reuse one) |
| `bsmnt_list_projects` | Projects with status and dates |
| `bsmnt_get_project` | One project in full: shot list, run sheet, storyboard text |
| `bsmnt_create_project` | New project (matches or creates the client) |
| `bsmnt_update_project` | Change fields (dates, status, budgets, brief…) |
| `bsmnt_set_shot_list` | Shot list with real scene dividers |
| `bsmnt_set_runsheet` | Location, notes, crew, timeline |
| `bsmnt_set_storyboard` | Storyboard panels (upload mode), optional send to run sheet |
| `bsmnt_create_upload_link` | One-time link to send a PDF |
| `bsmnt_import_storyboard_images` | Pull frames from that PDF (or a project document) into the panels |
| `bsmnt_read_studio_data` | Any section: tasks, clients, team, crew, retainers, business costs, templates, activity, whiteboard, quotes, equipment, prospects, contractors, decks, work/data library, client briefs and messages, every flight ops table |
| `bsmnt_get_time_logs` | Time entries with totals by person and project (own time only without reports permission) |
| `bsmnt_add_task` / `bsmnt_update_task` | Project stage tasks or loose studio tasks: add, tick, rename, reassign, due date |
| `bsmnt_log_time` | Time entry on a project (for someone else: admins only) |
| `bsmnt_save_client` | Create or update a client |
| `bsmnt_add_client_request` / `bsmnt_set_client_request_done` | Client requests on a project |
| `bsmnt_get_priorities` | The Priority Board (shoot and edit running order, as on the wall screen): projects and standalone tasks, ranked |
| `bsmnt_set_priorities` | Reorder one board (full order, most important first), with optional notes. `bsmnt_add_task` with `priority_board` puts a new standalone task on it |
| `bsmnt_set_priority_note` | The short note shown on a project or task on the board |

## Typical use

Attach the runsheet and storyboard PDFs in Claude and say: "Set this up in BSMNT. Budget
$7k + GST, $4k shoot, $3k edit." Claude reads the PDFs, creates the project, fills in the
three tabs, then gives you an upload link for the storyboard PDF (or uploads it itself when it
has a shell) and attaches the frames.

## Testing locally

`node --check mcp-connector.js mcp-pdf-frames.js server.js`. The end-to-end test used for the
first version (fake Supabase + full OAuth and tool flow, 56 checks) and the Grok / studio-data one
(37 checks: Grok redirects, rate gating, time tombstones, tasks, time, clients, requests) aren't in
the repo; ask Claude to rerun them after changes.
