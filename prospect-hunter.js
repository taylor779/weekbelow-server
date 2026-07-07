// ═══════════════════════════════════════════════════════════════════════════
// BSMNT · prospect-hunter.js (v8938)
// Overnight, fully hands-off prospect hunting. Runs on Railway alongside
// server.js. For each agency with "Overnight server hunts" enabled in the
// app (brand._prospectMeta.settings.serverHunt), on the agency's cadence it:
//   1. discovers real NZ SME/agency companies across the agency's chosen
//      sectors (Claude + web_search), excluding known/dismissed companies
//   2. researches each one (contacts w/ email confidence, Instagram,
//      trigger event, video presence, suggested opening hook)
//   3. writes each result into the prospect_staging table
// The app ingests staging rows next time anyone opens BSMNT → Review inbox.
//
// THE SERVER NEVER WRITES TO app_state. Reading brand (settings/exclusions)
// is safe; writing would race the client's whole-column brand saves.
//
// WIRE-UP · add ONE line near the bottom of server.js:
//     require('./prospect-hunter').start();
// Uses the same env vars the rest of the server uses:
//     SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
// (If your service key env var has a different name, pass it in:
//     require('./prospect-hunter').start({ serviceRoleKey: process.env.YOUR_VAR });)
// Node 18+ (global fetch). Requires @supabase/supabase-js (already a dep).
// ═══════════════════════════════════════════════════════════════════════════

const { createClient } = require('@supabase/supabase-js');

const CHECK_EVERY_MS = 30 * 60 * 1000;      // look for due hunts every 30 min
const RESEARCH_GAP_MS = 2500;               // politeness gap between research calls
const MODEL = 'claude-sonnet-4-6';

const SECTOR_NAMES = {
  automotive: 'Automotive & EV', agency: 'Creative agencies', tourism: 'Tourism & Hospitality',
  food: 'Food & Beverage', tech: 'Tech & SaaS', retail: 'Retail & Fashion',
  property: 'Property & Architecture', corporate: 'Corporate & EVP', gov: 'Government & Public',
  sport: 'Sport & Fitness', events: 'Events & Live', nonprofit: 'Purpose & NGO'
};

function start(opts) {
  opts = opts || {};
  const url = opts.supabaseUrl || process.env.SUPABASE_URL;
  const key = opts.serviceRoleKey || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) { console.error('[hunter] missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY \u00b7 hunter disabled'); return; }
  const db = createClient(url, key, { auth: { persistSession: false } });
  console.log('[hunter] prospect hunter armed \u00b7 checking every ' + (CHECK_EVERY_MS / 60000) + ' min');
  setTimeout(function () { tick(db).catch(function (e) { console.error('[hunter] tick:', e.message); }); }, 60 * 1000);
  setInterval(function () { tick(db).catch(function (e) { console.error('[hunter] tick:', e.message); }); }, CHECK_EVERY_MS);
}

async function tick(db) {
  const { data: rows, error } = await db.from('app_state').select('agency_id, brand');
  if (error) { console.error('[hunter] app_state read failed:', error.message); return; }
  for (const row of (rows || [])) {
    if (!row || !row.agency_id) continue;
    try { await maybeHunt(db, row); }
    catch (e) { console.error('[hunter] ' + row.agency_id + ':', e.message); }
  }
}

async function maybeHunt(db, row) {
  const brand = row.brand || {};
  const meta = brand._prospectMeta;
  if (!meta || !meta.settings || !meta.settings.serverHunt) return;
  const s = meta.settings;
  const cadMs = (Number(s.cadenceDays) || 7) * 86400000;

  // Cadence: respect BOTH the last server run (run-marker rows) and the last
  // client-side hunt (meta.lastRun) so the two never double up.
  const { data: runs } = await db.from('prospect_staging')
    .select('created_at').eq('agency_id', row.agency_id).eq('kind', 'run')
    .order('created_at', { ascending: false }).limit(1);
  const lastServer = runs && runs[0] ? new Date(runs[0].created_at).getTime() : 0;
  const lastClient = Number(meta.lastRun) || 0;
  if (Date.now() - Math.max(lastServer, lastClient) < cadMs) return;

  const { data: ks } = await db.from('agency_settings')
    .select('anthropic_key').eq('agency_id', row.agency_id).limit(1);
  const apiKey = ks && ks[0] && ks[0].anthropic_key;
  if (!apiKey) { console.log('[hunter] ' + row.agency_id + ' \u00b7 no anthropic key, skipped'); return; }

  // Claim the run FIRST so a crash mid-hunt cannot retry-loop and burn tokens.
  const claim = await db.from('prospect_staging')
    .insert({ agency_id: row.agency_id, kind: 'run', payload: { startedAt: Date.now() }, consumed: true })
    .select('id');
  const claimId = claim && claim.data && claim.data[0] && claim.data[0].id;

  const sectorIds = (s.sectors && s.sectors.length) ? s.sectors : ['automotive', 'agency', 'tourism'];
  const count = Math.min(12, Math.max(3, Number(s.count) || 8));

  // Exclusions: current prospects + dismissed + anything already staged & unconsumed.
  const excl = {};
  (Array.isArray(brand._prospects) ? brand._prospects : []).forEach(function (p) {
    if (p && p.company) excl[String(p.company).toLowerCase()] = 1;
  });
  (meta.dismissed || []).forEach(function (d) {
    const n = (d && d.company) || d; if (n) excl[String(n).toLowerCase()] = 1;
  });
  const { data: staged } = await db.from('prospect_staging')
    .select('payload').eq('agency_id', row.agency_id).eq('kind', 'prospect').eq('consumed', false).limit(200);
  (staged || []).forEach(function (r2) {
    const n = r2 && r2.payload && r2.payload.company; if (n) excl[String(n).toLowerCase()] = 1;
  });
  const exclList = Object.keys(excl).slice(0, 150);

  console.log('[hunter] ' + row.agency_id + ' \u00b7 hunting ' + count + ' across [' + sectorIds.join(',') + ']');

  const secBlock = sectorIds.map(function (id) { return '- ' + id + ': ' + (SECTOR_NAMES[id] || id); }).join('\n');
  const discoverPrompt = 'Search the web and find ' + count + ' real small-to-medium New Zealand businesses that would be good NEW prospects for a video production studio.\n\n'
    + 'Spread them across these sectors:\n' + secBlock + '\n'
    + 'Region: ' + (s.region || 'anywhere in New Zealand') + '\n'
    + 'Good fit: SME or independent agency scale (not giant corporates), an active brand/marketing presence, plausibly buys video content.\n'
    + (exclList.length ? ('\nEXCLUDE these companies (already known/contacted/clients \u00b7 do not return any of them or obvious subsidiaries):\n' + exclList.join(', ') + '\n') : '')
    + '\nRespond with ONLY a JSON array \u00b7 no markdown fences, no commentary:\n'
    + '[{"company":string,"sector":"one of: ' + sectorIds.join(' | ') + '","website":string or null,"location":string or null,"whyFit":"one specific sentence","sizeHint":string or null}]\n\n'
    + 'Rules: real, currently-operating companies only \u00b7 never invent a company \u00b7 null for anything unverified.';

  let list;
  try { list = extractJson(await callClaude(apiKey, discoverPrompt, true, 2600)); }
  catch (e) { console.error('[hunter] discover failed:', e.message); await finishRun(db, claimId, 0, 'discover failed: ' + e.message); return; }
  if (!Array.isArray(list)) { await finishRun(db, claimId, 0, 'bad shape'); return; }
  list = list.filter(function (c) { return c && c.company && !excl[String(c.company).toLowerCase()]; });

  let added = 0;
  for (const c of list) {
    let research = null;
    try { research = extractJson(await callClaude(apiKey, researchPrompt(c.company, c.website), true, 2200)); }
    catch (e) { console.error('[hunter] research ' + c.company + ':', e.message); }
    const payload = {
      company: c.company,
      sector: sectorIds.indexOf(c.sector) !== -1 ? c.sector : sectorIds[0],
      website: c.website || null, location: c.location || null,
      whyFit: c.whyFit || '', sizeHint: c.sizeHint || null,
      research: research || null
    };
    const ins = await db.from('prospect_staging').insert({ agency_id: row.agency_id, kind: 'prospect', payload: payload });
    if (ins.error) console.error('[hunter] insert ' + c.company + ':', ins.error.message); else added++;
    await sleep(RESEARCH_GAP_MS);
  }
  await finishRun(db, claimId, added, null);
  console.log('[hunter] ' + row.agency_id + ' \u00b7 done \u00b7 ' + added + ' staged');
}

function researchPrompt(company, website) {
  return 'You are a B2B prospecting researcher for a video production studio. Search the web thoroughly for this New Zealand company: "' + company + '"' + (website ? (' (website: ' + website + ')') : '') + '.\n\n'
    + 'GOAL: find the best PUBLISHED way to contact a decision-maker about video work \u00b7 a marketing/brand/content lead, owner, or GM \u00b7 plus their Instagram.\n\n'
    + 'SEARCH THESE SOURCES before answering (run multiple searches):\n'
    + '1. The company website \u00b7 especially the Contact, About, Team/People and Careers pages, and the page footer.\n'
    + '2. Their Instagram profile (bio often lists a contact email and a website link).\n'
    + '3. LinkedIn \u00b7 the company page and named staff in marketing/brand/content/owner/GM roles.\n'
    + '4. The NZ Companies Office register (app.companiesoffice.govt.nz) for directors and the registered address.\n'
    + '5. Industry directories, press releases and news articles that name people or list contacts.\n\n'
    + 'Respond with ONLY a JSON object \u00b7 no markdown fences, no commentary:\n'
    + '{"website":string or null,"instagram":string or null (full https URL to their profile),"instagramHandle":string or null (e.g. @brand),"generalEmail":string or null (e.g. a published info@/hello@ address),"location":string or null,"summary":"1-2 sentence company summary","videoPresence":"one short phrase on how strong their current video/social content looks \u00b7 flags an opportunity","trigger":string or null (recent launch, rebrand, funding or news worth referencing in outreach),"suggestedHook":"one specific opening line for outreach that references something real about them (their trigger, their work, their video gap) \u00b7 no greeting, no flattery filler","contacts":[{"name":string or null,"role":string or null,"email":string or null,"emailConfidence":"high | medium | low | null","source":"the exact page/URL where this was published","linkedin":string or null}]}\n\n'
    + 'RULES ON EMAIL \u00b7 read carefully:\n'
    + '- PRIORITY TARGET: the marketing / brand / content person\u2019s OWN email address is the top prize \u00b7 it is worth far more than a generic info@ inbox. Actively hunt for it: search "<their name> <company> email", check their LinkedIn contact-info section, staff directory pages, press releases (the listed media contact is usually the marketing lead), conference speaker bios, and article bylines.\n'
    + '- Only return an email you actually SAW published on a real page. Set "source" to that page.\n'
    + '- NEVER guess, construct, pattern-infer or assume an address (no firstname@domain guessing). A guessed email that bounces damages the sender\u2019s reputation \u2014 an honest null is always better.\n'
    + '- emailConfidence: "high" = the named person\u2019s own published address; "medium" = a role/team address (marketing@, studio@); "low" = a generic catch-all or one you are unsure about; null = no email found.\n'
    + '- Prefer a real named decision-maker over a generic inbox. Return up to 4 contacts ordered: marketing/brand/content roles first, then owners/GMs, then others. A contact with a name but no email is still useful \u2014 include it.\n'
    + '- If nothing is published, return empty/null. Do not fabricate to seem helpful.';
}

async function callClaude(apiKey, prompt, useSearch, maxTokens) {
  const body = { model: MODEL, max_tokens: maxTokens || 1200, messages: [{ role: 'user', content: prompt }] };
  if (useSearch) body.tools = [{ type: 'web_search_20250305', name: 'web_search' }];
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(body)
  });
  if (!resp.ok) { let t = ''; try { t = await resp.text(); } catch (e) {} throw new Error('Claude API ' + resp.status + (t ? (' ' + t.slice(0, 200)) : '')); }
  const data = await resp.json();
  return (data.content || []).filter(function (c) { return c.type === 'text'; }).map(function (c) { return c.text; }).join('\n').trim();
}

function extractJson(text) {
  const clean = String(text || '').replace(/```json/gi, '').replace(/```/g, '').trim();
  const s = clean.search(/[\[{]/);
  if (s < 0) throw new Error('no JSON in response');
  const close = clean[s] === '[' ? ']' : '}';
  const e = clean.lastIndexOf(close);
  if (e <= s) throw new Error('malformed JSON');
  return JSON.parse(clean.slice(s, e + 1));
}

async function finishRun(db, claimId, added, err) {
  if (!claimId) return;
  try { await db.from('prospect_staging').update({ payload: { finishedAt: Date.now(), added: added, error: err || null } }).eq('id', claimId); } catch (e) {}
}

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

module.exports = { start: start };
