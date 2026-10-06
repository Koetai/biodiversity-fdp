import java.io.*;
import java.net.*;
import java.util.*;
import java.util.concurrent.*;
import java.util.regex.*;

/**
 * Biodiversity FDP Viewer
 * Self-contained JAR: FDP browser + Turtle editor, with GitHub OAuth Device Flow login.
 * Adapted from the AMC viewer in AmsterdamUMC/proeftuin_datastandaarden (viewer/).
 *
 * Build:  ./build.sh   (javac --release 8 + jar)
 * Run:    java -jar fdp-viewer.jar
 *
 * Reads config.properties next to the JAR (see config.properties.template).
 * Browsing a public repository needs no login; committing edits does.
 */
public class FDPViewer {

    // ── Configuration ────────────────────────────────────────────────────────
    static String CLIENT_ID     = "";
    static String CLIENT_SECRET = "";
    static String GH_ORG        = "andrawaag";
    static String GH_REPO       = "biodiversity-fdp";
    static String GH_BRANCH     = "main";
    static String GH_TEAM       = "";
    static String GH_SCOPE      = "public_repo";
    static String FDP_DIR       = "fdp";
    static String LOCAL_ROOT    = "";   // optional: read from a local checkout instead of GitHub
    static int    PORT          = 8765;

    // ── Auth state (process lifetime, single-user desktop app) ───────────────
    static volatile String ACCESS_TOKEN  = null;
    static volatile String USERNAME      = null;
    static volatile String DEVICE_CODE   = null;
    static volatile int    POLL_INTERVAL = 5;
    static volatile long   DEVICE_EXPIRY = 0;

    // ── Entry point ──────────────────────────────────────────────────────────
    public static void main(String[] args) throws Exception {
        loadConfig();
        PORT = findPort(PORT, PORT + 20);
        System.out.println("====================================================");
        System.out.println("  Biodiversity FDP Viewer — " + GH_ORG + "/" + GH_REPO);
        System.out.println("  http://localhost:" + PORT);
        System.out.println("====================================================");
        System.out.println("  Press Ctrl+C to stop.");
        if (!Arrays.asList(args).contains("--no-browser")) openBrowser("http://localhost:" + PORT);
        serve(PORT);
    }

    static void loadConfig() {
        Properties p = new Properties();
        try {
            File f = new File("config.properties");
            if (f.exists()) {
                InputStream is = new FileInputStream(f);
                p.load(is);
                is.close();
            }
        } catch (IOException e) {
            System.err.println("Warning: could not read config.properties: " + e.getMessage());
        }
        CLIENT_ID     = p.getProperty("github.client_id",     "").trim();
        CLIENT_SECRET = p.getProperty("github.client_secret", "").trim();
        GH_ORG        = p.getProperty("github.org",           GH_ORG).trim();
        GH_REPO       = p.getProperty("github.repo",          GH_REPO).trim();
        GH_BRANCH     = p.getProperty("github.branch",        GH_BRANCH).trim();
        GH_TEAM       = p.getProperty("github.team",          "").trim();
        GH_SCOPE      = p.getProperty("github.scope",         GH_SCOPE).trim();
        FDP_DIR       = p.getProperty("fdp.dir",              FDP_DIR).trim();
        LOCAL_ROOT    = p.getProperty("local.root",           "").trim();
        PORT          = toInt(p.getProperty("viewer.port"), PORT);
        if (!LOCAL_ROOT.isEmpty())
            System.out.println("Reading FDP files from local checkout: " + new File(LOCAL_ROOT).getAbsolutePath());

        if (CLIENT_ID.isEmpty()) {
            System.err.println("NOTE: github.client_id is not set — browsing works, login/commit does not.");
            System.err.println("      Create a GitHub OAuth App with Device Flow enabled and set its Client ID.");
        }
    }

    static int findPort(int lo, int hi) {
        for (int p = lo; p <= hi; p++) {
            try {
                ServerSocket s = new ServerSocket(p, 50, InetAddress.getLoopbackAddress());
                s.close();
                return p;
            } catch (IOException ignored) {}
        }
        return lo;
    }

    static void openBrowser(String url) {
        try {
            String os = System.getProperty("os.name").toLowerCase();
            if (os.contains("win"))
                Runtime.getRuntime().exec(new String[]{"rundll32", "url.dll,FileProtocolHandler", url});
            else if (os.contains("mac"))
                Runtime.getRuntime().exec(new String[]{"open", url});
            else
                Runtime.getRuntime().exec(new String[]{"xdg-open", url});
        } catch (Exception ignored) {}
    }

    // ── HTTP server (loopback only) ──────────────────────────────────────────
    static void serve(int port) throws Exception {
        ServerSocket ss = new ServerSocket(port, 50, InetAddress.getLoopbackAddress());
        ExecutorService pool = Executors.newCachedThreadPool();
        while (true) {
            final Socket sock = ss.accept();
            pool.execute(new Runnable() {
                public void run() {
                    try {
                        handleConnection(sock);
                    } catch (Exception ignored) {
                    } finally {
                        try { sock.close(); } catch (Exception ignored) {}
                    }
                }
            });
        }
    }

    static void handleConnection(Socket sock) throws Exception {
        InputStream  in  = sock.getInputStream();
        OutputStream out = sock.getOutputStream();

        // Read headers up to \r\n\r\n
        ByteArrayOutputStream headerBuf = new ByteArrayOutputStream();
        int b;
        int[] last = new int[]{0, 0, 0, 0};
        while ((b = in.read()) != -1) {
            headerBuf.write(b);
            last[0] = last[1]; last[1] = last[2]; last[2] = last[3]; last[3] = b;
            if (last[0] == '\r' && last[1] == '\n' && last[2] == '\r' && last[3] == '\n') break;
            if (headerBuf.size() > 65536) break;
        }

        String raw = headerBuf.toString("ISO-8859-1");
        String[] lines = raw.split("\r\n");
        if (lines.length == 0) return;

        String[] reqLine = lines[0].split(" ", 3);
        if (reqLine.length < 2) return;

        String method   = reqLine[0];
        String fullPath = reqLine[1];
        String path  = fullPath;
        String query = "";
        int qi = fullPath.indexOf('?');
        if (qi >= 0) {
            path  = fullPath.substring(0, qi);
            query = fullPath.substring(qi + 1);
        }

        Map<String, String> headers = new LinkedHashMap<String, String>();
        for (int i = 1; i < lines.length; i++) {
            int ci = lines[i].indexOf(':');
            if (ci > 0)
                headers.put(lines[i].substring(0, ci).trim().toLowerCase(),
                            lines[i].substring(ci + 1).trim());
        }

        String body = "";
        String cl = headers.get("content-length");
        if (cl != null) {
            try {
                int len = Integer.parseInt(cl.trim());
                if (len > 0 && len <= 2097152) {
                    byte[] bb = new byte[len];
                    int read = 0;
                    while (read < len) {
                        int r = in.read(bb, read, len - read);
                        if (r == -1) break;
                        read += r;
                    }
                    body = new String(bb, 0, read, "UTF-8");
                }
            } catch (NumberFormatException ignored) {}
        }

        Response resp = isTrustedRequest(path, headers)
            ? route(method, path, query, body)
            : Response.forbidden();
        resp.writeTo(out);
    }

    /**
     * The process holds a GitHub token, so other web pages open in the same browser
     * must not be able to drive the API. Require a localhost Host header (blocks DNS
     * rebinding) and, for API calls, no Origin or our own Origin (blocks cross-site
     * requests).
     */
    static boolean isTrustedRequest(String path, Map<String, String> headers) {
        String host = headers.get("host");
        if (host == null) return false;
        if (!host.equals("localhost:" + PORT) && !host.equals("127.0.0.1:" + PORT)) return false;
        if (!path.startsWith("/api/")) return true;
        String origin = headers.get("origin");
        return origin == null
            || origin.equals("http://localhost:" + PORT)
            || origin.equals("http://127.0.0.1:" + PORT);
    }

    // ── Router ───────────────────────────────────────────────────────────────
    static Response route(String method, String path, String query, String body) {
        if ("/".equals(path) || "/home".equals(path)) return serveResource("home.html");
        if ("/fdp".equals(path))                       return serveResource("fdp.html");
        if ("/editor".equals(path))                    return serveResource("editor.html");
        if ("/style.css".equals(path))                 return serveResource("style.css");

        if (path.startsWith("/api/")) {
            try {
                return handleApi(method, path, query, body);
            } catch (Exception e) {
                String msg = e.getMessage() != null ? e.getMessage() : e.getClass().getSimpleName();
                return Response.json("{\"error\":" + jStr(msg) + "}");
            }
        }

        return Response.notFound();
    }

    static Response handleApi(String method, String path, String query, String body) throws Exception {
        // Config and auth
        if ("/api/config".equals(path))      return Response.json(configJson());
        if ("/api/auth/status".equals(path)) return Response.json(authStatus());
        if ("/api/auth/device".equals(path) && "POST".equals(method)) return Response.json(authDevice());
        if ("/api/auth/poll".equals(path)   && "POST".equals(method)) return Response.json(authPoll());
        if ("/api/auth/logout".equals(path) && "POST".equals(method)) return Response.json(authLogout());

        // FDP parsing
        if ("/api/fdp/catalog".equals(path))  return Response.json(fdpCatalog(query));
        if ("/api/fdp/folders".equals(path))  return Response.json(fdpFolders());

        // GitHub proxy
        if ("/api/github/raw".equals(path))  return Response.json(ghRaw(query));
        if ("/api/github/commit".equals(path) && "POST".equals(method))
            return Response.json(ghCommit(body));

        return Response.json("{\"error\":" + jStr("Unknown API endpoint: " + method + " " + path) + "}");
    }

    static String configJson() {
        return "{\"org\":" + jStr(GH_ORG) + ",\"repo\":" + jStr(GH_REPO) +
               ",\"branch\":" + jStr(GH_BRANCH) + ",\"fdpDir\":" + jStr(FDP_DIR) +
               ",\"loginConfigured\":" + !CLIENT_ID.isEmpty() +
               ",\"local\":" + !LOCAL_ROOT.isEmpty() + "}";
    }

    // ── Auth (GitHub OAuth Device Flow) ──────────────────────────────────────
    static String authStatus() {
        if (ACCESS_TOKEN != null && USERNAME != null)
            return "{\"loggedIn\":true,\"username\":" + jStr(USERNAME) + "}";
        return "{\"loggedIn\":false}";
    }

    static String authDevice() throws Exception {
        if (CLIENT_ID.isEmpty())
            return "{\"error\":\"github.client_id is not configured in config.properties\"}";
        String resp = httpPost(
            "https://github.com/login/device/code",
            "client_id=" + urlEnc(CLIENT_ID) + "&scope=" + urlEnc(GH_SCOPE),
            "application/x-www-form-urlencoded", "application/json", null);

        Map<String, String> data = parseJson(resp);
        if (!data.containsKey("device_code")) data = parseForm(resp);

        String dc = data.get("device_code");
        if (dc == null)
            return "{\"error\":\"GitHub returned no device_code. Check client_id and that Device Flow is enabled on the OAuth App.\"}";

        DEVICE_CODE   = dc;
        POLL_INTERVAL = toInt(data.get("interval"), 5);
        DEVICE_EXPIRY = System.currentTimeMillis() + toInt(data.get("expires_in"), 900) * 1000L;

        return "{\"user_code\":"         + jStr(data.get("user_code")) +
               ",\"verification_uri\":" + jStr(data.get("verification_uri")) +
               ",\"interval\":"         + POLL_INTERVAL + "}";
    }

    static String authPoll() throws Exception {
        if (DEVICE_CODE == null)
            return "{\"status\":\"no_request\"}";
        if (System.currentTimeMillis() > DEVICE_EXPIRY) {
            DEVICE_CODE = null;
            return "{\"status\":\"expired\"}";
        }

        // Device Flow does not need the client secret; send it only if configured.
        String form = "client_id=" + urlEnc(CLIENT_ID) +
                      (CLIENT_SECRET.isEmpty() ? "" : "&client_secret=" + urlEnc(CLIENT_SECRET)) +
                      "&device_code=" + urlEnc(DEVICE_CODE) +
                      "&grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code";
        String resp = httpPost("https://github.com/login/oauth/access_token", form,
            "application/x-www-form-urlencoded", "application/json", null);

        Map<String, String> data = parseJson(resp);
        if (!data.containsKey("access_token") && !data.containsKey("error")) data = parseForm(resp);

        String token = data.get("access_token");
        if (token != null) {
            DEVICE_CODE = null;
            String user = parseJson(httpGet("https://api.github.com/user", token)).get("login");
            if (user == null || user.trim().isEmpty()) user = "user";

            if (!GH_TEAM.isEmpty() && !checkTeamMember(token, user)) {
                return "{\"status\":\"unauthorized\",\"message\":\"Access denied: not a member of the required GitHub team.\"}";
            }
            ACCESS_TOKEN = token;
            USERNAME     = user;
            return "{\"status\":\"complete\",\"username\":" + jStr(USERNAME) + "}";
        }

        String error = data.get("error");
        if ("authorization_pending".equals(error)) return "{\"status\":\"pending\"}";
        if ("slow_down".equals(error)) {
            POLL_INTERVAL += 5;
            return "{\"status\":\"pending\",\"interval\":" + POLL_INTERVAL + "}";
        }
        return "{\"status\":\"error\",\"error\":" + jStr(error != null ? error : "unknown") + "}";
    }

    static String authLogout() {
        ACCESS_TOKEN = null;
        USERNAME     = null;
        DEVICE_CODE  = null;
        return "{\"status\":\"ok\"}";
    }

    static boolean checkTeamMember(String token, String user) {
        try {
            HttpURLConnection c = (HttpURLConnection) new URL("https://api.github.com/orgs/" + GH_ORG +
                              "/teams/" + GH_TEAM + "/memberships/" + user).openConnection();
            c.setRequestProperty("Authorization", "token " + token);
            c.setRequestProperty("Accept", "application/vnd.github+json");
            c.setRequestProperty("User-Agent", "Biodiversity-FDP-Viewer/1.0");
            c.setConnectTimeout(8000);
            c.setReadTimeout(10000);
            return c.getResponseCode() == 200;
        } catch (Exception e) {
            return false;
        }
    }

    // ── FDP folders and catalog parsing ──────────────────────────────────────
    static String fdpFolders() throws Exception {
        String treeJson = ghContents(FDP_DIR);
        if (!treeJson.trim().startsWith("[")) return "{\"error\":" + jStr(ghError(treeJson)) + "}";
        // Each entry in the contents listing is an object; pick dirs by name/type pairs.
        List<String> folders = new ArrayList<String>();
        Matcher m = Pattern.compile("\\{[^{}]*?\"name\"\\s*:\\s*\"([^\"]+)\"[^{}]*?\"type\"\\s*:\\s*\"dir\"").matcher(treeJson);
        while (m.find()) folders.add(m.group(1));
        StringBuilder sb = new StringBuilder("[");
        for (int i = 0; i < folders.size(); i++) {
            if (i > 0) sb.append(",");
            sb.append(jStr(folders.get(i)));
        }
        return sb.append("]").toString();
    }

    static String fdpCatalog(String query) throws Exception {
        Map<String, String> p = parseForm(query);
        String folder = p.get("folder");
        if (folder == null || !folder.matches("[\\w.-]+"))
            return "{\"error\":\"folder parameter required\"}";

        String rawResult = ghRaw("path=" + urlEnc(FDP_DIR + "/" + folder + "/catalog.ttl"));
        Map<String, String> raw = parseJson(rawResult);
        if (raw.get("error") != null) return rawResult;

        String ttl = raw.get("content");
        return parseTtl(folder, ttl != null ? ttl : "");
    }

    /**
     * Parses a catalog.ttl written in this repository's house style (one block per
     * local name starting in column 0) into JSON. Not a general Turtle parser: run
     * scripts/validate.py for real validation.
     */
    static String parseTtl(String folder, String ttl) {
        Map<String, String> blocks = ttlBlocks(ttl);
        StringBuilder sb = new StringBuilder();
        sb.append("{\"folder\":").append(jStr(folder));

        String catBlock = blocks.get(":catalog");
        if (catBlock == null) {
            // An index: the root block lists sub-catalogs, each with rdfs:seeAlso.
            sb.append(",\"index\":true");
            sb.append(",\"title\":").append(jStr(value(ttl, "dcterms:title")));
            sb.append(",\"description\":").append(jStr(value(ttl, "dcterms:description")));
            sb.append(",\"catalogs\":[");
            boolean first = true;
            for (Map.Entry<String, String> e : blocks.entrySet()) {
                if (!e.getKey().startsWith(":catalog-")) continue;
                if (!first) sb.append(",");
                first = false;
                sb.append("{\"title\":").append(jStr(value(e.getValue(), "dcterms:title")));
                sb.append(",\"seeAlso\":").append(jStr(value(e.getValue(), "rdfs:seeAlso"))).append("}");
            }
            return sb.append("]}").toString();
        }

        String access = "PUBLIC";
        if (catBlock.contains("access-right/RESTRICTED")) access = "RESTRICTED";
        else if (catBlock.contains("access-right/NON_PUBLIC")) access = "NON_PUBLIC";

        sb.append(",\"title\":").append(jStr(value(catBlock, "dcterms:title")));
        sb.append(",\"description\":").append(jStr(value(catBlock, "dcterms:description")));
        sb.append(",\"landingPage\":").append(jStr(value(catBlock, "dcat:landingPage")));
        sb.append(",\"license\":").append(jStr(value(catBlock, "dcterms:license")));
        sb.append(",\"access\":").append(jStr(access));
        sb.append(",\"datasets\":[");

        boolean firstDs = true;
        for (String dsId : objects(catBlock, "dcat:dataset")) {
            String dsBlock = blocks.get(dsId);
            if (dsBlock == null) continue;
            if (!firstDs) sb.append(",");
            firstDs = false;

            sb.append("{\"id\":").append(jStr(dsId));
            for (String[] f : new String[][]{
                    {"title", "dcterms:title"}, {"version", "dcterms:version"},
                    {"issued", "dcterms:issued"}, {"modified", "dcterms:modified"},
                    {"description", "dcterms:description"}, {"landingPage", "dcat:landingPage"},
                    {"license", "dcterms:license"}, {"identifier", "dcterms:identifier"}})
                sb.append(",\"").append(f[0]).append("\":").append(jStr(value(dsBlock, f[1])));

            sb.append(",\"distributions\":[");
            boolean firstDist = true;
            for (String distId : objects(dsBlock, "dcat:distribution")) {
                String distBlock = blocks.get(distId);
                if (distBlock == null) continue;
                if (!firstDist) sb.append(",");
                firstDist = false;

                sb.append("{\"id\":").append(jStr(distId));
                sb.append(",\"title\":").append(jStr(value(distBlock, "dcterms:title")));
                sb.append(",\"description\":").append(jStr(value(distBlock, "dcterms:description")));
                sb.append(",\"accessMethod\":").append(jStr(value(distBlock, "dcterms:type")));
                sb.append(",\"mediaType\":").append(jStr(mediaType(value(distBlock, "dcat:mediaType"))));
                sb.append(",\"format\":").append(jStr(value(distBlock, "dcterms:format")));
                sb.append(",\"accessURL\":").append(jStr(value(distBlock, "dcat:accessURL")));
                sb.append(",\"downloadURL\":").append(jStr(value(distBlock, "dcat:downloadURL")));
                sb.append(",\"services\":[");
                boolean firstSvc = true;
                for (String svc : objects(distBlock, "dcat:accessService")) {
                    if (!firstSvc) sb.append(",");
                    firstSvc = false;
                    String svcBlock = blocks.get(svc);
                    if (svcBlock != null) {
                        sb.append("{\"title\":").append(jStr(value(svcBlock, "dcterms:title")));
                        sb.append(",\"endpointURL\":").append(jStr(value(svcBlock, "dcat:endpointURL")));
                        sb.append(",\"endpointDescription\":").append(jStr(value(svcBlock, "dcat:endpointDescription"))).append("}");
                    } else {
                        // Service described in another catalog of this FDP.
                        sb.append("{\"title\":null,\"endpointURL\":null,\"ref\":").append(jStr(clean(svc))).append("}");
                    }
                }
                sb.append("]}");
            }
            sb.append("]}");
        }
        return sb.append("]}").toString();
    }

    // Splits TTL into blocks per local name that starts in column 0 (:catalog, :dist-x, ...)
    static Map<String, String> ttlBlocks(String ttl) {
        Map<String, String> blocks = new LinkedHashMap<String, String>();
        Matcher m = Pattern.compile("(?m)^(:[\\w-]+)").matcher(ttl);
        List<Integer> pos   = new ArrayList<Integer>();
        List<String>  names = new ArrayList<String>();
        while (m.find()) { pos.add(m.start()); names.add(m.group(1)); }
        for (int i = 0; i < pos.size(); i++) {
            int end = (i + 1 < pos.size()) ? pos.get(i + 1) : ttl.length();
            blocks.put(names.get(i), ttl.substring(pos.get(i), end));
        }
        return blocks;
    }

    /** Objects of the first statement in the block with this predicate, as raw tokens. */
    static List<String> objects(String block, String pred) {
        List<String> result = new ArrayList<String>();
        Matcher pm = Pattern.compile("(?m)(?:^|\\s)" + Pattern.quote(pred) + "\\s").matcher(stripComments(block));
        if (!pm.find()) return result;
        String s = stripComments(block);
        StringBuilder cur = new StringBuilder();
        boolean inIri = false, inStr = false;
        for (int i = pm.end(); i < s.length(); i++) {
            char c = s.charAt(i);
            if (inStr) {
                cur.append(c);
                if (c == '\\' && i + 1 < s.length()) { cur.append(s.charAt(++i)); continue; }
                if (c == '"') inStr = false;
                continue;
            }
            if (inIri) { cur.append(c); if (c == '>') inIri = false; continue; }
            if (c == '"') { inStr = true; cur.append(c); continue; }
            if (c == '<') { inIri = true; cur.append(c); continue; }
            boolean endsStatement = c == ';' ||
                (c == '.' && (i + 1 >= s.length() || Character.isWhitespace(s.charAt(i + 1))));
            if (c == ',' || endsStatement) {
                if (cur.toString().trim().length() > 0) result.add(cur.toString().trim());
                cur.setLength(0);
                if (endsStatement) break;
                continue;
            }
            cur.append(c);
        }
        if (cur.toString().trim().length() > 0) result.add(cur.toString().trim());
        return result;
    }

    /** First object of the predicate, with quotes, language tag, datatype and <> removed. */
    static String value(String block, String pred) {
        List<String> objs = objects(block, pred);
        return objs.isEmpty() ? null : clean(objs.get(0));
    }

    static String clean(String token) {
        String t = token.trim();
        if (t.startsWith("\"")) {
            int end = t.lastIndexOf('"');
            return end > 0 ? t.substring(1, end).replace("\\\"", "\"").replace("\\\\", "\\") : t;
        }
        if (t.startsWith("<") && t.endsWith(">")) return t.substring(1, t.length() - 1);
        int colon = t.indexOf(':');
        return colon >= 0 ? t.substring(colon + 1) : t;   // prefixed name → local part
    }

    static String mediaType(String v) {
        if (v == null) return null;
        String iana = "https://www.iana.org/assignments/media-types/";
        return v.startsWith(iana) ? v.substring(iana.length()) : v;
    }

    static String stripComments(String block) {
        // Drop full-line comments; '#' inside IRIs and literals stays intact.
        return block.replaceAll("(?m)^\\s*#.*$", "");
    }

    // ── GitHub proxy ─────────────────────────────────────────────────────────
    static String ghContents(String path) throws Exception {
        if (!LOCAL_ROOT.isEmpty()) return localContents(path);
        String url = "https://api.github.com/repos/" + GH_ORG + "/" + GH_REPO +
                     "/contents/" + encodePath(path) + "?ref=" + urlEnc(GH_BRANCH);
        return httpGet(url, ACCESS_TOKEN);
    }

    /** Mimics the GitHub contents API (directory listing or base64 file) for a local checkout. */
    static String localContents(String path) throws Exception {
        File f = new File(LOCAL_ROOT, path);
        if (f.isDirectory()) {
            StringBuilder sb = new StringBuilder("[");
            File[] kids = f.listFiles();
            Arrays.sort(kids);
            for (File k : kids) {
                if (sb.length() > 1) sb.append(",");
                sb.append("{\"name\":").append(jStr(k.getName()))
                  .append(",\"type\":").append(jStr(k.isDirectory() ? "dir" : "file")).append("}");
            }
            return sb.append("]").toString();
        }
        if (!f.isFile()) return "{\"message\":\"Not Found\"}";
        byte[] data = readBytes(new FileInputStream(f));
        return "{\"sha\":\"local\",\"content\":" + jStr(Base64.getEncoder().encodeToString(data)) + "}";
    }

    static String ghRaw(String query) throws Exception {
        Map<String, String> p = parseForm(query);
        String filePath = p.get("path");
        if (filePath == null || filePath.contains("..")) return "{\"error\":\"path parameter required\"}";

        String resp = ghContents(filePath);
        Map<String, String> data = parseJson(resp);
        String b64 = data.get("content");
        String sha = data.get("sha");
        if (b64 == null)
            return "{\"error\":" + jStr("File not found or not accessible: " + ghError(resp)) +
                   ",\"path\":" + jStr(filePath) + "}";

        b64 = b64.replaceAll("\\s", "");   // GitHub wraps base64 at 60 chars
        String content = new String(Base64.getDecoder().decode(b64), "UTF-8");
        return "{\"content\":" + jStr(content) + ",\"sha\":" + jStr(sha) + "}";
    }

    static String ghCommit(String body) throws Exception {
        if (!LOCAL_ROOT.isEmpty())
            return "{\"error\":\"Local mode (local.root) is read-only; edit the files on disk instead\"}";
        requireAuth();
        Map<String, String> d = parseJson(body);
        String filePath = d.get("path");
        String content  = d.get("content");
        String sha      = d.get("sha");
        String message  = d.get("message");

        if (filePath == null || content == null)
            return "{\"error\":\"path and content are required\"}";
        if (!filePath.startsWith(FDP_DIR + "/") || filePath.contains("..") || !filePath.endsWith(".ttl"))
            return "{\"error\":\"Only .ttl files under the FDP directory can be committed\"}";
        if (message == null || message.trim().isEmpty()) message = "Update " + filePath + " via FDP Viewer";

        String encoded = Base64.getEncoder().encodeToString(content.getBytes("UTF-8"));
        StringBuilder payload = new StringBuilder("{");
        payload.append("\"message\":").append(jStr(message));
        payload.append(",\"content\":").append(jStr(encoded));
        payload.append(",\"branch\":").append(jStr(GH_BRANCH));
        if (sha != null) payload.append(",\"sha\":").append(jStr(sha));
        payload.append("}");

        String url = "https://api.github.com/repos/" + GH_ORG + "/" + GH_REPO + "/contents/" + encodePath(filePath);
        String resp = httpPut(url, payload.toString(), ACCESS_TOKEN);
        Map<String, String> r = parseJson(resp);
        return r.containsKey("sha")
            ? "{\"status\":\"ok\",\"sha\":" + jStr(r.get("sha")) + "}"
            : "{\"error\":" + jStr("GitHub PUT failed: " + ghError(resp)) + "}";
    }

    static String ghError(String resp) {
        String msg = parseJson(resp).get("message");
        return msg != null ? msg : resp.substring(0, Math.min(200, resp.length()));
    }

    static void requireAuth() throws Exception {
        if (ACCESS_TOKEN == null)
            throw new Exception("Not signed in — sign in with GitHub on the home page");
    }

    // ── Static resources from the JAR ────────────────────────────────────────
    static Response serveResource(String name) {
        InputStream is = FDPViewer.class.getResourceAsStream("/web/" + name);
        if (is == null) return Response.notFound();
        try {
            byte[] data = readBytes(is);
            is.close();
            String ct;
            if      (name.endsWith(".html")) ct = "text/html; charset=utf-8";
            else if (name.endsWith(".css"))  ct = "text/css; charset=utf-8";
            else if (name.endsWith(".js"))   ct = "application/javascript; charset=utf-8";
            else                             ct = "application/octet-stream";
            Response r = new Response();
            r.headers.put("Content-Type", ct);
            r.body = data;
            return r;
        } catch (IOException e) {
            return Response.error("Could not read resource: " + name);
        }
    }

    // ── HTTP helpers ─────────────────────────────────────────────────────────
    static String httpGet(String url, String token) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setRequestMethod("GET");
        if (token != null) c.setRequestProperty("Authorization", "token " + token);
        c.setRequestProperty("Accept", "application/vnd.github+json");
        c.setRequestProperty("User-Agent", "Biodiversity-FDP-Viewer/1.0");
        c.setConnectTimeout(10000);
        c.setReadTimeout(20000);
        return readResponse(c);
    }

    static String httpPost(String url, String body, String ctype, String accept, String token)
            throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setRequestMethod("POST");
        c.setRequestProperty("Content-Type", ctype);
        c.setRequestProperty("Accept", accept != null ? accept : "application/json");
        c.setRequestProperty("User-Agent", "Biodiversity-FDP-Viewer/1.0");
        if (token != null) c.setRequestProperty("Authorization", "token " + token);
        c.setDoOutput(true);
        c.setConnectTimeout(10000);
        c.setReadTimeout(20000);
        byte[] bb = body.getBytes("UTF-8");
        c.setRequestProperty("Content-Length", String.valueOf(bb.length));
        OutputStream os = c.getOutputStream();
        os.write(bb);
        os.close();
        return readResponse(c);
    }

    static String httpPut(String url, String body, String token) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setRequestMethod("PUT");
        c.setRequestProperty("Authorization", "token " + token);
        c.setRequestProperty("Accept", "application/vnd.github+json");
        c.setRequestProperty("Content-Type", "application/json; charset=utf-8");
        c.setRequestProperty("User-Agent", "Biodiversity-FDP-Viewer/1.0");
        c.setDoOutput(true);
        c.setConnectTimeout(10000);
        c.setReadTimeout(30000);
        byte[] bb = body.getBytes("UTF-8");
        c.setRequestProperty("Content-Length", String.valueOf(bb.length));
        OutputStream os = c.getOutputStream();
        os.write(bb);
        os.close();
        return readResponse(c);
    }

    static String readResponse(HttpURLConnection c) throws IOException {
        InputStream is;
        try { is = c.getInputStream(); }
        catch (IOException e) { is = c.getErrorStream(); }
        if (is == null) return "{}";
        byte[] data = readBytes(is);
        is.close();
        return new String(data, "UTF-8");
    }

    static byte[] readBytes(InputStream is) throws IOException {
        ByteArrayOutputStream baos = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n;
        while ((n = is.read(buf)) != -1) baos.write(buf, 0, n);
        return baos.toByteArray();
    }

    // ── JSON / form utilities ────────────────────────────────────────────────
    // Light JSON reader: extracts string values "key":"value" (first occurrence wins).
    // Scans by hand: a regex with alternation overflows the stack on long base64 strings.
    static Map<String, String> parseJson(String json) {
        Map<String, String> m = new LinkedHashMap<String, String>();
        if (json == null) return m;
        int n = json.length(), i = 0;
        String pendingKey = null;
        while (i < n) {
            char c = json.charAt(i);
            if (c != '"') {
                if (c != ':' && !Character.isWhitespace(c)) pendingKey = null;
                i++;
                continue;
            }
            int j = i + 1;
            while (j < n && json.charAt(j) != '"') j += json.charAt(j) == '\\' ? 2 : 1;
            String str = json.substring(i + 1, Math.min(j, n));
            i = j + 1;
            int k = i;
            while (k < n && Character.isWhitespace(json.charAt(k))) k++;
            if (k < n && json.charAt(k) == ':') {
                pendingKey = str;            // this string is a key
                i = k + 1;
            } else if (pendingKey != null) {
                if (!m.containsKey(pendingKey)) m.put(pendingKey, unescapeJson(str));
                pendingKey = null;
            }
        }
        return m;
    }

    static String unescapeJson(String s) {
        StringBuilder sb = new StringBuilder(s.length());
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (c != '\\' || i + 1 >= s.length()) { sb.append(c); continue; }
            char n = s.charAt(++i);
            switch (n) {
                case 'n': sb.append('\n'); break;
                case 'r': sb.append('\r'); break;
                case 't': sb.append('\t'); break;
                case 'b': sb.append('\b'); break;
                case 'f': sb.append('\f'); break;
                case 'u':
                    if (i + 4 < s.length()) {
                        sb.append((char) Integer.parseInt(s.substring(i + 1, i + 5), 16));
                        i += 4;
                    }
                    break;
                default: sb.append(n);   // \" \\ \/
            }
        }
        return sb.toString();
    }

    static Map<String, String> parseForm(String s) {
        Map<String, String> m = new LinkedHashMap<String, String>();
        if (s == null || s.trim().isEmpty()) return m;
        for (String pair : s.split("&")) {
            int i = pair.indexOf('=');
            if (i > 0) {
                try {
                    m.put(URLDecoder.decode(pair.substring(0, i), "UTF-8"),
                          URLDecoder.decode(pair.substring(i + 1), "UTF-8"));
                } catch (Exception ignored) {}
            }
        }
        return m;
    }

    static String jStr(String s) {
        if (s == null) return "null";
        StringBuilder sb = new StringBuilder("\"");
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '\\': sb.append("\\\\"); break;
                case '"':  sb.append("\\\""); break;
                case '\n': sb.append("\\n");  break;
                case '\r': sb.append("\\r");  break;
                case '\t': sb.append("\\t");  break;
                default:
                    if (c < 0x20) sb.append(String.format("\\u%04x", (int) c));
                    else sb.append(c);
            }
        }
        return sb.append("\"").toString();
    }

    static String urlEnc(String s) {
        try { return URLEncoder.encode(s, "UTF-8"); } catch (Exception e) { return s; }
    }

    static String encodePath(String path) {
        StringBuilder sb = new StringBuilder();
        for (String seg : path.split("/")) {
            if (sb.length() > 0) sb.append('/');
            sb.append(urlEnc(seg).replace("+", "%20"));
        }
        return sb.toString();
    }

    static int toInt(String s, int def) {
        try { return Integer.parseInt(s.trim()); } catch (Exception e) { return def; }
    }

    // ── Response ─────────────────────────────────────────────────────────────
    static class Response {
        int    status     = 200;
        String statusText = "OK";
        Map<String, String> headers = new LinkedHashMap<String, String>();
        byte[] body = new byte[0];

        void writeTo(OutputStream out) throws IOException {
            headers.put("Content-Length", String.valueOf(body != null ? body.length : 0));
            headers.put("X-Content-Type-Options", "nosniff");
            headers.put("Cache-Control", "no-store");

            StringBuilder sb = new StringBuilder();
            sb.append("HTTP/1.1 ").append(status).append(" ").append(statusText).append("\r\n");
            for (Map.Entry<String, String> e : headers.entrySet())
                sb.append(e.getKey()).append(": ").append(e.getValue()).append("\r\n");
            sb.append("\r\n");

            out.write(sb.toString().getBytes("ISO-8859-1"));
            if (body != null && body.length > 0) out.write(body);
            out.flush();
        }

        static Response json(String json) {
            Response r = new Response();
            r.headers.put("Content-Type", "application/json; charset=utf-8");
            try { r.body = json.getBytes("UTF-8"); } catch (Exception e) { r.body = json.getBytes(); }
            return r;
        }

        static Response text(int status, String statusText, String msg) {
            Response r = new Response();
            r.status = status; r.statusText = statusText;
            r.headers.put("Content-Type", "text/plain; charset=utf-8");
            try { r.body = msg.getBytes("UTF-8"); } catch (Exception e) { r.body = msg.getBytes(); }
            return r;
        }

        static Response notFound()           { return text(404, "Not Found", "Not found"); }
        static Response forbidden()          { return text(403, "Forbidden", "Forbidden"); }
        static Response error(String msg)    { return text(500, "Internal Server Error", msg); }
    }
}
