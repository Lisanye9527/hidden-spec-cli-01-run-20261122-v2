# mend

One patch tool for every AI edit format, built for the make.fun bounty
[hidden-spec-cli-01-run-20261122](https://make.fun/bounty/hidden-spec-cli-01-run-20261122).

AI models hand back edits in four different shapes. `mend` reads any of them,
finds the lines each edit names, and applies the whole patch or none of it:

- **unified diffs**, including diffs whose hunk line numbers are wrong — the
  hunk is located by its content and the stated number only breaks the tie
  between equally good matches;
- **SEARCH/REPLACE blocks** (`<<<<<<< SEARCH` / `=======` / `>>>>>>> REPLACE`);
- **V4A patches** (`*** Begin Patch` … `*** End Patch`), with anchored chunks,
  end-of-file chunks and file moves;
- **JSON tool calls** — one array of edit objects, or JSON Lines — with
  `create`, `str_replace` and `insert` commands.

## Usage

```
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

Run it in the root of the tree to patch. `PATCH` is a patch file; omit it (or
pass `-`) to read the patch from standard input. With `--format=auto` (the
default) the format is detected from the patch text; `--format` can pin one of
`unified`, `search-replace`, `v4a` or `json`.

- `--check` reports exactly what a real run would, but writes nothing.
- `--strict` turns off the two forgiving matching tiers: lines must match
  exactly instead of merely matching once trailing (tier 1) or surrounding
  (tier 2) spaces and tabs are ignored. Tier 2 matches are re-indented to the
  file's own indentation, and context lines always keep the file's own text.

## Output

On success mend prints one line per changed path (`A`, `D`, `M`, or
`R <old> -> <new>` for a move), sorted by path, then `ok: <n> files`. When any
edit fails, nothing is written: mend prints one `error: <code> <path>` line per
failed edit and a `failed: <k> of <n> edits` summary, and exits 1. Usage,
unreadable-patch, format and parse problems exit 2 with a single error line.
The full contract is [SPEC.md](SPEC.md).

## Layout

- `main.ts` — the whole tool (Node 22, standard library only, no install step).
- `runner.ts` — the trial runner from the competition kit; `main.ts` hands
  over to it when `MAKEFUN_ENV_URL` is set.
- `check.ts` — runs `main.ts` against the kit's public practice checks.
- `SPEC.md` — the specification mend implements.

## License

MIT — see [LICENSE](LICENSE).
