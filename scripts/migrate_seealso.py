#!/usr/bin/env python3
"""Replace rdfs:seeAlso in an existing FDP, once. Running it again changes nothing.

    python3 scripts/migrate_seealso.py [--dry-run]

"Update engine" never touches fdp/, so an instance made before this change runs this itself:

* a catalog gets a hash IRI in its own document: <.../x-fdp/catalog> becomes <.../x-fdp/catalog.ttl#catalog>;
* fdp:hasCatalog on the index names that IRI directly, and the stub on the index goes. A licence that
  only the stub had moves to the catalog;
* an index entry for a live FDP stays, with dcterms:source instead of rdfs:seeAlso;
* access-method terms move from .../access-methods#x to .../access-methods.ttl#x, so the link from the
  root to the vocabulary goes;
* the root links contributors.ttl with dcterms:hasPart.

Those are the uses this template generates. Any other rdfs:seeAlso was written by a curator and can
mean anything (documentation, a related catalog, ...), so it is left alone and listed at the end:
choose a predicate that says what the link is, such as dcterms:references or dcterms:relation.

The files are edited as text, so comments and layout stay as they are.
"""
import datetime
import re
import sys
from pathlib import Path

from rdflib import Graph, Namespace, URIRef
from rdflib.namespace import DCTERMS, RDFS

sys.path.insert(0, str(Path(__file__).resolve().parent))
from fdpconfig import BASE_IRI, INDEX_FOLDER, ROOT  # noqa: E402

FDP = Namespace("https://w3id.org/fdp/fdp-o#")
FDP_DIR = ROOT / "fdp"
INDEX = FDP_DIR / INDEX_FOLDER / "catalog.ttl"
ROOT_IRI = URIRef(f"{BASE_IRI}{INDEX_FOLDER}/")
VOCAB_DOC = f"{BASE_IRI}vocab/access-methods.ttl"

# Strings, comments and IRIs are matched first, so a term is only replaced where it is a term.
OPAQUE = r'"""(?:.|\n)*?"""|\'\'\'(?:.|\n)*?\'\'\'|"(?:\\.|[^"\\\n])*"|\'(?:\\.|[^\'\\\n])*\'|#[^\n]*|<[^>\s]*>'


def replace_term(text, term, new):
    """Replace a prefixed name such as :catalog, but not :catalog-x, and not inside strings or comments."""
    pattern = re.compile(rf"{OPAQUE}|(?<![\w:.-])(?P<term>{re.escape(term)})(?![\w-]|\.[\w-])")
    return pattern.sub(lambda m: new if m.group("term") else m.group(0), text)


def default_prefix(text):
    m = re.search(r"^@prefix\s+:\s*<([^>]*)>", text, re.M)
    return m.group(1) if m else None


def term_for(text, iri):
    """How an IRI is written in this file with the default prefix, or None if it is not abbreviated."""
    prefix = default_prefix(text)
    return ":" + iri[len(prefix):] if prefix and iri.startswith(prefix) and iri != prefix else None


def remove_block(text, term):
    """Remove the statement that starts a line with this term, up to the first line ending in a dot."""
    return re.sub(rf"^{re.escape(term)}\b(?:[^\n]*\n)*?[^\n]*\.[ \t]*(?:\n+|\Z)", "", text, count=1, flags=re.M)


def migrate_catalog_iris(files):
    """<x-fdp/catalog> becomes <x-fdp/catalog.ttl#catalog> in every file; :catalog in the catalog's own file."""
    moved = {}
    for path in sorted(FDP_DIR.glob("*/catalog.ttl")):
        folder = path.parent.name
        doc = f"{BASE_IRI}{folder}/catalog.ttl"
        old = f"{BASE_IRI}{folder}/catalog"
        for p, text in files.items():
            files[p] = text.replace(f"<{old}>", f"<{doc}#catalog>")
        if default_prefix(files[path]) == f"{BASE_IRI}{folder}/":
            files[path] = replace_term(files[path], ":catalog", f"<{doc}#catalog>")
        moved[doc] = path
    return moved


def add_licence(text, catalog, licence):
    """Give the catalog a dcterms:license, as the first statement after its rdf:type."""
    pattern = rf"(^<{re.escape(catalog)}>\s+a dcat:Catalog\s*;[ \t]*\n)"
    return re.sub(pattern, lambda m: f"{m.group(1)}    dcterms:license <{licence}> ;\n", text, count=1, flags=re.M)


def migrate_index(files, documents):
    """Replace the stubs on the index, and the root's links to the vocabulary and contributors."""
    text = files[INDEX]
    g = Graph().parse(data=text, format="turtle")
    notes = []
    for ref in list(g.objects(ROOT_IRI, FDP.hasCatalog)):
        target = g.value(ref, RDFS.seeAlso)
        if target is None:
            continue
        term = term_for(text, str(ref))
        if str(target) in documents and term:
            catalog = f"{target}#catalog"
            licence = g.value(ref, DCTERMS.license)
            path = documents[str(target)]
            catalog_graph = Graph().parse(data=files[path], format="turtle")
            if licence and catalog_graph.value(URIRef(catalog), DCTERMS.license) is None:
                files[path] = add_licence(files[path], catalog, licence)
                notes.append(f"moved the licence of {term} to {path.relative_to(ROOT)}")
            text = remove_block(text, term)
            text = replace_term(text, term, f"<{catalog}>")
        else:  # a live FDP, or a catalog document elsewhere
            text = text.replace(f"rdfs:seeAlso <{target}>", f"dcterms:source <{target}>", 1)
            notes.append(f"{term or ref}: dcterms:source <{target}>")

    def root_links(m):
        keep = [t for t in re.findall(r"<([^>]*)>", m.group("objects")) if t != VOCAB_DOC]
        part = [t for t in keep if t.endswith("/contributors.ttl")]
        rest = [t for t in keep if t not in part]
        lines = []
        if part:
            lines.append(f"{m.group('indent')}dcterms:hasPart <{part[0]}> ;\n")
        if rest:
            lines.append(m.group("indent") + "rdfs:seeAlso " + " , ".join(f"<{t}>" for t in rest) + " ;\n")
        return "".join(lines)

    text = re.sub(r"^(?P<indent>[ \t]*)rdfs:seeAlso\s+(?P<objects><[^>]*>(?:\s*,\s*<[^>]*>)*)\s*;[ \t]*\n",
                  root_links, text, count=1, flags=re.M)
    if text != files[INDEX]:
        today = datetime.date.today().isoformat()
        text = re.sub(r'(dcterms:modified ")\d{4}-\d{2}-\d{2}("\^\^xsd:date)', rf"\g<1>{today}\g<2>", text, count=1)
    files[INDEX] = text
    return notes


def remaining(files):
    """The rdfs:seeAlso statements still there, outside comments, as 'file:line'."""
    found = []
    for path, text in sorted(files.items()):
        for n, line in enumerate(text.splitlines(), 1):
            if "rdfs:seeAlso" in line and not line.lstrip().startswith("#"):
                found.append(f"{path.relative_to(ROOT)}:{n}: {line.strip()}")
    return found


def main():
    dry_run = "--dry-run" in sys.argv[1:]
    if not INDEX.is_file():
        sys.exit(f"{INDEX} not found")
    before = {p: p.read_text() for p in sorted(FDP_DIR.glob("**/*.ttl"))}
    files = {p: t.replace(f"{BASE_IRI}vocab/access-methods#", f"{VOCAB_DOC}#") for p, t in before.items()}
    documents = migrate_catalog_iris(files)
    notes = migrate_index(files, documents)

    # Nothing is written unless every file still parses.
    for path, text in files.items():
        try:
            Graph().parse(data=text, format="turtle")
        except Exception as e:  # noqa: BLE001 - report which file, change nothing
            sys.exit(f"Stopped, no file was changed: {path.relative_to(ROOT)} would not parse: {e}")
    changed = [p for p in files if files[p] != before[p]]
    if not dry_run:
        for p in changed:
            p.write_text(files[p])

    print(f"{'Would change' if dry_run else 'Changed'} {len(changed)} of {len(files)} Turtle files")
    for note in notes:
        print(f"  {note}")
    left = remaining(files)
    if left:
        print(f"\n{len(left)} rdfs:seeAlso left for you, because only a curator knows what the link means:")
        print("\n".join(f"  {x}" for x in left))
        print("Replace each with a predicate that says what it is, e.g. dcterms:references or dcterms:relation.")
    if changed and not dry_run:
        print("\nCheck the result with python3 scripts/validate.py and git diff, then commit.")


if __name__ == "__main__":
    main()
