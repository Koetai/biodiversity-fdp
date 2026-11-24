#!/usr/bin/env python3
"""Give every catalog document the identifiers FAIR tests look for. Running it again changes nothing.

    python3 scripts/add_identifiers.py [--dry-run]

The FAIR assessment (scripts/fair_assess.py) tests each FDP and catalog at the address the website
serves it from, e.g. <siteUrl>fdp/x-fdp/catalog.ttl and <siteUrl>fdp/x-fdp/catalog.ttl#catalog.
The OSTrails tests then look for:

* F3 MetaIdent: a dcterms:identifier whose value is exactly that address;
* F3 DataIdent: a link from the record to what it describes, such as foaf:primaryTopic.

So each sub-FDP root and its catalogs get dcterms:identifier with both their canonical IRI and their
address on the website (as the index already has), and the document states its foaf:primaryTopic.
scripts/add_source.py writes these for new sources; this script adds what older documents lack,
as a block at the end of each file, so nothing else in it moves.
"""
import sys
from pathlib import Path

from rdflib import Graph, Literal, Namespace, URIRef
from rdflib.namespace import DCTERMS, FOAF, RDF

sys.path.insert(0, str(Path(__file__).resolve().parent))
from fdpconfig import BASE_IRI, INDEX_FOLDER, ROOT, SITE_URL  # noqa: E402

FDP = Namespace("https://w3id.org/fdp/fdp-o#")
SITE_FDP = SITE_URL.rstrip("/") + "/fdp/"


def website_address(iri):
    """Where the website serves a canonical IRI, as fair_assess.py rewrites it."""
    return SITE_FDP + iri[len(BASE_IRI):] if iri.startswith(BASE_IRI) else iri


def missing(path):
    """Turtle statements the catalog document at path lacks, as text ('' if none)."""
    folder = path.parent.name
    doc, root = f"{BASE_IRI}{folder}/catalog.ttl", URIRef(f"{BASE_IRI}{folder}/")
    g = Graph().parse(path, format="turtle")
    if (root, RDF.type, FDP.MetadataService) not in g:
        return ""
    out = []
    subjects = [(root, [str(root), website_address(doc)])]
    subjects += [(c, [str(c), website_address(str(c))]) for c in sorted(g.objects(root, FDP.hasCatalog))
                 if str(c).startswith(doc + "#")]
    for s, ids in subjects:
        new = [i for i in ids if (s, DCTERMS.identifier, Literal(i)) not in g]
        if new:
            out.append(f"<{s}> dcterms:identifier " + " , ".join(f'"{i}"' for i in new) + " .")
    if (URIRef(doc), FOAF.primaryTopic, root) not in g:
        out.append(f"<{doc}> foaf:primaryTopic <{root}> .")
    return "\n".join(out)


def catalog_documents():
    return [p for p in sorted((ROOT / "fdp").glob("*/catalog.ttl")) if p.parent.name != INDEX_FOLDER]


def main():
    dry_run = "--dry-run" in sys.argv[1:]
    changed = 0
    for path in catalog_documents():
        block = missing(path)
        if not block:
            continue
        text = path.read_text()
        if "@prefix foaf:" not in text:
            head, sep, rest = text.rpartition("@prefix")
            line_end = rest.index("\n") + 1
            text = head + sep + rest[:line_end] + "@prefix foaf:    <http://xmlns.com/foaf/0.1/> .\n" + rest[line_end:]
        text = (text.rstrip("\n") + "\n\n# Identifiers that FAIR tests look for: the canonical IRI and the address on the website.\n"
                + block + "\n")
        Graph().parse(data=text, format="turtle")  # stop before writing a file that would not parse
        if not dry_run:
            path.write_text(text)
        changed += 1
        print(f"{'would add' if dry_run else 'added'} identifiers to {path.relative_to(ROOT)}")
    print(f"{changed} of {len(catalog_documents())} catalog documents {'would change' if dry_run else 'changed'}")


if __name__ == "__main__":
    main()
