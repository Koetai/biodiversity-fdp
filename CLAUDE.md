# Biodiversity FDP — notes for Claude

Static FAIR Data Point in Turtle (`fdp/`) with a client-side viewer (`site/`) deployed to GitHub Pages.

- To add or change a data source, follow [CONTRIBUTING.md](CONTRIBUTING.md). Its conventions are the contract: three DCAT levels, an access-method `dcterms:type` and a "How to get it:" description on every distribution.
- Prefer `scripts/add_source.py` with a JSON spec (see `scripts/example-source.json`) for new curated sources. For a source that runs its own FAIR Data Point, add a live index entry instead of copying its metadata.
- Before writing a distribution, check that the URL resolves and that endpoints answer a real query. State counts and dates with "on YYYY-MM-DD".
- After any change, run `python3 scripts/validate.py` and preview it:

  ```bash
  scripts/build-site.sh && python3 -m http.server -d _site 8000
  ```

- Do not hand-edit IRIs to rename the repo; use `scripts/set-base.sh`.
