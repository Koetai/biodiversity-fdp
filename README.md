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

URIs resolve as `https://raw.githubusercontent.com/andrawaag/biodiversity-fdp/main/fdp/{folder}/`.

## Housekeeping

```bash
python3 scripts/validate.py                    # parse all Turtle and check the DCAT shape (needs rdflib)
scripts/set-base.sh <org> <repo> [branch]      # rewrite every URI if the repo moves or is renamed
```

CI runs `validate.py` on every push that touches `fdp/`.

To keep the files readable by the viewer, follow these conventions:

- Start each node's block in column 0 with a `:local-name`.
- Make `dcat:dataset` and `dcat:distribution` the last predicate of their block.
- Write literals on a single line.

## Viewer

`viewer/` is a self-contained Java 8+ JAR adapted from the AMC viewer.
It offers an FDP browser (index → catalog → dataset → distributions, filterable by access method) and a Turtle editor that commits through GitHub OAuth Device Flow.

```bash
cd viewer && ./build.sh
cp config.properties.template config.properties   # set github.client_id to commit; browsing needs nothing
java -jar fdp-viewer.jar
```

Setting `local.root=..` in `config.properties` previews the local checkout without GitHub (read-only).

Changes from the AMC version:

- The server binds to loopback only and checks the Host and Origin headers, so other sites cannot use the signed-in token.
- The wildcard CORS header is removed.
- The OAuth scope is configurable (default `public_repo`), and the client secret is optional because Device Flow doesn't need one.
- Base64 decoding and JSON parsing are fixed for files larger than a few KB.
- The parser reads IRI media types, access methods and data services.
- The UI is in English.
