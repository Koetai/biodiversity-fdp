'use strict';
// Static FDP browser: fetches the index Turtle, follows rdfs:seeAlso to every
// sub-catalog, parses everything client-side with N3.js and renders
// index → catalog → dataset → distributions. No server, no build step.
//
// ?index=<url> browses another FDP laid out the same way.

const NS = {
  rdf:  'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
  rdfs: 'http://www.w3.org/2000/01/rdf-schema#',
  dcat: 'http://www.w3.org/ns/dcat#',
  dct:  'http://purl.org/dc/terms/',
  foaf: 'http://xmlns.com/foaf/0.1/',
  prov: 'http://www.w3.org/ns/prov#',
  skos: 'http://www.w3.org/2004/02/skos/core#',
  fdp:  'https://w3id.org/fdp/fdp-o#',
};
const IANA = 'https://www.iana.org/assignments/media-types/';
const EU_FILE_TYPE = 'http://publications.europa.eu/resource/authority/file-type/';
const ORDERED = new Set([NS.fdp + 'hasCatalog', NS.dcat + 'dataset', NS.dcat + 'distribution', NS.dcat + 'accessService']);

const INDEX = new URLSearchParams(location.search).get('index') || 'fdp/biodiversity-index/catalog.ttl';
const INDEX_IS_LOCAL = !/^https?:\/\//i.test(INDEX);

const { namedNode } = N3.DataFactory;
const store = new N3.Store();
const order = new Map();      // IRI → position of first mention in a list, to keep Turtle order
const sources = new Map();    // file IRI → Turtle text
let rawBase = null;           // canonical prefix that maps to this site's root (local mode)
let repo = null;              // { org, name, branch, path } when the index lives on raw.githubusercontent.com
let indexModel = null;
let catalogs = [];
let failures = [];
let methodFilter = null;

const $ = id => document.getElementById(id);
const esc = s => s == null ? '' : String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const safeUrl = u => (/^https?:\/\//i.test(u || '') ? u : null);
const link = (u, text, cls) => safeUrl(u) ? `<a href="${esc(u)}" target="_blank" rel="noopener"${cls ? ` class="${cls}"` : ''}>${esc(text)}</a>` : '';
const localName = iri => (iri || '').replace(/[\/#]$/, '').split(/[\/#]/).pop();

// ── Loading ─────────────────────────────────────────────────────────────────

function fetchLocation(iri) {
  // In local mode the canonical (raw GitHub) IRIs are served from this site's root.
  if (rawBase && iri.startsWith(rawBase)) return iri.slice(rawBase.length);
  return iri;
}

async function load(iri) {
  if (sources.has(iri)) return;
  const res = await fetch(fetchLocation(iri), { headers: { Accept: 'text/turtle' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${iri}`);
  const text = await res.text();
  sources.set(iri, text);
  const graph = namedNode(iri);
  await new Promise((resolve, reject) => {
    new N3.Parser({ baseIRI: iri }).parse(text, (err, q) => {
      if (err) return reject(new Error(`${localName(iri.replace(/\/catalog\.ttl$/, ''))}: ${err.message}`));
      if (!q) return resolve();
      store.addQuad(q.subject, q.predicate, q.object, graph);
      if (ORDERED.has(q.predicate.value) && !order.has(q.object.value)) order.set(q.object.value, order.size);
    });
  });
}

const objects = (s, p) => store.getObjects(namedNode(s), namedNode(p), null);
function lit(s, p) {
  const os = objects(s, p);
  if (!os.length) return null;
  return (os.find(o => o.language === 'en') || os.find(o => !o.language) || os[0]).value;
}
const iri = (s, p) => (objects(s, p).find(o => o.termType === 'NamedNode') || {}).value || null;
const iris = (s, p) => objects(s, p).filter(o => o.termType === 'NamedNode').map(o => o.value)
  .sort((a, b) => (order.has(a) ? order.get(a) : 1e9) - (order.has(b) ? order.get(b) : 1e9));
const hasType = (s, t) => store.has(namedNode(s), namedNode(NS.rdf + 'type'), namedNode(t));
const value = (s, p) => lit(s, p) || iri(s, p);

async function init() {
  const indexIri = INDEX_IS_LOCAL ? new URL(INDEX, location.href).href : INDEX;
  await load(indexIri);

  // The FDP root of the index file: a metadata service listing catalogs.
  const roots = store.getSubjects(namedNode(NS.fdp + 'hasCatalog'), null, namedNode(indexIri)).map(t => t.value);
  const root = roots[0];
  if (!root) throw new Error('No fdp:hasCatalog found in ' + INDEX);

  // Canonical IRI of the index file, e.g. https://raw.githubusercontent.com/org/repo/main/fdp/…/catalog.ttl
  const canonicalIndex = root.endsWith('/') ? root + 'catalog.ttl' : root;
  if (INDEX_IS_LOCAL && canonicalIndex.endsWith(INDEX)) {
    rawBase = canonicalIndex.slice(0, -INDEX.length);
    // Re-key the already-loaded index under its canonical IRI so links and edits use it.
    sources.set(canonicalIndex, sources.get(indexIri));
    for (const q of store.getQuads(null, null, null, namedNode(indexIri)))
      store.addQuad(q.subject, q.predicate, q.object, namedNode(canonicalIndex));
  }
  const m = canonicalIndex.match(/^https:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/([^/]+)\/(.+)$/);
  if (m) repo = { org: m[1], name: m[2], branch: m[3] };

  indexModel = {
    iri: root, file: canonicalIndex,
    title: lit(root, NS.dct + 'title'), description: lit(root, NS.dct + 'description'),
    modified: lit(root, NS.dct + 'modified'),
    publisher: lit(iri(root, NS.dct + 'publisher') || '', NS.foaf + 'name'),
  };

  // Sub-catalog files (rdfs:seeAlso on each fdp:hasCatalog entry) and helper vocabularies
  // (rdfs:seeAlso on the root that point to .ttl files, e.g. the access-method scheme).
  const refs = iris(root, NS.fdp + 'hasCatalog').map(c => ({ ref: c, file: iri(c, NS.rdfs + 'seeAlso'), title: lit(c, NS.dct + 'title') }));
  const vocabFiles = iris(root, NS.rdfs + 'seeAlso').filter(u => /\.ttl$/.test(u));
  const results = await Promise.allSettled([...refs.filter(r => r.file).map(r => load(r.file)), ...vocabFiles.map(load)]);
  failures = results.filter(r => r.status === 'rejected').map(r => r.reason.message);

  catalogs = refs.map(r => buildCatalog(r)).filter(Boolean);
  renderChrome();
  route();
}

// ── Model ───────────────────────────────────────────────────────────────────

function buildCatalog({ ref, file, title }) {
  const graph = file ? namedNode(file) : null;
  if (file && !sources.has(file)) return { key: localName(ref), ref, file, title, missing: true, datasets: [] };
  // The dcat:Catalog in that file that actually lists datasets.
  const cat = store.getSubjects(namedNode(NS.dcat + 'dataset'), null, graph).map(t => t.value)
    .find(s => hasType(s, NS.dcat + 'Catalog')) || ref;
  const key = file ? localName(file.replace(/\/catalog\.ttl$/, '')) : localName(ref);
  return {
    key, ref, file, iri: cat,
    title: lit(cat, NS.dct + 'title') || title,
    description: lit(cat, NS.dct + 'description'),
    landingPage: iri(cat, NS.dcat + 'landingPage'),
    license: iri(cat, NS.dct + 'license'),
    publisher: lit(iri(cat, NS.dct + 'publisher') || '', NS.foaf + 'name'),
    datasets: iris(cat, NS.dcat + 'dataset').map(buildDataset),
  };
}

function buildDataset(ds) {
  return {
    iri: ds, id: localName(ds),
    title: lit(ds, NS.dct + 'title'), description: lit(ds, NS.dct + 'description'),
    version: lit(ds, NS.dct + 'version'), issued: lit(ds, NS.dct + 'issued'), modified: lit(ds, NS.dct + 'modified'),
    identifier: value(ds, NS.dct + 'identifier'), landingPage: iri(ds, NS.dcat + 'landingPage'),
    license: iri(ds, NS.dct + 'license'), derivedFrom: iris(ds, NS.prov + 'wasDerivedFrom'),
    distributions: iris(ds, NS.dcat + 'distribution').map(buildDistribution),
  };
}

function buildDistribution(d) {
  const type = iri(d, NS.dct + 'type');
  const media = value(d, NS.dcat + 'mediaType');
  const format = value(d, NS.dct + 'format');
  return {
    iri: d, id: localName(d),
    title: lit(d, NS.dct + 'title'), description: lit(d, NS.dct + 'description'),
    type, typeLabel: type ? (lit(type, NS.skos + 'prefLabel') || localName(type)) : null,
    mediaType: media && media.startsWith(IANA) ? media.slice(IANA.length) : media,
    format: format && format.startsWith(EU_FILE_TYPE) ? format.slice(EU_FILE_TYPE.length) : format,
    accessURL: iri(d, NS.dcat + 'accessURL'), downloadURL: iri(d, NS.dcat + 'downloadURL'),
    license: iri(d, NS.dct + 'license'), identifier: value(d, NS.dct + 'identifier'),
    derivedFrom: iris(d, NS.prov + 'wasDerivedFrom'),
    services: iris(d, NS.dcat + 'accessService').map(s => ({
      iri: s, title: lit(s, NS.dct + 'title'),
      endpointURL: iri(s, NS.dcat + 'endpointURL'),
      endpointDescription: iri(s, NS.dcat + 'endpointDescription'),
      conformsTo: iri(s, NS.dct + 'conformsTo'),
    })),
  };
}

// Where does an IRI live in the model? Used for prov:wasDerivedFrom links across catalogs.
function locate(target) {
  for (const c of catalogs) for (const ds of c.datasets) {
    if (ds.iri === target) return { c, ds, label: ds.title };
    const d = ds.distributions.find(x => x.iri === target);
    if (d) return { c, ds, label: d.title };
  }
  return null;
}

// ── Icons (monochrome, stroke = currentColor) ───────────────────────────────

// A mangrove: lobed crown, arching prop roots standing in water (cf. the Mangal network).
const LOGO = `<svg viewBox="0 0 24 24" aria-hidden="true">
  <g fill="currentColor"><circle cx="7" cy="7.2" r="3.6"/><circle cx="12" cy="5.4" r="4.2"/><circle cx="17" cy="7.2" r="3.6"/><rect x="5" y="7" width="14" height="3.6" rx="1.8"/></g>
  <path d="M12 10V20.5M12 11.8C8 11.8 4.6 14 3.2 20.5M12 11.8C16 11.8 19.4 14 20.8 20.5M11.6 13.4C9.4 14 7.6 16.4 7.2 20.5M12.4 13.4C14.6 14 16.4 16.4 16.8 20.5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" fill="none"/>
  <path d="M1 17.4H23V23H1Z" fill="currentColor" opacity=".18"/></svg>`;

const ICON_PATHS = {
  'web-portal': '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.5 3.8 5.5 3.8 9s-1.3 6.5-3.8 9c-2.5-2.5-3.8-5.5-3.8-9S9.5 5.5 12 3z"/>',
  'rest-api': '<path d="M8 4c-2 0-3 1-3 3v2c0 1.5-.7 2.5-2 3 1.3.5 2 1.5 2 3v2c0 2 1 3 3 3M16 4c2 0 3 1 3 3v2c0 1.5.7 2.5 2 3-1.3.5-2 1.5-2 3v2c0 2-1 3-3 3"/>',
  'sparql-endpoint': '<circle cx="5" cy="6" r="2.5"/><circle cx="19" cy="6" r="2.5"/><circle cx="12" cy="18" r="2.5"/><path d="M7.5 6h9M6.3 8.2l4.4 7.6M17.7 8.2l-4.4 7.6"/>',
  'bulk-download': '<path d="M12 3v12M7 10l5 5 5-5M4 17v3h16v-3"/>',
  'cloud-object-storage': '<path d="M7 18a5 5 0 0 1-.6-9.96A6 6 0 0 1 18 9a4.5 4.5 0 0 1-.5 9H7z"/>',
  'darwin-core-archive': '<path d="M3 4h18v4H3zM5 8v12h14V8M10 12h4"/>',
  'rdf-dump': '<path d="M14 3H6v18h12V7l-4-4zM14 3v4h4"/><circle cx="9.5" cy="14" r="1.3"/><circle cx="14.5" cy="11.5" r="1.3"/><circle cx="14.5" cy="16.5" r="1.3"/>',
  'source-repository': '<circle cx="6" cy="5" r="2.2"/><circle cx="6" cy="19" r="2.2"/><circle cx="18" cy="8" r="2.2"/><path d="M6 7.2v9.6M18 10.2c0 4-6 3-11 7"/>',
  'aggregator-mirror': '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/>',
  'oai-pmh': '<path d="M20 11a8 8 0 0 0-14.6-4.5M4 4v3h3M4 13a8 8 0 0 0 14.6 4.5M20 20v-3h-3"/>',
  'sql-query': '<ellipse cx="12" cy="5.5" rx="7.5" ry="2.5"/><path d="M4.5 5.5v13c0 1.4 3.4 2.5 7.5 2.5s7.5-1.1 7.5-2.5v-13M4.5 12c0 1.4 3.4 2.5 7.5 2.5s7.5-1.1 7.5-2.5"/>',
  'change-feed': '<path d="M3 12h4l3-7 4 14 3-7h4"/>',
};
const icon = type => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON_PATHS[localName(type)] || '<circle cx="12" cy="12" r="8"/>'}</svg>`;

// ── Flattened view for search and method counts ────────────────────────────

function allDistributions() {
  return catalogs.flatMap(c => c.datasets.flatMap(ds => ds.distributions.map(d => ({ c, ds, d }))));
}
function methodsInUse() {
  const by = new Map();
  for (const x of allDistributions()) {
    if (!x.d.type) continue;
    if (!by.has(x.d.type)) by.set(x.d.type, { type: x.d.type, label: x.d.typeLabel, items: [] });
    by.get(x.d.type).items.push(x);
  }
  return [...by.values()].sort((a, b) => b.items.length - a.items.length);
}

// ── Routing ─────────────────────────────────────────────────────────────────
// #/                         index
// #/search?q=…&m=<method>    search over all distributions
// #/<catalog>                catalog
// #/<catalog>/<dataset>      dataset

window.addEventListener('hashchange', route);
function route() {
  const [path, query] = location.hash.replace(/^#\/?/, '').split('?');
  const [key, ds] = path.split('/').filter(Boolean).map(decodeURIComponent);
  if (key === 'search') showSearch(new URLSearchParams(query || ''));
  else if (key && ds) showDataset(key, ds);
  else if (key) showCatalog(key);
  else showIndex();
  window.scrollTo(0, 0);
}
const hrefFor = (...parts) => '#/' + parts.map(encodeURIComponent).join('/');
const searchHref = (q, m) => '#/search?' + new URLSearchParams(Object.entries({ q: q || '', m: m ? localName(m) : '' }).filter(([, v]) => v));

// ── Chrome ──────────────────────────────────────────────────────────────────

function renderChrome() {
  const name = (indexModel.title || 'FAIR Data Point').split(' — ')[0];
  document.title = name;
  const [word, ...rest] = name.split(' ');
  $('lockup').innerHTML = `${LOGO}<span>${esc(word)}${rest.length ? ` <span class="sub">${esc(rest.join(' '))}</span>` : ''}</span>`;
  $('topnav').innerHTML = `<a href="#catalogs">Catalogs</a><a href="${searchHref()}">Search</a>` +
    (repo ? link(`https://github.com/${repo.org}/${repo.name}#readme`, 'About') : '');
  $('topright').innerHTML = (repo ? `<a class="btn ghost" href="https://github.com/${esc(repo.org)}/${esc(repo.name)}" target="_blank" rel="noopener">GitHub</a>` : '') +
    `<a class="btn" href="${esc(indexModel.file)}" target="_blank" rel="noopener">Turtle</a>`;
  $('footer').innerHTML = `<div><div class="lockup">${LOGO}<span>${esc(name)}</span></div>
      A static FAIR Data Point, rendered in your browser with <a href="https://github.com/rdfjs/N3.js" target="_blank" rel="noopener">N3.js</a>.</div>
    <div>${indexModel.publisher ? 'Curated by ' + esc(indexModel.publisher) + '<br>' : ''}
      Browse another FDP with <span class="mono">?index=&lt;url&gt;</span></div>`;
  // "Catalogs" in the top bar scrolls on the index, navigates elsewhere.
  $('topnav').querySelector('a[href="#catalogs"]').onclick = e => {
    e.preventDefault();
    if (location.hash.replace(/^#\/?/, '')) { location.hash = ''; setTimeout(() => scrollToId('catalogs'), 0); }
    else scrollToId('catalogs');
  };
}
const scrollToId = id => { const el = $(id); if (el) el.scrollIntoView({ behavior: 'smooth' }); };

function crumbs(parts) {
  return `<nav class="crumbs" aria-label="Breadcrumb"><a href="#">Index</a>` +
    parts.map(p => `<span>/</span>${p.href ? `<a href="${p.href}">${esc(p.label)}</a>` : `<span>${esc(p.label)}</span>`}`).join('') + '</nav>';
}

function fileButtons(file) {
  if (!file) return '';
  const out = [`<a class="btn ghost" href="${esc(file)}" target="_blank" rel="noopener">Turtle file</a>`];
  if (repo && file.startsWith(`https://raw.githubusercontent.com/${repo.org}/${repo.name}/${repo.branch}/`)) {
    const path = file.split(`/${repo.branch}/`).slice(1).join(`/${repo.branch}/`);
    const gh = `https://github.com/${repo.org}/${repo.name}`;
    out.push(`<a class="btn ghost" href="${esc(`${gh}/edit/${repo.branch}/${path}`)}" target="_blank" rel="noopener">Edit on GitHub</a>`);
    out.push(`<a class="btn ghost" href="${esc(`${gh}/commits/${repo.branch}/${path}`)}" target="_blank" rel="noopener">History</a>`);
  }
  return `<div class="actions">${out.join('')}</div>`;
}

// ── Index ───────────────────────────────────────────────────────────────────

function searchForm(q, m, methods, cls) {
  return `<form class="search ${cls || ''}" id="search" role="search">
    <input id="q" type="search" value="${esc(q || '')}" placeholder="Search sources, APIs, dumps, endpoints…" aria-label="Search">
    <select id="m" aria-label="Access method"><option value="">All methods</option>
      ${methods.map(x => `<option value="${esc(localName(x.type))}"${localName(x.type) === m ? ' selected' : ''}>${esc(x.label)}</option>`).join('')}</select>
    <button class="btn" type="submit">Search</button>
  </form>`;
}
function wireSearch() {
  $('search').onsubmit = e => { e.preventDefault(); location.hash = searchHref($('q').value.trim(), $('m').value); };
}

function showIndex() {
  const all = allDistributions();
  const methods = methodsInUse();

  let html = `<div class="hero-band"><div class="wrap"><div class="hero">
      <div class="mark">${LOGO}</div>
      <h1>Every way to get <em>biodiversity</em> data</h1>
      <p>${catalogs.length} infrastructures and ${all.length} ways to reach them, from portals and APIs to SPARQL endpoints, bulk dumps and cloud buckets, described as one FAIR Data Point.</p>
      ${searchForm('', '', methods)}
    </div></div></div><div class="wrap">`;

  if (failures.length) html += `<div class="notice error">Could not load: ${failures.map(esc).join('<br>')}</div>`;

  html += `<section><div class="section-head"><h2>Ways to get data</h2><span class="count">by access method</span></div><div class="tiles">` +
    methods.map(m => `<a class="tile" href="${searchHref('', m.type)}"><span class="disc">${icon(m.type)}</span>
      <span><span class="tile-label">${esc(m.label)}</span><br><span class="tile-n">${m.items.length} across ${new Set(m.items.map(x => x.c.key)).size} catalogs</span></span></a>`).join('') +
    '</div></section>';

  html += `<section id="catalogs"><div class="section-head"><h2>Catalogs</h2>
    <span class="count">${catalogs.length} catalogs${indexModel.modified ? ' · updated ' + esc(indexModel.modified) : ''}</span></div><div class="blocks">`;
  for (const c of catalogs) {
    const n = c.datasets.length, d = c.datasets.reduce((s, x) => s + x.distributions.length, 0);
    const types = [...new Set(c.datasets.flatMap(x => x.distributions.map(y => y.typeLabel)).filter(Boolean))];
    html += `<a class="block" href="${hrefFor(c.key)}">
      <h3>${esc(c.title || c.key)}</h3>
      <p>${c.missing ? 'Catalog file could not be loaded.' : esc(c.description || '')}</p>
      <div class="stats">${n} dataset${n !== 1 ? 's' : ''} · ${d} ways to get it</div>
      <div class="chips">${types.map(t => `<span class="chip">${esc(t)}</span>`).join('')}</div>
    </a>`;
  }
  html += '</div></section>' + turtleSection(indexModel.file) + '</div>';
  $('view').innerHTML = html;
  wireSearch();
  wireTurtle(indexModel.file);
}

const shortTitle = t => (t || '').split(' — ')[0];

// ── Search ──────────────────────────────────────────────────────────────────

function showSearch(params) {
  const q = (params.get('q') || '').trim();
  const m = params.get('m') || '';
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  const hits = allDistributions().filter(({ c, ds, d }) => {
    if (m && localName(d.type) !== m) return false;
    const hay = [c.title, ds.title, ds.version, d.title, d.description, d.typeLabel, d.mediaType, d.format,
                 d.accessURL, ...d.services.map(s => (s.title || '') + ' ' + (s.endpointURL || ''))].join(' ').toLowerCase();
    return terms.every(t => hay.includes(t));
  });
  const methods = methodsInUse();
  const label = m ? (methods.find(x => localName(x.type) === m) || {}).label || m : '';

  let html = crumbs([{ label: 'Search' }]) + `<div class="page-head">
    <div class="eyebrow">Search</div>
    <h1>${q ? `“${esc(q)}”` : label ? esc(label) : 'All ways to get data'}</h1>
    ${searchForm(q, m, methods, 'left')}
  </div>
  <section><div class="section-head"><h2>Results</h2><span class="count">${hits.length} of ${allDistributions().length}</span></div>
  <div class="rows">${hits.map(h => distRow(h.d, h)).join('') || '<p class="row-desc" style="padding:18px 0">Nothing matches. Try fewer words.</p>'}</div></section>`;
  $('view').innerHTML = '<div class="wrap">' + html + '</div>';
  wireSearch();
}

// ── Catalog ─────────────────────────────────────────────────────────────────

function showCatalog(key) {
  const c = catalogs.find(x => x.key === key);
  if (!c) { $('view').innerHTML = '<div class="wrap">' + crumbs([]) + '<div class="notice">Unknown catalog.</div></div>'; return; }
  const meta = [link(c.landingPage, 'Website ↗'), link(c.license, 'Licence ↗'), c.publisher ? 'Publisher: ' + esc(c.publisher) : ''].filter(Boolean);
  let html = crumbs([{ label: shortTitle(c.title) || key }]) + `<div class="page-head">
    <div class="eyebrow">Catalog</div><h1>${esc(c.title || key)}</h1><p>${esc(c.description || '')}</p>
    ${meta.length ? `<div class="meta">${meta.join('')}</div>` : ''}${fileButtons(c.file)}</div>`;
  html += `<section><div class="section-head"><h2>Datasets</h2><span class="count">${c.datasets.length}</span></div><div class="rows">`;
  for (const ds of c.datasets) {
    const n = ds.distributions.length;
    const dates = [ds.issued && 'Issued ' + ds.issued, ds.modified && 'Modified ' + ds.modified].filter(Boolean);
    html += `<a class="row" href="${hrefFor(c.key, ds.id)}">
      <div class="row-side"><span class="label">Dataset</span><span class="version">${esc(ds.version || ds.id)}</span></div>
      <div><div class="row-title">${esc(ds.title || ds.id)}</div><div class="row-desc">${esc(ds.description || '')}</div>
        <div class="row-meta"><span>${n} way${n !== 1 ? 's' : ''} to get it</span>${dates.map(d => `<span>${esc(d)}</span>`).join('')}</div></div>
    </a>`;
  }
  html += '</div></section>' + turtleSection(c.file);
  $('view').innerHTML = '<div class="wrap">' + html + '</div>';
  wireTurtle(c.file);
}

// ── Dataset ─────────────────────────────────────────────────────────────────

function showDataset(key, id) {
  const c = catalogs.find(x => x.key === key);
  const ds = c && c.datasets.find(d => d.id === id);
  if (!ds) { $('view').innerHTML = '<div class="wrap">' + crumbs([]) + '<div class="notice">Unknown dataset.</div></div>'; return; }

  const meta = [];
  if (ds.issued) meta.push('Issued ' + esc(ds.issued));
  if (ds.modified) meta.push('Modified ' + esc(ds.modified));
  if (ds.identifier) meta.push(safeUrl(ds.identifier) ? link(ds.identifier, ds.identifier) : esc(ds.identifier));
  if (ds.license) meta.push(link(ds.license, 'Licence ↗'));
  if (ds.landingPage) meta.push(link(ds.landingPage, 'Website ↗'));
  meta.push(...derivedLinks(ds.derivedFrom));

  const dists = ds.distributions;
  const methods = [...new Map(dists.filter(d => d.type).map(d => [d.type, d.typeLabel])).entries()];
  let html = crumbs([{ label: shortTitle(c.title) || key, href: hrefFor(key) }, { label: ds.version || ds.id }]) +
    `<div class="page-head"><div class="eyebrow">Dataset · ${esc(ds.version || ds.id)}</div>
     <h1>${esc(ds.title || ds.id)}</h1><p>${esc(ds.description || '')}</p>
     ${meta.length ? `<div class="meta">${meta.map(x => `<span>${x}</span>`).join('')}</div>` : ''}</div>
    <div class="tabs" id="filters" role="tablist"><button class="on" data-m="">All<span class="n">${dists.length}</span></button>` +
    methods.map(([t, l]) => `<button data-m="${esc(t)}">${esc(l)}<span class="n">${dists.filter(d => d.type === t).length}</span></button>`).join('') +
    `</div><div class="rows" id="dists" style="border-top:none"></div>`;
  $('view').innerHTML = '<div class="wrap">' + html + '</div>';

  let filter = null;
  const render = () => { $('dists').innerHTML = dists.filter(d => !filter || d.type === filter).map(d => distRow(d)).join(''); };
  $('filters').querySelectorAll('button').forEach(b => b.onclick = () => {
    filter = b.dataset.m || null;
    $('filters').querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
    render();
  });
  render();
}

function derivedLinks(list) {
  return list.map(t => {
    const hit = locate(t);
    return hit ? `Derived from <a href="${hrefFor(hit.c.key, hit.ds.id)}">${esc(hit.label)}</a>`
               : 'Derived from ' + (safeUrl(t) ? link(t, localName(t)) : esc(t));
  });
}

// One distribution as a list row. `ctx` (search results) adds where it lives.
function distRow(d, ctx) {
  const how = (d.description || '').replace(/^How to get it:\s*/i, '');
  const fmt = [...new Set([d.mediaType, d.format].filter(Boolean))].join(' · ');
  const title = safeUrl(d.accessURL)
    ? `<a href="${esc(d.accessURL)}" target="_blank" rel="noopener">${esc(d.title || d.id)} ↗</a>` : esc(d.title || d.id);
  const links = [link(d.downloadURL, 'Download ↓'), d.license ? link(d.license, 'Licence ↗') : ''].filter(Boolean);
  const where = ctx ? [`<a href="${hrefFor(ctx.c.key)}">${esc(shortTitle(ctx.c.title))}</a>`,
                       `<a href="${hrefFor(ctx.c.key, ctx.ds.id)}">${esc(ctx.ds.title)}</a>`] : [];
  const services = d.services.map(s => s.endpointURL
    ? `<div class="endpoint mono"><div class="ep-title">${esc(s.title || 'Service')}</div>${esc(s.endpointURL)}
        <div class="ep-links">${[link(s.endpointDescription, 'Docs ↗'), link(s.conformsTo, 'Protocol ↗')].filter(Boolean).join('')}</div></div>`
    : `<div class="endpoint mono">${esc(localName(s.iri))}</div>`).join('');
  return `<div class="row">
    <div class="row-side"><span class="label" style="display:flex;gap:6px;align-items:center">
      <span style="width:14px;height:14px;display:inline-flex">${icon(d.type)}</span>${esc(d.typeLabel || 'Distribution')}</span>
      ${fmt ? `<span class="fmt mono">${esc(fmt)}</span>` : ''}</div>
    <div><div class="row-title">${title}</div>
      ${how ? `<div class="row-desc">${esc(how)}</div>` : ''}
      ${services}
      ${(where.length || links.length || d.derivedFrom.length) ? `<div class="row-meta">${[...where, ...derivedLinks(d.derivedFrom), ...links].map(x => `<span>${x}</span>`).join('')}</div>` : ''}
    </div></div>`;
}

// ── Turtle source ───────────────────────────────────────────────────────────

function turtleSection() {
  return `<section><div class="tabs" id="ttl-tabs"><button class="on" data-tab="hide">Summary</button><button data-tab="raw">Turtle source</button></div>
          <div id="raw-box" hidden></div></section>`;
}
function wireTurtle(file) {
  $('ttl-tabs').querySelectorAll('button').forEach(b => b.onclick = () => {
    $('ttl-tabs').querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
    $('raw-box').hidden = b.dataset.tab !== 'raw';
    if (b.dataset.tab === 'raw') $('raw-box').innerHTML = `<pre class="ttl">${esc(sources.get(file) || 'Not loaded.')}</pre>`;
  });
}

init().catch(e => {
  $('view').innerHTML = `<div class="wrap"><div class="notice error">Could not load the FAIR Data Point: ${esc(e.message)}</div></div>`;
});
