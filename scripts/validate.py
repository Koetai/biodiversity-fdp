"""Parse every Turtle file under fdp/ and check the FDP/DCAT shape we rely on."""
import glob, sys
from rdflib import Graph, Namespace, RDF

DCAT = Namespace("http://www.w3.org/ns/dcat#")
DCT = Namespace("http://purl.org/dc/terms/")
FDP = Namespace("https://w3id.org/fdp/fdp-o#")

errors, merged = [], Graph()
for path in sorted(glob.glob("fdp/**/*.ttl", recursive=True)):
    g = Graph()
    try:
        g.parse(path, format="turtle")
    except Exception as e:
        errors.append(f"{path}: parse error: {e}")
        continue
    merged += g
    print(f"ok  {path}  ({len(g)} triples)")

for d in merged.subjects(RDF.type, DCAT.Distribution):
    if not merged.value(d, DCAT.accessURL):
        errors.append(f"{d}: distribution without dcat:accessURL")
    if not merged.value(d, DCT.type):
        errors.append(f"{d}: distribution without access-method dcterms:type")
for ds in merged.subjects(RDF.type, DCAT.Dataset):
    if not list(merged.objects(ds, DCAT.distribution)):
        errors.append(f"{ds}: dataset without distributions")
    for dist in merged.objects(ds, DCAT.distribution):
        if (dist, RDF.type, DCAT.Distribution) not in merged:
            errors.append(f"{ds}: dangling distribution {dist}")
for s, o in merged.subject_objects(DCAT.accessService):
    if (o, RDF.type, DCAT.DataService) not in merged:
        errors.append(f"{s}: dangling accessService {o}")

n = lambda t: len(set(merged.subjects(RDF.type, t)))
print(f"\n{n(DCAT.Catalog)} catalogs, {n(DCAT.Dataset)} datasets, {n(DCAT.Distribution)} distributions, {n(DCAT.DataService)} services")
print("\n".join(errors) or "no problems found")
sys.exit(1 if errors else 0)
