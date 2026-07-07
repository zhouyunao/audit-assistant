// Source/Sink rule library. Rules match in two ways:
//   callNames    -- match indexed call-site callee names (approximate, rightmost identifier, e.g. exec / query / system)
//   textPatterns -- regex-match raw source lines (for non-call forms: $_GET, req.query, os.environ, etc.)
// Each language covers core high-risk source/sink first; add languages/rules by appending here.

export interface TaintRule {
  id: string;
  kind: 'source' | 'sink';
  category: string;
  cwe?: string;
  description: string;
  /** Restrict to these languages (LanguageSpec.id); omit for all languages */
  languages?: string[];
  callNames?: string[];
  /** Regex source strings (matched against a single line of text) */
  textPatterns?: string[];
}

const JS = ['javascript', 'typescript', 'tsx'];

export const TAINT_RULES: TaintRule[] = [
  // ---------------- JavaScript / TypeScript ----------------
  { id: 'js.sink.eval', kind: 'sink', category: 'Code Execution', cwe: 'CWE-95', languages: JS, callNames: ['eval', 'Function'], description: 'eval / new Function dynamic code execution' },
  { id: 'js.sink.exec', kind: 'sink', category: 'Command Execution', cwe: 'CWE-78', languages: JS, callNames: ['exec', 'execSync', 'spawn', 'spawnSync', 'execFile'], description: 'child_process running system commands' },
  { id: 'js.sink.sql', kind: 'sink', category: 'SQL Execution', cwe: 'CWE-89', languages: JS, callNames: ['query', 'execute', 'raw'], description: 'database query execution' },
  { id: 'js.sink.xss', kind: 'sink', category: 'XSS', cwe: 'CWE-79', languages: JS, textPatterns: ['\\.innerHTML\\s*=', '\\.outerHTML\\s*=', 'dangerouslySetInnerHTML', 'document\\.write\\s*\\('], description: 'DOM write, may cause XSS' },
  { id: 'js.sink.redirect', kind: 'sink', category: 'Open Redirect', cwe: 'CWE-601', languages: JS, textPatterns: ['res\\.redirect\\s*\\('], description: 'redirect to a user-controlled location' },
  { id: 'js.source.http', kind: 'source', category: 'HTTP Input', languages: JS, textPatterns: ['\\breq(uest)?\\.(query|body|params|headers|cookies)\\b', '\\bctx\\.(query|request|params)\\b'], description: 'HTTP request input' },
  { id: 'js.source.env', kind: 'source', category: 'Environment/CLI', languages: JS, textPatterns: ['process\\.env\\b', 'process\\.argv\\b'], description: 'environment variables / command-line arguments' },
  { id: 'js.source.dom', kind: 'source', category: 'DOM Input', languages: JS, textPatterns: ['location\\.(search|hash|href)', 'document\\.cookie', 'window\\.name'], description: 'browser-side controllable input' },

  // ---------------- Python ----------------
  { id: 'py.sink.exec', kind: 'sink', category: 'Code Execution', cwe: 'CWE-95', languages: ['python'], callNames: ['eval', 'exec', 'compile'], description: 'eval / exec dynamic execution' },
  { id: 'py.sink.cmd', kind: 'sink', category: 'Command Execution', cwe: 'CWE-78', languages: ['python'], callNames: ['system', 'popen', 'run', 'call', 'check_output', 'check_call', 'Popen'], description: 'os.system / subprocess running commands' },
  { id: 'py.sink.sql', kind: 'sink', category: 'SQL Execution', cwe: 'CWE-89', languages: ['python'], callNames: ['execute', 'executemany', 'executescript'], description: 'cursor executing SQL' },
  { id: 'py.sink.deser', kind: 'sink', category: 'Unsafe Deserialization', cwe: 'CWE-502', languages: ['python'], callNames: ['loads', 'load'], textPatterns: ['pickle\\.loads?\\b', 'yaml\\.load\\b'], description: 'pickle / yaml deserialization' },
  { id: 'py.source.http', kind: 'source', category: 'HTTP Input', languages: ['python'], textPatterns: ['request\\.(args|form|values|json|data|cookies|files|headers|GET|POST)\\b'], description: 'Flask/Django request input' },
  { id: 'py.source.io', kind: 'source', category: 'Environment/CLI/Input', languages: ['python'], textPatterns: ['os\\.environ\\b', 'sys\\.argv\\b', '\\binput\\s*\\('], description: 'environment variables / argv / input()' },

  // ---------------- Java ----------------
  { id: 'java.sink.sql', kind: 'sink', category: 'SQL Execution', cwe: 'CWE-89', languages: ['java'], callNames: ['executeQuery', 'executeUpdate', 'execute', 'addBatch', 'createQuery', 'createNativeQuery', 'createSQLQuery'], description: 'JDBC/ORM executing SQL/HQL' },
  { id: 'java.sink.cmd', kind: 'sink', category: 'Command Execution', cwe: 'CWE-78', languages: ['java'], callNames: ['exec'], textPatterns: ['Runtime\\.getRuntime\\(\\)', 'new\\s+ProcessBuilder'], description: 'Runtime.exec / ProcessBuilder' },
  { id: 'java.sink.deser', kind: 'sink', category: 'Unsafe Deserialization', cwe: 'CWE-502', languages: ['java'], callNames: ['readObject'], description: 'ObjectInputStream.readObject' },
  { id: 'java.sink.reflect', kind: 'sink', category: 'Reflection/Class Loading', cwe: 'CWE-470', languages: ['java'], callNames: ['forName', 'loadClass'], description: 'Class.forName / loadClass' },
  { id: 'java.sink.xxe', kind: 'sink', category: 'XXE', cwe: 'CWE-611', languages: ['java'], callNames: ['newDocumentBuilder', 'newSAXParser', 'newInstance'], textPatterns: ['DocumentBuilderFactory', 'SAXParserFactory', 'XMLReader'], description: 'XML parsing, watch for XXE' },
  { id: 'java.source.http', kind: 'source', category: 'HTTP Input', languages: ['java'], callNames: ['getParameter', 'getParameterValues', 'getHeader', 'getQueryString', 'getCookies', 'getInputStream'], textPatterns: ['@RequestParam', '@PathVariable', '@RequestBody', '@RequestHeader'], description: 'Servlet/Spring request input' },
  { id: 'java.source.env', kind: 'source', category: 'Environment Variable', languages: ['java'], textPatterns: ['System\\.getenv\\b', 'System\\.getProperty\\b'], description: 'environment variables / system properties' },

  // ---------------- Go ----------------
  { id: 'go.sink.sql', kind: 'sink', category: 'SQL Execution', cwe: 'CWE-89', languages: ['go'], callNames: ['Query', 'QueryRow', 'QueryContext', 'Exec', 'ExecContext', 'Prepare'], description: 'database/sql execution' },
  { id: 'go.sink.cmd', kind: 'sink', category: 'Command Execution', cwe: 'CWE-78', languages: ['go'], callNames: ['Command', 'CommandContext'], textPatterns: ['exec\\.Command'], description: 'os/exec running commands' },
  { id: 'go.source.http', kind: 'source', category: 'HTTP Input', languages: ['go'], textPatterns: ['r\\.URL\\.Query\\(\\)', 'r\\.Form(Value)?\\b', 'r\\.PostForm', 'r\\.Header\\.Get', 'mux\\.Vars\\(', '\\bc\\.(Query|Param|PostForm)\\('], description: 'net/http / gin / mux request input' },
  { id: 'go.source.env', kind: 'source', category: 'Environment/CLI', languages: ['go'], textPatterns: ['os\\.Getenv\\b', 'os\\.Args\\b'], description: 'environment variables / argv' },

  // ---------------- PHP ----------------
  { id: 'php.sink.cmd', kind: 'sink', category: 'Command Execution', cwe: 'CWE-78', languages: ['php'], callNames: ['system', 'exec', 'shell_exec', 'passthru', 'popen', 'proc_open'], textPatterns: ['`.*\\$.*`'], description: 'command-execution functions / backticks' },
  { id: 'php.sink.code', kind: 'sink', category: 'Code Execution', cwe: 'CWE-95', languages: ['php'], callNames: ['eval', 'assert', 'create_function', 'call_user_func', 'call_user_func_array'], description: 'dynamic code execution' },
  { id: 'php.sink.sql', kind: 'sink', category: 'SQL Execution', cwe: 'CWE-89', languages: ['php'], callNames: ['query', 'mysqli_query', 'mysql_query', 'pg_query', 'exec'], description: 'database query' },
  { id: 'php.sink.deser', kind: 'sink', category: 'Unsafe Deserialization', cwe: 'CWE-502', languages: ['php'], callNames: ['unserialize'], description: 'unserialize deserialization' },
  { id: 'php.sink.file', kind: 'sink', category: 'File/Include', cwe: 'CWE-98', languages: ['php'], callNames: ['include', 'require', 'include_once', 'require_once', 'file_get_contents', 'fopen', 'readfile'], description: 'file include/read (LFI/RFI/SSRF)' },
  { id: 'php.source.super', kind: 'source', category: 'HTTP Input', languages: ['php'], textPatterns: ['\\$_(GET|POST|REQUEST|COOKIE|FILES|SERVER)\\b', 'php://input', 'getenv\\s*\\('], description: 'PHP superglobal input' },

  // ---------------- C / C++ ----------------
  { id: 'c.sink.cmd', kind: 'sink', category: 'Command Execution', cwe: 'CWE-78', languages: ['c', 'cpp'], callNames: ['system', 'popen', 'execl', 'execlp', 'execle', 'execv', 'execvp', 'execvpe'], description: 'system / exec family' },
  { id: 'c.sink.buf', kind: 'sink', category: 'Buffer Operation', cwe: 'CWE-120', languages: ['c', 'cpp'], callNames: ['strcpy', 'strcat', 'sprintf', 'vsprintf', 'gets', 'memcpy'], description: 'buffer writes without bounds checking' },
  { id: 'c.sink.fmt', kind: 'sink', category: 'Format String', cwe: 'CWE-134', languages: ['c', 'cpp'], callNames: ['printf', 'fprintf', 'snprintf', 'syslog'], description: 'format string (watch for controllable format)' },
  { id: 'c.source.input', kind: 'source', category: 'External Input', languages: ['c', 'cpp'], callNames: ['getenv', 'gets', 'fgets', 'scanf', 'fscanf', 'read', 'recv', 'recvfrom'], textPatterns: ['\\bargv\\b'], description: 'argv / environment variables / network/stdin reads' },

  // ---------------- C# ----------------
  { id: 'cs.sink.sql', kind: 'sink', category: 'SQL Execution', cwe: 'CWE-89', languages: ['csharp'], callNames: ['ExecuteReader', 'ExecuteNonQuery', 'ExecuteScalar', 'ExecuteQuery', 'Query', 'Execute'], textPatterns: ['new\\s+SqlCommand'], description: 'ADO.NET / Dapper execution' },
  { id: 'cs.sink.cmd', kind: 'sink', category: 'Command Execution', cwe: 'CWE-78', languages: ['csharp'], callNames: ['Start'], textPatterns: ['Process\\.Start', 'new\\s+ProcessStartInfo'], description: 'Process.Start running commands' },
  { id: 'cs.sink.deser', kind: 'sink', category: 'Unsafe Deserialization', cwe: 'CWE-502', languages: ['csharp'], callNames: ['Deserialize'], textPatterns: ['BinaryFormatter', 'LosFormatter', 'JavaScriptSerializer'], description: 'unsafe deserializers' },
  { id: 'cs.source.http', kind: 'source', category: 'HTTP Input', languages: ['csharp'], textPatterns: ['Request\\.(QueryString|Form|Params|Cookies|Headers)\\b', 'Request\\[', '\\[FromBody\\]', '\\[FromQuery\\]', '\\[FromRoute\\]'], description: 'ASP.NET request input' },
  { id: 'cs.source.env', kind: 'source', category: 'Environment/CLI', languages: ['csharp'], textPatterns: ['Environment\\.GetEnvironmentVariable', 'Console\\.ReadLine'], description: 'environment variables / console input' },
];
