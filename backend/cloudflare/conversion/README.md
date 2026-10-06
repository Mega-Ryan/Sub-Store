# Workers conversion runtime

The conversion module uses the original Sub-Store parsers, preprocessors,
protocol helpers, and producers under `backend/src/core/proxy-utils`.
It does not import the Node application's startup, global OpenAPI instance,
storage, downloader, Gist integration, DNS, MMDB, or dynamic script executor.

The upstream Surge, Loon, and Quantumult X parsers compile Peggy grammars
on first use. `compile-parsers.mjs` runs only during the build to generate
static JavaScript and preserve the QX ALPN wrapper. The esbuild plugin routes
those three parser imports to `conversion/parsers`; the Peggy compiler does
not enter the Worker dependency graph. Generated parser files are committed.

`core.js`, `processors.js`, and `geo.js` contain narrowly extracted pure
functions from backend version 2.42.2, commit
`b7379718d833f3777bcd184ab63f0201a3d23d45`, under the original AGPL-3.0
license. Future upstream updates should compare these helpers against that
baseline and rerun conversion tests before updating the snapshots.

The Worker build must alias `@/core/app` to `conversion/app.js` and
`@/utils/geo` to `conversion/geo.js`, with other `@` imports resolving to
`backend/src`. This severs the upstream helpers' runtime dependencies.

## Contract

`await convert(rawSources, target, processors, context)` accepts:

- A string source or an array of `{ content, processors?, name?,
  displayName?, description? }` objects.
- An existing producer key, available through `SUPPORTED_TARGETS`.
- A collection-level processor list; per-source processors run first.
- Optional `context.options` containing boolean `include-unsupported-proxy`,
  `delete-underscore-fields`, `prettyYaml`, or `pretty-yaml`.
- Optional `context.type: 'internal'` for structured producer output.

It returns `{ originalProxies, proxies, output, target, warnings }`.
Preview arrays are independent: processing and formatting do not mutate the
original preview. No fetch, storage, or request secrets are accessed here.

`validateProcessors` should also run on save and import. Disabled unsupported
actions are rejected, preventing future activation of an unsupported saved
configuration. Unknown parameters, dynamic scripts, local CA paths, external
process nodes, and advanced SurgeMac external-program options are explicit
errors. Error objects expose `code`, `status`, and `details`.

Actual initial conversion limits are 32 source entries, 2 MiB total input,
10,000 parsed nodes, 64 processing actions, and bounded regular-expression
and condition sizes. These are safety ceilings, not a guarantee that every
input below the ceiling will fit the account's CPU budget.

## Changes from upstream helpers

- All script/loading/response-transformer functions are absent.
- Filesystem certificate reading is absent; inline PEM fingerprints use
  supported `node:crypto` SHA-256 instead of jsrsasign.
- Region detection uses only names/flags.
- Duplicate counters use objects without prototypes, so names such as
  `constructor` cannot be mistaken for an existing entry.
- Conditional `EXISTS` requires a value to be neither null nor undefined.
- Built-in processor failures propagate instead of trying a script fallback.
- Parser/producer warnings are collected per asynchronous call with
  `AsyncLocalStorage`; warning text never contains source content or credentials.

The tests cover ten common client formats, input normalization, previews,
processing order, disabled unsupported actions, malformed arguments, local
capability rejection, warning isolation, and certificate fingerprints.
