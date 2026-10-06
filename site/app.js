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

// ── Routing ─────────────────────────────────────────────────────────────────

window.addEventListener('hashchange', route);
function route() {
  const [, key, ds] = location.hash.split('/').map(decodeURIComponent);
  methodFilter = null;
  if (key && ds) showDataset(key, ds);
  else if (key) showCatalog(key);
  else showIndex();
  window.scrollTo(0, 0);
}
const hrefFor = (...parts) => '#/' + parts.map(encodeURIComponent).join('/');

function crumbs(parts) {
  $('crumbs').innerHTML = '<a href="#">Index</a>' + parts.map(p =>
    '<span>›</span>' + (p.href ? `<a href="${p.href}">${esc(p.label)}</a>` : `<span class="current">${esc(p.label)}</span>`)).join('');
}

// ── Rendering ───────────────────────────────────────────────────────────────

function renderChrome() {
  document.title = indexModel.title || 'FAIR Data Point';
  $('brand-title').textContent = (indexModel.title || 'FAIR Data Point').split(' — ')[0];
  $('repo-label').textContent = repo ? `${repo.org}/${repo.name} · ${repo.branch}` : new URL(indexModel.file).host;
  $('nav').innerHTML = '<a href="#">Index</a>' +
    (repo ? link(`https://github.com/${repo.org}/${repo.name}`, 'Repository ↗') : '') +
    link(indexModel.file, 'Index Turtle ↗');
  $('footer').innerHTML = `Rendered in your browser from <span class="mono">${esc(indexModel.file)}</span>
    with <a href="https://github.com/rdfjs/N3.js" target="_blank" rel="noopener">N3.js</a>.
    Browse another FDP with <span class="mono">?index=&lt;url of its index catalog.ttl&gt;</span>.`;
}

function fileActions(file) {
  if (!file) return '';
  const parts = [link(file, 'Turtle file ↗')];
  if (repo && file.startsWith(`https://raw.githubusercontent.com/${repo.org}/${repo.name}/${repo.branch}/`)) {
    const path = file.split(`/${repo.branch}/`).slice(1).join(`/${repo.branch}/`);
    const gh = `https://github.com/${repo.org}/${repo.name}`;
    parts.push(link(`${gh}/edit/${repo.branch}/${path}`, 'Edit on GitHub ↗'));
    parts.push(link(`${gh}/commits/${repo.branch}/${path}`, 'History ↗'));
  }
  return `<div class="actions">${parts.join('')}</div>`;
}

function showIndex() {
  crumbs([]);
  const totalDist = catalogs.reduce((s, c) => s + c.datasets.reduce((t, d) => t + d.distributions.length, 0), 0);
  let html = `<h1>${esc(indexModel.title || 'FAIR Data Point')}</h1>`;
  if (indexModel.description) html += `<p class="lead">${esc(indexModel.description)}</p>`;
  html += fileActions(indexModel.file);
  html += `<p class="muted" style="margin-bottom:14px">${catalogs.length} catalogs · ${totalDist} ways to get data` +
          (indexModel.modified ? ` · updated ${esc(indexModel.modified)}` : '') + '</p>';
  if (failures.length) html += `<div class="card error" style="margin-bottom:14px">Could not load: ${failures.map(esc).join('<br>')}</div>`;
  html += '<div class="grid">';
  for (const c of catalogs) {
    const n = c.datasets.length, d = c.datasets.reduce((s, x) => s + x.distributions.length, 0);
    const methods = [...new Set(c.datasets.flatMap(x => x.distributions.map(y => y.typeLabel)).filter(Boolean))];
    html += `<a class="card clickable" href="${hrefFor(c.key)}" style="color:inherit;text-decoration:none">
      <div class="cat-title">${esc(c.title || c.key)}</div>
      <div class="cat-desc">${c.missing ? '<span class="error">Catalog file could not be loaded.</span>' : esc(c.description || '')}</div>
      <div class="cat-meta">${n} dataset${n !== 1 ? 's' : ''} · ${d} distribution${d !== 1 ? 's' : ''}</div>
      <div style="display:flex;gap:4px;flex-wrap:wrap;margin-top:8px">${methods.map(m => `<span class="chip">${esc(m)}</span>`).join('')}</div>
    </a>`;
  }
  html += '</div>' + turtleTabs();
  $('view').innerHTML = html;
  wireTabs(indexModel.file);
}

function showCatalog(key) {
  const c = catalogs.find(x => x.key === key);
  if (!c) { $('view').innerHTML = '<div class="card">Unknown catalog.</div>'; crumbs([]); return; }
  crumbs([{ label: c.title || key }]);
  const meta = [link(c.landingPage, 'Landing page ↗'), link(c.license, 'Licence ↗'), c.publisher ? 'Publisher: ' + esc(c.publisher) : ''].filter(Boolean);
  let html = `<h1>${esc(c.title || key)}</h1><p class="lead">${esc(c.description || '')}` +
             (meta.length ? `<br><span class="muted">${meta.join(' · ')}</span>` : '') + '</p>';
  html += fileActions(c.file);
  html += '<div class="section-title">Datasets</div>';
  for (const ds of c.datasets) {
    const n = ds.distributions.length;
    html += `<a class="card clickable ds-row" href="${hrefFor(c.key, ds.id)}" style="color:inherit;text-decoration:none">
      <div class="ds-version">${esc(ds.version || ds.id)}</div>
      <div class="ds-info"><div class="ds-title">${esc(ds.title || ds.id)}</div><div class="muted">${esc(ds.description || '')}</div></div>
      <span class="chip">${n} way${n !== 1 ? 's' : ''} to get it</span>
    </a>`;
  }
  html += turtleTabs();
  $('view').innerHTML = html;
  wireTabs(c.file);
}

function showDataset(key, id) {
  const c = catalogs.find(x => x.key === key);
  const ds = c && c.datasets.find(d => d.id === id);
  if (!ds) { $('view').innerHTML = '<div class="card">Unknown dataset.</div>'; crumbs([]); return; }
  crumbs([{ label: c.title || key, href: hrefFor(key) }, { label: ds.version || ds.id }]);

  const meta = [];
  if (ds.issued) meta.push('Issued ' + esc(ds.issued));
  if (ds.modified) meta.push('Modified ' + esc(ds.modified));
  if (ds.identifier) meta.push(safeUrl(ds.identifier) ? link(ds.identifier, ds.identifier) : esc(ds.identifier));
  if (ds.license) meta.push(link(ds.license, 'Licence ↗'));
  if (ds.landingPage) meta.push(link(ds.landingPage, 'Landing page ↗'));
  meta.push(...derivedLinks(ds.derivedFrom));

  const dists = ds.distributions;
  const methods = [...new Map(dists.filter(d => d.type).map(d => [d.type, d.typeLabel])).entries()];
  let html = `<h1>${esc(ds.title || ds.id)}</h1><p class="lead">${esc(ds.description || '')}` +
             (meta.length ? `<br><span class="muted">${meta.join(' · ')}</span>` : '') + '</p>';
  html += `<div class="section-title">Ways to get it (${dists.length})</div>`;
  html += '<div class="filters" id="filters"><button class="on" data-m="">All</button>' +
          methods.map(([t, l]) => `<button data-m="${esc(t)}">${esc(l)}</button>`).join('') + '</div>';
  html += '<div class="grid" id="dists"></div>';
  $('view').innerHTML = html;

  const render = () => { $('dists').innerHTML = dists.filter(d => !methodFilter || d.type === methodFilter).map(distCard).join(''); };
  $('filters').querySelectorAll('button').forEach(b => b.onclick = () => {
    methodFilter = b.dataset.m || null;
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

function distCard(d) {
  const how = (d.description || '').replace(/^How to get it:\s*/i, '');
  const fmt = [...new Set([d.mediaType, d.format].filter(Boolean))].join(' · ');
  const links = [link(d.accessURL, 'Open ↗'), link(d.downloadURL, 'Download ↓'), d.license ? link(d.license, 'Licence ↗') : ''].filter(Boolean);
  const svcs = d.services.map(s => s.endpointURL
    ? `<div class="svc"><div class="mono">${esc(s.title || 'Service')}<br>${esc(s.endpointURL)}</div>
       <div class="svc-links">${[link(s.endpointDescription, 'Docs ↗'), link(s.conformsTo, 'Protocol ↗')].filter(Boolean).join('')}</div></div>`
    : `<div class="svc mono">Service ${esc(localName(s.iri))} (not described in the loaded files)</div>`).join('');
  const derived = derivedLinks(d.derivedFrom);
  return `<div class="card dist">
    <div class="dist-head"><div class="dist-title">${esc(d.title || d.id)}</div>
      ${d.typeLabel ? `<span class="chip">${esc(d.typeLabel)}</span>` : ''}</div>
    ${fmt ? `<div class="muted mono" style="font-size:12px">${esc(fmt)}</div>` : ''}
    ${how ? `<div class="dist-how">${esc(how)}</div>` : ''}
    ${svcs}
    ${derived.length ? `<div class="derived">${derived.join(' · ')}</div>` : ''}
    <div class="dist-links">${links.join('')}</div>
  </div>`;
}

function turtleTabs() {
  return `<div class="tabs"><button class="on" data-tab="summary">Summary</button><button data-tab="raw">Turtle source</button></div>
          <div id="raw-box" hidden></div>`;
}
function wireTabs(file) {
  document.querySelectorAll('.tabs button').forEach(b => b.onclick = () => {
    document.querySelectorAll('.tabs button').forEach(x => x.classList.toggle('on', x === b));
    $('raw-box').hidden = b.dataset.tab !== 'raw';
    if (b.dataset.tab === 'raw') $('raw-box').innerHTML = `<pre class="ttl">${esc(sources.get(file) || 'Not loaded.')}</pre>`;
  });
}

init().catch(e => {
  $('view').innerHTML = `<div class="card error">Could not load the FAIR Data Point: ${esc(e.message)}</div>`;
});
