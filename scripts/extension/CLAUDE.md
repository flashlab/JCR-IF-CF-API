# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Single-file Tampermonkey / Violentmonkey userscript: `scholarscope-lite.user.js`. It injects JCR impact-factor and quartile badges, NIH iCite citation counts, a full-abstract toggle, DOI / Google Scholar / cited-by actions, a manual JCR lookup UI, and filter / sort controls into PubMed pages. There is no build system, package manager, test runner, or linter. The `.user.js` file is the shipping artifact.

## Development commands

- Syntax check: `node --check scholarscope-lite.user.js`
- Manual test: reinstall or reload the userscript in Tampermonkey / Violentmonkey, then visit `https://pubmed.ncbi.nlm.nih.gov/*` pages. Search results and article detail pages exercise different code paths.
- Do not introduce a bundler, transpiler, or test framework unless explicitly requested.

## Architecture

All code lives in a single IIFE in `scholarscope-lite.user.js`. Top-to-bottom sections are delimited by `// =====` banners:

1. **Config** — `CFG` is persisted with `GM_setValue('cfg', …)` and merged from `DEFAULTS` at load. Fields: `quartileSource` (`'jcr'` or `'cas'`), `showCitation`, `autoFilter`, `autoSort`, `sortingMethod` (`1` = IF, `2` = citations), `filter.{minIF,maxIF,q1..q4}`, `pubmedApiKey`.
2. **Utilities** — `el()` DOM builder; `factorColor`, `quartileColor`, `normalizeFenqu`, `pickDisplayQuartile`; `gmFetch` / `gmFetchText` wrappers; `makeQueue(concurrency)`. Shared queues: `jcrQueue` capped at 4 and `efetchQueue` capped at 2.
3. **Cache** — Only JCR results are cached, keyed by lowercased keyword under `GM_getValue('jcrCache')`. Cache entries store `{ data, medHit, ts }` and expire after `JCR_CACHE_TTL_MS` = 7 days. iCite and eFetch are never cached. Cache is skipped when `jcrLookup()` is called with `extraParams`.
4. **APIs** — `jcrLookup`, `iciteBatch`, `efetchAbstractXml`.
5. **Modal / manual lookup** — `#Scholarscope_Modal` is a lazy singleton used for JCR result tables. `jcrResultsModal(rows, highlightIdx, options)` renders multi-row hits and can clear cached results for the originating keyword. JCR `NotFound` and `MedHit` badges open a floating manual lookup dropdown. The dropdown can submit `q`, `f`, `is_abbr`, `page`, `show_all` and `is_med`.
6. **Badge factories** — `applyJcrToBadges` is the central renderer. It handles `errored`, `medHit`, `NotFound`, `ambiguous`, and normal states, sets badge text / color / dataset fields, and marks ambiguous IF rows with `Scholarscope_IF_Ambiguous`.
7. **Detail page** — `renderDetailHeader` injects `#Scholarscope_JournalDetailFrame` before `.article-citation`; `renderDetailTimesCited` injects `#Scholarscope_TimesCited`. The detail header may also surface the article type badge.
8. **Appendix badges** — Used on search results and similar / cited-by lists. `injectAppendixFrame` appends `.Scholarscope_Appendix_JournalFrame` into `.docsum-citation` or `.docsum-content`. Badge order is `Journal` → `Factor` → `Quartile` → `Year` → `ArticleType` when enabled. DOI is injected inline when present. `fillAppendixCitationBatch` batches visible PMIDs into one iCite request.
9. **Action row** — `injectActionRow` adds cited-by, Google Scholar, and `Full Abstract` actions. `toggleAbstract` fetches PubMed XML, parses `AbstractText`, preserves `Label` headings, and sanitizes the rendered HTML with `DOMPurify`.
10. **Toolbar** — `buildToolbar` inserts `#Scholarscope_Toolbar` on search pages after `.top-wrapper` / `.search-results-view-switch` / `.results-amount-container` (first match wins). It contains the filter dropdown, sort toggle, and “select visible” button. `applyFilter` hides rows by collapsing height / margin / overflow, not by `display:none`. `applySorting` reorders rows by IF or cited count.
11. **Bootstrap** — `init()` branches on detail vs search pages. `watchDocsumList()` uses a `MutationObserver` plus a `data-scholarscope-seen` flag so each docsum is processed once. PubMed SPA navigation is handled by an 800 ms `location.href` polling loop with a 400 ms settle delay.
12. **Menu commands** — Five `GM_registerMenuCommand` entries exist for quartile source, citation toggle, filter panel, cache reset, and PubMed API key.
13. **Styles** — One `GM_addStyle` block near the bottom contains all injected CSS.

## Important conventions

- **CSS class prefix** — Every injected element uses the `Scholarscope_` prefix. Keep that prefix for any new DOM or style hooks.
- **NotFound / MedHit manual retry** — Clicking a `Scholarscope_NotFound` or `Scholarscope_MedHit` badge opens the manual lookup dropdown. It defaults the keyword from the original journal title when available, otherwise from `dataset.origKw`. The form submits `q` plus extra query params selected in the dropdown; successful lookups update the cache under the original keyword, then re-run auto filter / sort when enabled.
- **Ambiguous IF marker** — When JCR returns multiple rows, the factor badge uses `Scholarscope_IF_Ambiguous` and clicking it opens the result modal with all rows.
- **No `display:none` for filtered rows** — Keep the current collapse-based filter behavior so sorting and citation batching still work on hidden rows.
- **SPA polling interval** — Do not replace the href polling loop with a `popstate` listener unless PubMed navigation behavior has been re-verified.
- **`GM_*` grants are load-bearing** — All five `@grant` declarations are used. Remove a grant only if the matching call site is removed too.
- **DOMPurify is required** — Do not render eFetch abstract HTML without sanitization.

## External API contracts

These endpoints are called via `GM_xmlhttpRequest` and require matching `@connect` declarations:

- **JCR** — `https://jcr-query-api.4cf.workers.dev/api/jcr`. Query params always include `q`; the manual lookup UI may also pass `f` and other selected lookup flags. Response shape is `{ data: Row[], med_hit?: boolean }`. Each row includes `name`, `abbr`, `jif_2024`, `jif_quartile`, `fenqu`, `is_top` and others if `show_all=1`. Update the `jif_2024` field name when the upstream year changes.
- **NIH iCite** — `https://icite.od.nih.gov/api/pubs?pmids=<csv>`. Response shape is `{ data: [{ pmid, citation_count, ... }] }`. Requests are always batched when possible.
- **NCBI eFetch** — `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=pubmed&rettype=xml&id=<pmid>`. The parser reads `AbstractText` nodes and honors `@Label` for structured abstracts. `CFG.pubmedApiKey` is sent as `api_key` when present.
