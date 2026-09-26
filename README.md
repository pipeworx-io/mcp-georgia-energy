# @pipeworx/georgia-energy

Georgia's (the country's) national electricity system: live grid telemetry from
the transmission system operator, and the regulator's per-power-station monthly
generation and price series.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1683+ live data sources.

## Tools

- `gse_grid_now(...)` — the grid as of the latest published 3-minute slot:
  hydro / thermal / wind / solar generation, total generation, cross-border flow
  on the Azerbaijan, Armenia, Russia (with the Salkhino, Java and Nakaduli lines
  broken out) and Turkey tie lines, and total consumption, in MW.
- `gse_grid_at(...)` — the same blocks for one explicit past slot, inside the
  rolling ~30-day retention window.
- `gse_frequency(...)` — system frequency in Hz (nominal 50), 1-minute feed.
  How far it sits from 50 is a direct read on generation-versus-demand balance.
- `gse_demand_forecast(...)` — the day-ahead forecast, hour by hour: consumption,
  supply, thermal, hydro (regulated and seasonal), wind, import and export.
- `gse_publications(...)` — the operator's reports and notices, including the
  Generation Adequacy Assessment, annual reports and the SESA.
- `gse_tenders(...)` — the operator's procurement tenders with awarded bidders
  and bid prices where published.
- `gnerc_station_generation(...)` — monthly generation for individual power
  stations (Enguri, the Vardnili cascade, Khrami 1/2, Zhinvali, Gardabani
  thermal 1/2, the Kartli wind farm, named solar plants) plus national supply,
  consumption, import, export and named large direct consumers, 2015-2026.
- `gnerc_prices(...)` — monthly balancing-electricity price, guaranteed-capacity
  fee, and the price ESCO paid deregulated stations, 2015-2026.

## Auth

Keyless. No token, no cookie, no registration on either publisher.

## Data sources

- <https://admin.gse.com.ge/storage/uploads/fact/> — JSC Georgian State
  Electrosystem (GSE) real-time system exports. `GSE_EXPORT_NEW_PERIOD_03M_*.XML`
  every 3 minutes, `GSE_EXPORT_PERIOD_01M_*.XML` (frequency) every minute.
- <https://admin.gse.com.ge/api/file-exists?path=...> — GSE's own existence
  probe for the above. Verified to discriminate correctly in both directions.
- <https://admin.gse.com.ge/api/{en,ka}/{publications,news,announcements,projects,tenders,categories}>
  — the operator's Laravel content API. `meta.total` is a genuine total.
- <https://admin.gse.com.ge/storage/uploads/consumption_files/excel/FORECAST-YYYYMMDD.xls>
  — day-ahead consumption forecast.
- <https://data.gnerc.org/excel/> — Georgian National Energy and Water Supply
  Regulatory Commission (GNERC) open-data workbooks.

## Things that will otherwise be rediscovered the hard way

**GSE filenames are in Tbilisi local time (UTC+4), not UTC**, with the minute
floored to a multiple of 3, and publication lags. Asking for the current minute
returns a 404, not an error — so "now" must mean "the newest slot that exists",
which is why every read walks backwards and proves the slot with `file-exists`
first. **The lag is not the ~2 minutes the original sample suggested**: the
1-minute frequency feed has been observed 9-10 slots behind. That is why the
walk probes in concurrent batches — ten sequential round trips to Tbilisi cost
about four seconds, most of it waiting.

**Every telemetered value carries a `QUALITY` attribute and most of them are not
measurements.** `ACT` is actual telemetry; `SUB` was substituted by the operator;
`NRE` was not received. A representative live export had 3 ACT, 7 SUB and 3 NRE —
national consumption was NRE and the hydro total SUB. So the flag travels with
every row and is summarised at the top of the response. Dropping it would return
a fill-in as a measurement, which is worse than returning nothing.

**The real-time XML needs its preamble stripped before parsing**: it declares
ISO-8859-1 (the content is ASCII), ships an `<?xml-stylesheet?>` PI, and carries
a `<!DOCTYPE ... SYSTEM 'GSE_V1.DTD'>` that a strict parser will try to resolve.
`BLOCK_AREA/@Name` is space-padded to a fixed width, so trim before matching.

**The day-ahead forecast really is an Excel 97 file** (`D0 CF 11 E0` magic), not
an HTML table wearing an `.xls` extension, so it needs the OLE2 compound-file
container walked before the BIFF8 record stream can be read. `src/xlsx.ts` does
both that and OOXML `.xlsx`, dependency-free, on the Workers runtime.

**`data.gnerc.org` sends its leaf certificate with no intermediate.** Node's
bundled CA store cannot chain it and fails with
`UNABLE_TO_VERIFY_LEAF_SIGNATURE`, so a local script testing this pack outside a
Worker will look like the site is down. Cloudflare's egress resolves it fine
(verified live against our own gateway, 2026-09-10). Do not "fix" this by
changing hosts — the alternatives serve the same single-certificate chain, and
`gnerc.org/excel/` answers 500.

**The GNERC balance workbook is ~450 KB**, so it is fetched and parsed once per
isolate and cached for six hours rather than downloaded per call.

**On the balance sheets, columns C..N are Jan..Dec and O is the year total** —
but empty months are written as self-closing, valueless cells. A worksheet cell
regex whose `<c ...>...</c>` alternative comes before its self-closing one will
merge an empty cell with the next populated one and slide values into the wrong
column, reporting a December figure as April. It errors nowhere. The ordering in
`src/xlsx.ts` is load-bearing; the note above it says so.

The three price workbooks are laid out the other way round (months down, years
across) and **do not agree on which row the header sits in**, so the header is
found by looking for the Georgian word for "month" rather than by position.
Some of their cells are text padded with non-breaking spaces.

**GNERC row labels are Georgian script only** — `ენგურჰესი` is Enguri HPP. The
`balance_code` column preserves the published hierarchy (`1.4.1.1` is one
station inside regulated hydro inside hydro inside total generation), so
aggregate rows and their component stations are both present and
distinguishable. Excel stores some of those codes as floats, so `1.1` arrives as
`1.1000000000000001` and is normalised.

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "georgia-energy": {
      "url": "https://gateway.pipeworx.io/georgia-energy/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/georgia-energy/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1683+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/gse_grid_now \
  -H 'Content-Type: application/json' \
  -d '{}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/gse_grid_now`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Standalone (no gateway account)

This package also runs as a local stdio MCP server — no Pipeworx account, no
gateway round-trip:

```json
{
  "mcpServers": {
    "georgia-energy": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-georgia-energy"]
    }
  }
}
```

Or run it directly to confirm it starts:

```bash
npx -y @pipeworx/mcp-georgia-energy
```

It speaks MCP over stdin/stdout and answers `initialize`/`tools/list`/`tools/call`
for **only** this pack's tools — none of the shared meta-tools the gateway
connection above adds. Same source, same tools, no ask_pipeworx routing.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Georgia Energy data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
