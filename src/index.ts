interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * WORDING IS LOAD-BEARING, same rule as labelAge's note in authority.ts. This
 * string is appended to a pack's thrown Error message (shared/src/http.ts),
 * and a thrown Error's message is exactly what the gateway hands back to the
 * caller as `content[0].text` when nothing rewrites it (workers/gateway/src
 * catches the throw and sets `rawResult.message = stripClassPrefix(error)`,
 * which does not touch this suffix) — so the original wording,
 * " [pipeworx-hosted origin — our own service, not a third party]", was not a
 * theoretical leak: it shipped live on pipeworx-catalog's 522s, 7 times in 6
 * hours on 2026-09-02 (see tests/golden-internal-service.test.ts), verbatim
 * naming Pipeworx as the host. check:hosting-claims never caught it because it
 * did not scan shared/ at all (task #2009). Reworded to describe the
 * OBSERVATION (the origin did not answer) without a claim about who runs it —
 * the identical fix labelAge got: drop the possessive, keep the fact.
 */
const INTERNAL_ORIGIN_MARKER = ' [origin did not respond — retry before concluding the named source is down]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * `workers/gateway/src/provenance.ts`'s `OUR_HOSTS` answers the same
 * question and DOES include `workers.dev` — a documented divergence
 * (task #2051), not a bug to converge. That list decides what a response may
 * cite as a data SOURCE, where a false negative (citing our own worker as an
 * external source) is the hosting-disclosure leak this whole file exists to
 * prevent, so it errs broad. This one decides who gets BLAMED for a 5xx in
 * outage metrics read by on-call, where a false positive (crediting our own
 * infra with a third party's outage) hides the real failure, so it errs
 * narrow. Same suffix, opposite direction, because they are never called for
 * the same reason.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}


/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}`,
    res.url,
    res.status,
  );
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    throw err;
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}
/**
 * Georgia (country) electricity system — live grid telemetry and regulator statistics.
 *
 * Two publishers, both keyless, both read live on every call:
 *
 *  - JSC Georgian State Electrosystem (GSE), the transmission system operator:
 *    a real-time system export refreshed every 3 minutes, system frequency
 *    every minute, the day-ahead consumption forecast, and the corporate CMS
 *    (publications, tenders).
 *  - Georgian National Energy and Water Supply Regulatory Commission (GNERC):
 *    the open-data spreadsheets at data.gnerc.org — per-power-station monthly
 *    generation 2015-2026, and the three monthly price series.
 *
 * THREE THINGS THAT PRODUCE A CONFIDENT WRONG ANSWER RATHER THAN AN ERROR.
 * Each one is handled below; each one is worth knowing if you change this file.
 *
 * 1. GSE's real-time filenames carry TBILISI LOCAL TIME (UTC+4, no DST), with
 *    the minute floored to a multiple of 3, and publication lags a couple of
 *    minutes. Asking for the current minute is a silent 404, not an error. So
 *    "now" has to mean "the most recent slot that actually exists", proven
 *    before it is fetched.
 * 2. Every telemetered value carries a QUALITY attribute: ACT (actual
 *    telemetry), SUB (substituted) and NRE (not received). Real payloads mix
 *    all three within one file — national consumption is routinely NRE while
 *    the hydro total is SUB. Returning those bare would publish a fill-in as a
 *    measurement, so QUALITY travels with every single row and is summarised
 *    at the top of the response.
 * 3. The XML declares ISO-8859-1, ships an xml-stylesheet PI and a DOCTYPE
 *    pointing at a DTD, and space-pads BLOCK_AREA/@Name to a fixed width.
 *
 * A fourth lives in ./xlsx.ts, in the worksheet cell regex — read the note
 * there before touching it.
 */

import { parseXlsx, parseXls, type Sheet } from './xlsx.js';

const UA = 'pipeworx-mcp-georgia-energy/1.0 (+https://pipeworx.io)';

const GSE_API = 'https://admin.gse.com.ge/api';
const GSE_FACT = 'https://admin.gse.com.ge/storage/uploads/fact';
const GSE_FORECAST = 'https://admin.gse.com.ge/storage/uploads/consumption_files/excel';
const GNERC_EXCEL = 'https://data.gnerc.org/excel';

async function pwFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  const headers = { 'User-Agent': UA, ...(init?.headers ?? {}) };
  return fetchWithTimeout(url, { ...init, headers }, 'Georgian State Electrosystem');
}

async function gnercFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  const headers = { 'User-Agent': UA, ...(init?.headers ?? {}) };
  return fetchWithTimeout(url, { ...init, headers }, 'GNERC open data');
}

// ── Tbilisi clock ──────────────────────────────────────────────────────────
// Georgia has been on UTC+4 with no daylight saving since 2005, but the offset
// is read from the runtime rather than hardcoded so a future rule change shows
// up as a corrected slot instead of a silent 404 loop.

type Wall = { year: number; month: number; day: number; hour: number; minute: number };

const TBILISI = 'Asia/Tbilisi';

const partsFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: TBILISI,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

function toTbilisiWall(d: Date): Wall {
  const p: Record<string, string> = {};
  for (const part of partsFmt.formatToParts(d)) if (part.type !== 'literal') p[part.type] = part.value;
  return {
    year: Number(p.year),
    month: Number(p.month),
    day: Number(p.day),
    hour: Number(p.hour === '24' ? '00' : p.hour),
    minute: Number(p.minute),
  };
}

/** The UTC instant corresponding to a Tbilisi wall-clock reading. */
function tbilisiWallToUtc(w: Wall): Date {
  const guess = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, 0);
  // One correction pass is enough for a fixed-offset zone.
  const back = toTbilisiWall(new Date(guess));
  const drift =
    Date.UTC(back.year, back.month - 1, back.day, back.hour, back.minute, 0) -
    Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, 0);
  return new Date(guess - drift);
}

function pad(n: number, w = 2): string {
  return String(n).padStart(w, '0');
}

function slotStamp(w: Wall): string {
  return `${pad(w.day)}${pad(w.month)}${w.year}_${pad(w.hour)}${pad(w.minute)}`;
}

function wallLabel(w: Wall): string {
  return `${pad(w.day)}.${pad(w.month)}.${w.year} ${pad(w.hour)}:${pad(w.minute)}`;
}

function shiftWall(w: Wall, minutes: number): Wall {
  return toTbilisiWall(new Date(tbilisiWallToUtc(w).getTime() + minutes * 60_000));
}

// ── GSE real-time XML ──────────────────────────────────────────────────────

const QUALITY_MEANING: Record<string, string> = {
  ACT: 'actual telemetry',
  SUB: 'substituted by the operator (not measured)',
  NRE: 'not received from telemetry (not measured)',
};

type Series = {
  block: string;
  b1: string;
  b2: string | null;
  b3: string | null;
  element: string;
  interval: string;
  value: number;
  unit: string;
  quality: string;
  quality_meaning: string;
  measured: boolean;
};

/** Strip the declaration, the stylesheet PI and the DOCTYPE (trap 3). */
function stripXmlPreamble(xml: string): string {
  return xml
    .replace(/<\?xml[^?]*\?>/g, '')
    .replace(/<\?xml-stylesheet[^?]*\?>/g, '')
    .replace(/<!DOCTYPE[^>]*>/g, '')
    .trim();
}

function attr(source: string, name: string): string | null {
  const m = new RegExp(`${name}='([^']*)'`).exec(source) ?? new RegExp(`${name}="([^"]*)"`).exec(source);
  if (!m) return null;
  const v = m[1].trim();
  return v === '' ? null : v;
}

function parseGseExport(xml: string, unit: string): { exportTime: string | null; period: string | null; series: Series[] } {
  const body = stripXmlPreamble(xml);
  const exportTag = /<Export\b([^>]*)\/>/.exec(body)?.[1] ?? '';
  const series: Series[] = [];
  for (const bm of body.matchAll(/<BLOCK_AREA\b([^>]*)>([\s\S]*?)<\/BLOCK_AREA>/g)) {
    const block = (attr(bm[1], 'Name') ?? '').trim(); // trap 3: fixed-width padding
    for (const tm of bm[2].matchAll(/<TA\b([^>]*)\/>/g)) {
      const a = tm[1];
      const rawValue = attr(a, 'VALUE');
      if (rawValue === null) continue;
      const value = Number(rawValue);
      const quality = (attr(a, 'QUALITY') ?? 'UNKNOWN').toUpperCase();
      series.push({
        block,
        b1: attr(a, 'B1') ?? '',
        b2: attr(a, 'B2'),
        b3: attr(a, 'B3'),
        element: attr(a, 'EL') ?? '',
        interval: attr(a, 'IN') ?? '',
        value: Number.isFinite(value) ? value : 0,
        unit,
        quality,
        quality_meaning: QUALITY_MEANING[quality] ?? 'unrecognised quality flag',
        measured: quality === 'ACT',
      });
    }
  }
  return { exportTime: attr(exportTag, 'Time'), period: attr(exportTag, 'Period'), series };
}

function factUrl(kind: '03M' | '01M', stamp: string): string {
  const file = kind === '03M' ? `GSE_EXPORT_NEW_PERIOD_03M_${stamp}.XML` : `GSE_EXPORT_PERIOD_01M_${stamp}.XML`;
  return `${GSE_FACT}/${file}`;
}

/** GSE's own existence probe. Returns the publisher's answer, not a guess. */
async function slotExists(url: string): Promise<boolean> {
  const probe = `${GSE_API}/file-exists?path=${encodeURIComponent(url)}`;
  const res = await pwFetch(probe, { headers: { Accept: 'application/json' } });
  if (!res.ok) return false;
  const json = (await res.json()) as { exists?: boolean };
  return json.exists === true;
}

/**
 * Walk backwards from the current Tbilisi minute to the most recent slot GSE
 * has actually published (trap 1).
 *
 * Probed in concurrent batches rather than one slot at a time. The observed lag
 * is not the ~2 minutes the sample suggested — the 1-minute frequency feed has
 * been seen 9-10 slots behind — and ten sequential round trips to Tbilisi cost
 * ~4s of the caller's answer budget for a tool that is meant to say "now".
 * Within a batch the EARLIEST index that exists still wins, so the answer is
 * the same one a sequential walk would have given.
 */
const PROBE_BATCH = 5;

async function findLatestSlot(
  kind: '03M' | '01M',
  maxLookback: number,
): Promise<{ wall: Wall; url: string; slots_checked: number }> {
  const step = kind === '03M' ? 3 : 1;
  let wall = toTbilisiWall(new Date());
  if (kind === '03M') wall = { ...wall, minute: wall.minute - (wall.minute % 3) };

  for (let base = 0; base < maxLookback; base += PROBE_BATCH) {
    const batch = [];
    for (let i = base; i < Math.min(base + PROBE_BATCH, maxLookback); i++) {
      const candidate = i === 0 ? wall : shiftWall(wall, -i * step);
      batch.push({ index: i, wall: candidate, url: factUrl(kind, slotStamp(candidate)) });
    }
    const found = await Promise.all(batch.map((c) => slotExists(c.url)));
    for (let k = 0; k < batch.length; k++) {
      if (found[k]) return { wall: batch[k].wall, url: batch[k].url, slots_checked: batch[k].index + 1 };
    }
  }
  throw new Error(
    `No GSE ${kind} export published in the last ${maxLookback * step} minutes (checked ${maxLookback} slots back from ` +
      `${wallLabel(wall)} Tbilisi time). GSE publishes with a lag that has been observed between 2 and 10 minutes; ` +
      `raise max_lookback_slots or retry shortly.`,
  );
}

async function fetchExport(url: string, unit: string) {
  const res = await pwFetch(url, { headers: { Accept: 'application/xml,text/xml,*/*' } });
  if (!res.ok) throw new Error(`GSE export ${res.status} for ${url}`);
  // The declaration says ISO-8859-1 and the content is ASCII, so decoding as
  // Latin-1 is both correct and lossless here (trap 3).
  const xml = new TextDecoder('iso-8859-1').decode(await res.arrayBuffer());
  return parseGseExport(xml, unit);
}

function qualitySummary(series: Series[]) {
  const counts: Record<string, number> = {};
  for (const s of series) counts[s.quality] = (counts[s.quality] ?? 0) + 1;
  const measured = series.filter((s) => s.measured).length;
  return {
    counts,
    measured_values: measured,
    unmeasured_values: series.length - measured,
    note:
      series.length === measured
        ? 'Every value in this export is ACT (actual telemetry).'
        : 'Values flagged SUB or NRE were NOT measured — SUB was substituted by the operator and NRE was not received from telemetry. Do not report them as measurements.',
  };
}

function shapeGrid(url: string, wall: Wall, parsed: { exportTime: string | null; period: string | null; series: Series[] }, extra: Record<string, unknown> = {}) {
  const blocks: Array<{ block: string; values: Series[] }> = [];
  for (const s of parsed.series) {
    let b = blocks.find((x) => x.block === s.block);
    if (!b) {
      b = { block: s.block, values: [] };
      blocks.push(b);
    }
    b.values.push(s);
  }
  return {
    export_time_tbilisi: parsed.exportTime ?? wallLabel(wall),
    export_time_utc: tbilisiWallToUtc(wall).toISOString(),
    timezone: 'Asia/Tbilisi (UTC+4) — GSE names these files in local time, not UTC',
    period: parsed.period,
    unit: 'MW (3-minute moving average)',
    source_url: url,
    source: 'JSC Georgian State Electrosystem (GSE) real-time system export',
    quality: qualitySummary(parsed.series),
    blocks,
    value_count: parsed.series.length,
    ...extra,
  };
}

// ── Spreadsheet cache ──────────────────────────────────────────────────────
// The GNERC balance workbook is ~450 KB. One fetch + parse serves many calls
// within an isolate's lifetime rather than a download per call.

const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const bookCache = new Map<string, { at: number; book: Awaited<ReturnType<typeof parseXlsx>> }>();

async function loadWorkbook(url: string): Promise<Awaited<ReturnType<typeof parseXlsx>>> {
  const hit = bookCache.get(url);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.book;
  const res = await gnercFetch(url, { headers: { Accept: '*/*' } });
  if (!res.ok) throw new Error(`GNERC workbook ${res.status} for ${url}`);
  const book = await parseXlsx(new Uint8Array(await res.arrayBuffer()));
  bookCache.set(url, { at: Date.now(), book });
  return book;
}

const GNERC_BOOKS = {
  balance: '2015 - 2026 ფაქტიური ბალანსი.xlsx',
  // Note the DOUBLE space before 2015 — it is in the published filename.
  capacity_fee: 'გარანტირებული სიმძლავრის საფასური  2015 - 2026 წლები.xlsx',
  balancing: 'საბალანსო ელექტროენერგიის ფასები 2015 - 2026 წლები.xlsx',
  deregulated: 'დერეგულირებული სადგურების ფასები 2015 - 2026 წლები.xlsx',
} as const;

function gnercUrl(key: keyof typeof GNERC_BOOKS): string {
  return `${GNERC_EXCEL}/${encodeURIComponent(GNERC_BOOKS[key])}`;
}

const MONTHS_KA = [
  'იანვარი',
  'თებერვალი',
  'მარტი',
  'აპრილი',
  'მაისი',
  'ივნისი',
  'ივლისი',
  'აგვისტო',
  'სექტემბერი',
  'ოქტომბერი',
  'ნოემბერი',
  'დეკემბერი',
];
const MONTHS_EN = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/** Columns C..N are Jan..Dec on the balance sheets; O is the year total. */
const MONTH_COLUMNS = ['C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N'];

function cellNumber(v: string | number | undefined): number | null {
  if (v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  // GNERC's price sheets carry text cells padded with non-breaking spaces.
  const cleaned = v.replace(/[ \s]/g, '').replace(',', '.');
  if (cleaned === '') return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function cellText(v: string | number | undefined): string {
  if (v === undefined) return '';
  return String(v).replace(/[ ]/g, ' ').trim();
}

function findSheet(sheets: Sheet[], predicate: (name: string) => boolean, what: string): Sheet {
  const s = sheets.find((x) => predicate(x.name));
  if (!s) throw new Error(`${what} — available sheets: ${sheets.map((x) => x.name).join(', ')}`);
  return s;
}

// ── Tools ──────────────────────────────────────────────────────────────────

const tools: McpToolExport['tools'] = [
  {
    name: 'gse_grid_now',
    description:
      "Georgia's national electricity grid right now: hydro, thermal, wind and solar generation, total generation, cross-border flow on the Azerbaijan, Armenia, Russia (Salkhino/Java/Nakaduli lines) and Turkey tie lines, and total consumption — in MW as a 3-minute moving average. Sourced from the JSC Georgian State Electrosystem real-time system export, published every 3 minutes. Every value carries its QUALITY flag: ACT means actual telemetry, SUB means the operator substituted a figure and NRE means telemetry was not received, so SUB and NRE values are NOT measurements and must not be reported as such.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        max_lookback_slots: {
          type: 'integer',
          description:
            'How many 3-minute slots to walk back looking for the most recent published export. Publication lags a few minutes, so the current minute usually does not exist yet. Default 10 (30 minutes).',
          minimum: 1,
          maximum: 40,
        },
      },
    },
  },
  {
    name: 'gse_grid_at',
    description:
      "Georgia's national grid state at a specific past time — the same generation, tie-line and consumption blocks as gse_grid_now, with the same QUALITY flags, for one 3-minute slot. Sourced from the JSC Georgian State Electrosystem real-time export, which is retained for a rolling ~30 days; earlier timestamps are gone. Timestamps are Tbilisi local time (UTC+4) unless timezone is set to utc. If that exact slot was never published this reports the miss rather than substituting a nearby one.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        timestamp: {
          type: 'string',
          description:
            "The moment to read, as 'YYYY-MM-DD HH:MM' or 'YYYY-MM-DDTHH:MM' or 'DD.MM.YYYY HH:MM'. Minutes are floored to the 3-minute grid GSE publishes on.",
        },
        timezone: {
          type: 'string',
          enum: ['tbilisi', 'utc'],
          description: "How to read the timestamp. Default 'tbilisi', which is how GSE names the files.",
        },
      },
      required: ['timestamp'],
    },
  },
  {
    name: 'gse_frequency',
    description:
      "The Georgian power system's electrical frequency in hertz, from the JSC Georgian State Electrosystem 1-minute real-time export — nominal 50 Hz, and how far it sits from nominal is a direct read on the balance between generation and demand. Carries the same ACT/SUB/NRE quality flag as the grid export.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        max_lookback_slots: {
          type: 'integer',
          description: 'How many 1-minute slots to walk back looking for the most recent published reading. Default 15.',
          minimum: 1,
          maximum: 60,
        },
      },
    },
  },
  {
    name: 'gse_demand_forecast',
    description:
      'Georgia\'s day-ahead electricity forecast published by JSC Georgian State Electrosystem: hour-by-hour total consumption, total supply, thermal / hydro (regulated and seasonal) / wind generation, and planned import and export, in MWh. Published daily, typically a day ahead.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        date: {
          type: 'string',
          description:
            "The forecast date as 'YYYY-MM-DD'. Defaults to today in Tbilisi. Tomorrow is usually already published; older dates stay available.",
        },
      },
    },
  },
  {
    name: 'gse_publications',
    description:
      "Reports and notices published by JSC Georgian State Electrosystem, Georgia's transmission system operator — including the Generation Adequacy Assessment (the medium and long-term supply-adequacy outlook), annual reports, independent auditor's reports, donor-organisation reports and the Strategic Environmental and Social Assessment. Also covers the operator's news and announcements. Available in English and Georgian.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        collection: {
          type: 'string',
          enum: ['publications', 'news', 'announcements', 'projects'],
          description: "Which collection to list. Default 'publications'.",
        },
        category_id: {
          type: 'integer',
          description:
            'Filter to one category. 3 = Annual Reports, 5 = Independent Auditor\'s Annual Report, 6 = Generation Adequacy Assessment, 7 = Donor Organizations\' Reports, 8 = SESA, 1 = News, 2 = important news. Call with no category to see the full list in the response.',
        },
        lang: { type: 'string', enum: ['en', 'ka'], description: "Language. Default 'en'." },
        page: { type: 'integer', description: 'Page number, 1-based. Default 1.', minimum: 1 },
        per_page: { type: 'integer', description: 'Items per page. Default 10, max 50.', minimum: 1, maximum: 50 },
      },
    },
  },
  {
    name: 'gse_tenders',
    description:
      'Procurement tenders run by JSC Georgian State Electrosystem, the Georgian electricity transmission system operator — substation and transmission-line construction, primary equipment supply, consultancy — with the awarded bidder, contract reference and bid prices where GSE has published them. Available in English and Georgian.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        lang: { type: 'string', enum: ['en', 'ka'], description: "Language. Default 'en'." },
        page: { type: 'integer', description: 'Page number, 1-based. Default 1.', minimum: 1 },
        per_page: { type: 'integer', description: 'Items per page. Default 10, max 50.', minimum: 1, maximum: 50 },
        year: { type: 'integer', description: 'Restrict to one publication year. Available years are listed in the response.' },
      },
    },
  },
  {
    name: 'gnerc_station_generation',
    description:
      "Monthly electricity generation for individual Georgian power stations — Enguri HPP, the Vardnili cascade, Khrami 1 and 2, Zhinvali, Gardabani thermal 1 and 2, the Kartli wind farm, named solar plants — plus national supply, consumption, import, export and named large direct consumers, in million kWh. Sourced from the Georgian National Energy and Water Supply Regulatory Commission (GNERC) actual-balance workbook, covering 2015 to 2026. Station names are published in Georgian script; each row keeps its original name and its position in the balance hierarchy.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        year: { type: 'integer', description: 'Calendar year, 2015-2026.', minimum: 2015, maximum: 2026 },
        query: {
          type: 'string',
          description:
            'Optional substring filter on the Georgian row label, e.g. "ჰესი" for hydro stations or "ენგურ" for Enguri. Matching is case-insensitive and accent-blind on the Georgian text as published.',
        },
        limit: { type: 'integer', description: 'Maximum rows to return. Default 100, max 400.', minimum: 1, maximum: 400 },
      },
      required: ['year'],
    },
  },
  {
    name: 'gnerc_prices',
    description:
      'Monthly Georgian electricity prices set or recorded by the Georgian National Energy and Water Supply Regulatory Commission (GNERC), 2015 to 2026, in tetri per kWh: the average balancing-electricity sale price, the guaranteed-capacity fee, and the price ESCO paid deregulated power stations.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        series: {
          type: 'string',
          enum: ['balancing', 'capacity_fee', 'deregulated'],
          description:
            "Which price series. 'balancing' = average sale price of balancing electricity; 'capacity_fee' = guaranteed capacity fee; 'deregulated' = price ESCO paid deregulated stations.",
        },
        year: { type: 'integer', description: 'Restrict to one year, 2015-2026. Omit for the whole series.', minimum: 2015, maximum: 2026 },
      },
      required: ['series'],
    },
  },
];

// ── Handlers ───────────────────────────────────────────────────────────────

async function gridNow(args: Record<string, unknown>) {
  const lookback = Math.min(Math.max(Number(args.max_lookback_slots ?? 10) || 10, 1), 40);
  const slot = await findLatestSlot('03M', lookback);
  const parsed = await fetchExport(slot.url, 'MW');
  if (!parsed.series.length) throw new Error(`GSE export at ${slot.url} parsed to zero values — the file shape has changed.`);
  return shapeGrid(slot.url, slot.wall, parsed, {
    slots_checked: slot.slots_checked,
    age_minutes: Math.round((Date.now() - tbilisiWallToUtc(slot.wall).getTime()) / 60_000),
  });
}

function parseRequestedWall(timestamp: string, timezone: string): Wall {
  const dotted = /^(\d{2})\.(\d{2})\.(\d{4})[ T](\d{1,2}):(\d{2})/.exec(timestamp);
  const iso = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})/.exec(timestamp);
  let w: Wall;
  if (dotted) {
    w = { day: +dotted[1], month: +dotted[2], year: +dotted[3], hour: +dotted[4], minute: +dotted[5] };
  } else if (iso) {
    w = { year: +iso[1], month: +iso[2], day: +iso[3], hour: +iso[4], minute: +iso[5] };
  } else {
    throw new Error(
      `Could not read timestamp "${timestamp}". Use 'YYYY-MM-DD HH:MM', 'YYYY-MM-DDTHH:MM' or 'DD.MM.YYYY HH:MM'.`,
    );
  }
  if (timezone === 'utc') {
    w = toTbilisiWall(new Date(Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, 0)));
  }
  return { ...w, minute: w.minute - (w.minute % 3) };
}

async function gridAt(args: Record<string, unknown>) {
  const timestamp = String(args.timestamp ?? '').trim();
  if (!timestamp) throw new Error('timestamp is required.');
  const timezone = String(args.timezone ?? 'tbilisi');
  const wall = parseRequestedWall(timestamp, timezone);
  const url = factUrl('03M', slotStamp(wall));
  if (!(await slotExists(url))) {
    const ageDays = Math.round((Date.now() - tbilisiWallToUtc(wall).getTime()) / 86_400_000);
    throw new Error(
      `GSE published no 3-minute export for ${wallLabel(wall)} Tbilisi time (${url}). ` +
        (ageDays > 30
          ? `That is about ${ageDays} days ago and GSE retains only a rolling ~30 days, so this slot is gone.`
          : ageDays < 0
            ? 'That timestamp is in the future.'
            : 'The slot is inside the retention window but was not published — GSE has occasional gaps. Nothing nearby has been substituted for it; pick another slot.'),
    );
  }
  const parsed = await fetchExport(url, 'MW');
  return shapeGrid(url, wall, parsed, { requested: timestamp, requested_timezone: timezone });
}

async function frequency(args: Record<string, unknown>) {
  const lookback = Math.min(Math.max(Number(args.max_lookback_slots ?? 15) || 15, 1), 60);
  const slot = await findLatestSlot('01M', lookback);
  const parsed = await fetchExport(slot.url, 'Hz');
  const reading = parsed.series.find((s) => s.interval === 'F') ?? parsed.series[0];
  if (!reading) throw new Error(`GSE 1-minute export at ${slot.url} contained no frequency value.`);
  return {
    frequency_hz: reading.value,
    deviation_from_nominal_hz: Number((reading.value - 50).toFixed(6)),
    nominal_hz: 50,
    quality: reading.quality,
    quality_meaning: reading.quality_meaning,
    measured: reading.measured,
    export_time_tbilisi: parsed.exportTime ?? wallLabel(slot.wall),
    export_time_utc: tbilisiWallToUtc(slot.wall).toISOString(),
    timezone: 'Asia/Tbilisi (UTC+4)',
    age_minutes: Math.round((Date.now() - tbilisiWallToUtc(slot.wall).getTime()) / 60_000),
    slots_checked: slot.slots_checked,
    source_url: slot.url,
    source: 'JSC Georgian State Electrosystem (GSE) 1-minute real-time export',
  };
}

const FORECAST_ROW_HINT: Record<string, string> = {
  'Total Consumption': 'total_consumption',
  'Total Suppy': 'total_supply',
  'Total Supply': 'total_supply',
  'Thermal Power Plants': 'thermal',
  'Hydro Power Plants': 'hydro',
  'Wind Power Plants': 'wind',
  'Including Regulated PPs': 'hydro_regulated',
  'Including Seasonal PPs': 'hydro_seasonal',
  'Export (-)': 'export',
  'Import (+)': 'import',
};

async function demandForecast(args: Record<string, unknown>) {
  const today = toTbilisiWall(new Date());
  const date = String(args.date ?? `${today.year}-${pad(today.month)}-${pad(today.day)}`).trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) throw new Error(`Could not read date "${date}". Use 'YYYY-MM-DD'.`);
  const url = `${GSE_FORECAST}/FORECAST-${m[1]}${m[2]}${m[3]}.xls`;
  const res = await pwFetch(url, { headers: { Accept: '*/*' } });
  if (!res.ok) {
    throw new Error(
      `GSE published no day-ahead forecast for ${date} (${res.status} at ${url}). Forecasts appear about a day ahead; try today or tomorrow.`,
    );
  }
  const { grid } = parseXls(new Uint8Array(await res.arrayBuffer()));

  // Row 1 (0-based) is the header: col 0 'Organization', col 1 'Daily',
  // cols 2..25 the 24 hours. Data rows follow.
  let headerRow = -1;
  for (const [r, cells] of grid) {
    if (cellText(cells.get(0)).toLowerCase() === 'organization') {
      headerRow = r;
      break;
    }
  }
  if (headerRow < 0) throw new Error(`GSE forecast for ${date} did not contain the expected header row.`);

  const hourCols: number[] = [];
  const headerCells = grid.get(headerRow)!;
  for (const [c, v] of headerCells) {
    if (c >= 2 && cellNumber(v) !== null) hourCols.push(c);
  }
  hourCols.sort((a, b) => a - b);

  const rows: Array<Record<string, unknown>> = [];
  for (const [r, cells] of [...grid].sort((a, b) => a[0] - b[0])) {
    if (r <= headerRow) continue;
    const label = cellText(cells.get(0));
    if (!label) continue;
    const hourly = hourCols.map((c, i) => ({ hour: i + 1, mwh: cellNumber(cells.get(c)) }));
    if (hourly.every((h) => h.mwh === null)) continue;
    rows.push({
      label,
      series: FORECAST_ROW_HINT[label] ?? null,
      daily_total_mwh: cellNumber(cells.get(1)),
      hourly,
    });
  }
  if (!rows.length) throw new Error(`GSE forecast for ${date} parsed to zero rows — the workbook shape has changed.`);
  return {
    date,
    unit: 'MWh per hour; hours are 1-24 in Tbilisi local time (UTC+4)',
    rows,
    row_count: rows.length,
    source_url: url,
    source: 'JSC Georgian State Electrosystem (GSE) day-ahead consumption forecast',
  };
}

function stripHtml(s: unknown): string {
  if (typeof s !== 'string') return '';
  return s
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&rsquo;/g, '’')
    .replace(/&[a-z]+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const GSE_FILE_BASE = 'https://admin.gse.com.ge/storage';

function shapeCmsItem(item: Record<string, unknown>) {
  const file = typeof item.file === 'string' ? item.file : null;
  const files = Array.isArray(item.files) ? item.files : [];
  const category = item.category as Record<string, unknown> | undefined;
  return {
    id: item.id,
    title: item.title,
    summary: stripHtml(item.short_description).slice(0, 600) || null,
    text: stripHtml(item.full_description).slice(0, 4000) || null,
    category: category ? { id: category.id, name_en: category.name_en, name_ka: category.name_ka } : null,
    published_at: item.published_at ?? item.created_at ?? null,
    start_date: item.start_date ?? null,
    end_date: item.end_date ?? null,
    status: item.status ?? null,
    file_url: file ? `${GSE_FILE_BASE}/${file}` : null,
    attachment_count: files.length,
    slug: item.slug ?? null,
  };
}

async function cmsList(collection: string, args: Record<string, unknown>, extraParams: Record<string, string> = {}) {
  const lang = args.lang === 'ka' ? 'ka' : 'en';
  const page = Math.max(Number(args.page ?? 1) || 1, 1);
  const perPage = Math.min(Math.max(Number(args.per_page ?? 10) || 10, 1), 50);
  const url = new URL(`${GSE_API}/${lang}/${collection}`);
  url.searchParams.set('page', String(page));
  url.searchParams.set('per_page', String(perPage));
  if (args.category_id !== undefined && args.category_id !== null) {
    url.searchParams.set('category_id', String(args.category_id));
  }
  for (const [k, v] of Object.entries(extraParams)) url.searchParams.set(k, v);

  const res = await pwFetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`GSE CMS ${res.status} for ${url.toString()}`);
  const json = (await res.json()) as { data?: Array<Record<string, unknown>>; meta?: Record<string, unknown> };
  const items = (json.data ?? []).map(shapeCmsItem);
  return {
    collection,
    language: lang,
    items,
    item_count: items.length,
    page,
    per_page: perPage,
    total: json.meta?.total ?? null,
    last_page: json.meta?.last_page ?? null,
    source_url: url.toString(),
    source: 'JSC Georgian State Electrosystem (GSE) public content API',
  };
}

async function publications(args: Record<string, unknown>) {
  const collection = String(args.collection ?? 'publications');
  if (!['publications', 'news', 'announcements', 'projects'].includes(collection)) {
    throw new Error(`Unknown collection "${collection}". Use publications, news, announcements or projects.`);
  }
  const out = await cmsList(collection, args);
  if (args.category_id === undefined) {
    const res = await pwFetch(`${GSE_API}/${args.lang === 'ka' ? 'ka' : 'en'}/categories`, {
      headers: { Accept: 'application/json' },
    });
    if (res.ok) {
      const cats = (await res.json()) as { data?: Array<Record<string, unknown>> };
      return { ...out, available_categories: cats.data ?? [] };
    }
  }
  return out;
}

async function tenders(args: Record<string, unknown>) {
  const extra: Record<string, string> = {};
  if (args.year !== undefined && args.year !== null) extra.year = String(args.year);
  const out = await cmsList('tenders', args, extra);
  const res = await pwFetch(`${GSE_API}/${args.lang === 'ka' ? 'ka' : 'en'}/years/tenders`, {
    headers: { Accept: 'application/json' },
  });
  const years = res.ok ? ((await res.json()) as number[]) : [];
  return { ...out, available_years: years };
}

async function stationGeneration(args: Record<string, unknown>) {
  const year = Number(args.year);
  if (!Number.isInteger(year)) throw new Error('year is required and must be an integer, e.g. 2026.');
  const limit = Math.min(Math.max(Number(args.limit ?? 100) || 100, 1), 400);
  const query = typeof args.query === 'string' ? args.query.trim().toLowerCase() : '';

  const book = await loadWorkbook(gnercUrl('balance'));
  const sheet = findSheet(
    book.sheets,
    (n) => n.trim().startsWith(String(year)),
    `GNERC published no balance sheet for ${year}`,
  );

  const rows: Array<Record<string, unknown>> = [];
  let matched = 0;
  for (const [rowNum, cells] of [...sheet.rows].sort((a, b) => a[0] - b[0])) {
    const name = cellText(cells.get('B'));
    if (!name) continue;
    const monthly = MONTH_COLUMNS.map((col, i) => ({
      month: i + 1,
      month_ka: MONTHS_KA[i],
      month_en: MONTHS_EN[i],
      generation_mkwh: cellNumber(cells.get(col)),
    }));
    if (monthly.every((m) => m.generation_mkwh === null)) continue; // header/spacer rows
    if (query && !name.toLowerCase().includes(query)) continue;
    matched++;
    if (rows.length >= limit) continue;
    const code = cellText(cells.get('A'));
    rows.push({
      // The A column is a hierarchy code (1.4.1.1 = a station under regulated
      // hydro under hydro under total generation). Excel stores some of these
      // as floats, so 1.1 arrives as 1.1000000000000001 — normalise.
      balance_code: code ? code.replace(/^(\d+)\.(\d)0{6,}\d*$/, '$1.$2') : null,
      depth: code ? code.split('.').length : null,
      name_ka: name,
      row: rowNum,
      monthly,
      year_total_mkwh: cellNumber(cells.get('O')),
    });
  }
  if (!rows.length) {
    throw new Error(
      query
        ? `No row in the GNERC ${year} balance sheet matches "${args.query}". Row labels are in Georgian script — try a Georgian substring such as "ჰესი" (HPP) or "ენგურ" (Enguri).`
        : `The GNERC ${year} balance sheet parsed to zero rows — the workbook shape has changed.`,
    );
  }
  return {
    year,
    sheet: sheet.name,
    unit: 'million kWh per month',
    note:
      'Rows are the published balance hierarchy: balance_code gives the position (e.g. 1.4.1.1 is one station inside regulated hydro), so aggregate rows and their component stations both appear. Names are published in Georgian script only. A null month means the cell was blank in the published workbook, which is not the same as zero.',
    rows,
    row_count: rows.length,
    matched_rows: matched,
    truncated: matched > rows.length,
    source_url: gnercUrl('balance'),
    source:
      'Georgian National Energy and Water Supply Regulatory Commission (GNERC) actual electricity balance workbook, data.gnerc.org',
  };
}

const PRICE_SERIES: Record<string, { book: keyof typeof GNERC_BOOKS; label: string; unit: string }> = {
  balancing: {
    book: 'balancing',
    label: 'Average sale price of balancing electricity',
    unit: 'tetri per kWh',
  },
  capacity_fee: {
    book: 'capacity_fee',
    label: 'Guaranteed capacity fee',
    unit: 'tetri per kWh',
  },
  deregulated: {
    book: 'deregulated',
    label: 'Price ESCO paid deregulated power stations for balancing electricity',
    unit: 'tetri per kWh',
  },
};

async function prices(args: Record<string, unknown>) {
  const key = String(args.series ?? '');
  const spec = PRICE_SERIES[key];
  if (!spec) throw new Error(`Unknown series "${key}". Use balancing, capacity_fee or deregulated.`);
  const yearFilter = args.year === undefined || args.year === null ? null : Number(args.year);

  const book = await loadWorkbook(gnercUrl(spec.book));
  const sheet = book.sheets[0];
  if (!sheet) throw new Error(`GNERC ${key} workbook contained no sheets.`);

  // The header row is not at a fixed position across these three workbooks —
  // find the row whose first cell is the Georgian word for "month".
  let headerRow = -1;
  for (const [r, cells] of [...sheet.rows].sort((a, b) => a[0] - b[0])) {
    if (cellText(cells.get('A')) === 'თვე') {
      headerRow = r;
      break;
    }
  }
  if (headerRow < 0) throw new Error(`GNERC ${key} workbook has no month/year header row — the shape has changed.`);

  const yearByCol = new Map<string, number>();
  for (const [col, v] of sheet.rows.get(headerRow)!) {
    if (col === 'A') continue;
    const y = cellNumber(v);
    if (y !== null && y >= 2000 && y <= 2100) yearByCol.set(col, y);
  }

  const observations: Array<Record<string, unknown>> = [];
  for (const [r, cells] of [...sheet.rows].sort((a, b) => a[0] - b[0])) {
    if (r <= headerRow) continue;
    const monthName = cellText(cells.get('A'));
    const monthIndex = MONTHS_KA.indexOf(monthName);
    if (monthIndex < 0) continue;
    for (const [col, year] of yearByCol) {
      if (yearFilter !== null && year !== yearFilter) continue;
      const price = cellNumber(cells.get(col));
      if (price === null) continue;
      observations.push({
        year,
        month: monthIndex + 1,
        month_ka: monthName,
        month_en: MONTHS_EN[monthIndex],
        period: `${year}-${pad(monthIndex + 1)}`,
        price,
        unit: spec.unit,
      });
    }
  }
  observations.sort((a, b) => String(a.period).localeCompare(String(b.period)));
  if (!observations.length) {
    throw new Error(
      yearFilter !== null
        ? `GNERC has published no ${key} price for ${yearFilter}. The series runs 2015 to the current year.`
        : `The GNERC ${key} workbook parsed to zero observations — the shape has changed.`,
    );
  }
  return {
    series: key,
    label: spec.label,
    unit: spec.unit,
    sheet: sheet.name,
    year: yearFilter,
    observations,
    observation_count: observations.length,
    first_period: observations[0].period,
    last_period: observations[observations.length - 1].period,
    source_url: gnercUrl(spec.book),
    source: 'Georgian National Energy and Water Supply Regulatory Commission (GNERC) open data, data.gnerc.org',
  };
}

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'gse_grid_now':
      return gridNow(args);
    case 'gse_grid_at':
      return gridAt(args);
    case 'gse_frequency':
      return frequency(args);
    case 'gse_demand_forecast':
      return demandForecast(args);
    case 'gse_publications':
      return publications(args);
    case 'gse_tenders':
      return tenders(args);
    case 'gnerc_station_generation':
      return stationGeneration(args);
    case 'gnerc_prices':
      return prices(args);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
