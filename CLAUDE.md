# FDP ecosystem — notes for Claude

A static FAIR Data Point in Turtle (`fdp/`) with a client-side viewer (`site/`), deployed to GitHub Pages and built from the [FDP ecosystem template](https://github.com/LeanFDP/fdp-ecosystem-template).

- **Instance vs engine.** Everything instance-specific (name, IRIs, theme, logo, maintainer) is in `fdp.config.json`, `fdp/` and `assets/`. Engine files are listed in `.fdp-engine`. Never hardcode instance values in engine files; read them via `scripts/fdpconfig.py`.
- **House style.** Change the look through `theme` in `fdp.config.json` or `assets/house-style.css` (instance files), never through `site/style.css` (engine). New styling in the engine should use the CSS variables, so the theme and house styles keep working.
- **Adding a data source.** Follow [CONTRIBUTING.md](CONTRIBUTING.md): three DCAT levels, and on every distribution an access-method `dcterms:type` plus a "How to get it:" description. Prefer `scripts/add_source.py` with a JSON spec (`scripts/example-source.json`). For a source with its own FDP, add a live index entry.
- **Verify before writing.** Check that URLs resolve and endpoints answer a real query; state counts and dates "on YYYY-MM-DD".
- **After any change**, validate and preview:

  ```bash
  python3 scripts/validate.py
  scripts/build-site.sh && python3 -m http.server -d _site 8000
  ```

- **No `rdfs:seeAlso`.** Link with a predicate that says what the link is. Catalogs and access-method terms are hash IRIs in their own documents; a live FDP is an index entry with `dcterms:source`.
- **Moving IRIs.** Use `scripts/set-base.sh` (to another repository or a w3id); it also updates the config.
