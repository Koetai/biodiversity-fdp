# Biodiversity FDP

Static [FAIR Data Point](https://specs.fairdatapoint.org/) profiles for biodiversity infrastructures, served as Turtle straight from GitHub.
For every resource, the profile lists all the ways to obtain it: native portals and APIs, bulk files, cloud buckets, and copies in aggregators (GBIF, QLever, Koetai).
Provenance is kept, not deduplicated. For example, the iNaturalist research-grade subset appears as a distribution of iNaturalist and is also inside GBIF.

The layout follows [`AmsterdamUMC/proeftuin_datastandaarden/fdp`](https://github.com/AmsterdamUMC/proeftuin_datastandaarden/tree/main/fdp) and the
[StaticFDP biodiversity deployment](https://codeberg.org/StaticFDP/staticfdp/src/branch/main/deployments/biodiversity.md).

## Structure

```
fdp/
├── biodiversity-index/catalog.ttl   overarching index → rdfs:seeAlso every sub-catalog
├── inaturalist-fdp/catalog.ttl      iNaturalist (native + GBIF subset in API, AWS Parquet, QLever)
├── gbif-fdp/catalog.ttl             GBIF (native, AWS Parquet snapshots, QLever RDF) + backbone
├── bhl-fdp/catalog.ttl              BHL (native, data.zip, Internet Archive) + RDF on Koetai
├── plazi-fdp/catalog.ttl            Plazi TreatmentBank (web, API, XML/RDF git, SPARQL, Synospecies, GBIF) + BLR on Zenodo
├── uniprot-fdp/catalog.ttl          UniProt 2026_03 (web, REST, SPARQL, FTP, RDF, Proteins API, QLever)
├── openstreetmap-fdp/catalog.ttl    OSM live, planet 2026-09-28, osm2rdf on QLever
├── geonames-fdp/catalog.ttl         GeoNames (web services, dumps, RDF dump, ontology)
├── flair-gg-fdp/catalog.ttl         FLAIR-GG: 6 Spanish germplasm banks (FDPs, SPARQL, lookup APIs), Virtual Platform, semantic model
└── vocab/access-methods.ttl         SKOS scheme used as dcterms:type on each distribution
```

The profiles use a three-level DCAT hierarchy under each `fdp:MetadataService`:

| Level | Class | Here |
|---|---|---|
| 1 | `dcat:Catalog` | one per infrastructure |
| 2 | `dcat:Dataset` | one per release, snapshot or live state |
| 3 | `dcat:Distribution` | one per way to get it |

Each distribution carries:

- `dcterms:type` from the access-method vocabulary: `web-portal`, `rest-api`, `sparql-endpoint`, `bulk-download`, `cloud-object-storage`, `darwin-core-archive`, `rdf-dump`, `source-repository`, `aggregator-mirror`, `oai-pmh`, `sql-query` or `change-feed`.
- `dcterms:description` starting with **"How to get it:"**, a concrete recipe such as a URL pattern, a CLI command or the account requirements.
- `dcat:accessURL`, plus `dcat:downloadURL` where a single file exists.
- `dcat:accessService` pointing to a `dcat:DataService` with `dcat:endpointURL`, `dcat:endpointDescription` and `dcterms:conformsTo` (SPARQL 1.1, S3 API, OpenAPI…).
- `dcat:mediaType` as an IANA IRI, and `dcterms:format` from the EU file-type authority.
- `prov:wasDerivedFrom` when the distribution is a copy or a conversion of another one.

URIs resolve as `https://raw.githubusercontent.com/Koetai/biodiversity-fdp/main/fdp/{folder}/`.

## Housekeeping

```bash
python3 scripts/validate.py                    # parse all Turtle and check the DCAT shape (needs rdflib)
scripts/set-base.sh <org> <repo> [branch]      # rewrite every URI if the repo moves or is renamed
```

CI runs `validate.py` on every push that touches `fdp/`.

The viewer uses a full Turtle parser, so any valid Turtle works. The house style (one block per node, a "How to get it:" description on each distribution) is a convention, not a requirement.

## Viewer (GitHub Pages)

`site/` is a static, public FDP browser: plain HTML and JS, no server.
It fetches the index Turtle, follows `rdfs:seeAlso` to every sub-catalog, and parses everything in the browser with [N3.js](https://github.com/rdfjs/N3.js).
You browse index → catalog → dataset → "ways to get it", and can filter by access method.
Data services and `prov:wasDerivedFrom` links resolve across catalogs.

- **Deploy:** `.github/workflows/pages.yml` validates the Turtle, then publishes `site/` together with `fdp/` on every push to `main`. Enable it once under *Settings → Pages → Source: GitHub Actions*. The site is then at `https://koetai.github.io/biodiversity-fdp/`, and the Turtle files are also served there as `text/turtle`.
- **Editing:** each catalog has *Edit on GitHub* and *History* links. GitHub handles sign-in, and people without write access get a fork and a pull request automatically. No OAuth app or secret is needed.
- **Other FDPs:** `?index=<url of an index catalog.ttl>` browses any FDP laid out the same way, as long as it is publicly readable.
- **Local preview:**

  ```bash
  scripts/build-site.sh && python3 -m http.server -d _site 8000
  ```

The viewer derives the repository, branch and edit links from the index's own URIs, so `scripts/set-base.sh` is the only thing to run after renaming the repo.
