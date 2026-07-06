// Source/Sink 规则库。规则通过两种方式命中：
//   callNames  —— 匹配索引出的调用点被调名（近似，取最右标识符，如 exec / query / system）
//   textPatterns —— 正则匹配原始代码行（用于非调用形式：$_GET、req.query、os.environ 等）
// 每语言先覆盖核心的高危 source/sink；加语言/规则只需往这里追加。

export interface TaintRule {
  id: string;
  kind: 'source' | 'sink';
  category: string;
  cwe?: string;
  description: string;
  /** 限定语言（LanguageSpec.id）；省略表示所有语言 */
  languages?: string[];
  callNames?: string[];
  /** 正则源串（匹配单行文本） */
  textPatterns?: string[];
}

const JS = ['javascript', 'typescript', 'tsx'];

export const TAINT_RULES: TaintRule[] = [
  // ---------------- JavaScript / TypeScript ----------------
  { id: 'js.sink.eval', kind: 'sink', category: '代码执行', cwe: 'CWE-95', languages: JS, callNames: ['eval', 'Function'], description: 'eval / new Function 动态执行代码' },
  { id: 'js.sink.exec', kind: 'sink', category: '命令执行', cwe: 'CWE-78', languages: JS, callNames: ['exec', 'execSync', 'spawn', 'spawnSync', 'execFile'], description: 'child_process 执行系统命令' },
  { id: 'js.sink.sql', kind: 'sink', category: 'SQL 执行', cwe: 'CWE-89', languages: JS, callNames: ['query', 'execute', 'raw'], description: '数据库查询执行' },
  { id: 'js.sink.xss', kind: 'sink', category: 'XSS', cwe: 'CWE-79', languages: JS, textPatterns: ['\\.innerHTML\\s*=', '\\.outerHTML\\s*=', 'dangerouslySetInnerHTML', 'document\\.write\\s*\\('], description: 'DOM 写入，可能导致 XSS' },
  { id: 'js.sink.redirect', kind: 'sink', category: '开放重定向', cwe: 'CWE-601', languages: JS, textPatterns: ['res\\.redirect\\s*\\('], description: '重定向到用户可控地址' },
  { id: 'js.source.http', kind: 'source', category: 'HTTP 入参', languages: JS, textPatterns: ['\\breq(uest)?\\.(query|body|params|headers|cookies)\\b', '\\bctx\\.(query|request|params)\\b'], description: 'HTTP 请求输入' },
  { id: 'js.source.env', kind: 'source', category: '环境/命令行', languages: JS, textPatterns: ['process\\.env\\b', 'process\\.argv\\b'], description: '环境变量 / 命令行参数' },
  { id: 'js.source.dom', kind: 'source', category: 'DOM 输入', languages: JS, textPatterns: ['location\\.(search|hash|href)', 'document\\.cookie', 'window\\.name'], description: '浏览器端可控输入' },

  // ---------------- Python ----------------
  { id: 'py.sink.exec', kind: 'sink', category: '代码执行', cwe: 'CWE-95', languages: ['python'], callNames: ['eval', 'exec', 'compile'], description: 'eval / exec 动态执行' },
  { id: 'py.sink.cmd', kind: 'sink', category: '命令执行', cwe: 'CWE-78', languages: ['python'], callNames: ['system', 'popen', 'run', 'call', 'check_output', 'check_call', 'Popen'], description: 'os.system / subprocess 执行命令' },
  { id: 'py.sink.sql', kind: 'sink', category: 'SQL 执行', cwe: 'CWE-89', languages: ['python'], callNames: ['execute', 'executemany', 'executescript'], description: '游标执行 SQL' },
  { id: 'py.sink.deser', kind: 'sink', category: '不安全反序列化', cwe: 'CWE-502', languages: ['python'], callNames: ['loads', 'load'], textPatterns: ['pickle\\.loads?\\b', 'yaml\\.load\\b'], description: 'pickle / yaml 反序列化' },
  { id: 'py.source.http', kind: 'source', category: 'HTTP 入参', languages: ['python'], textPatterns: ['request\\.(args|form|values|json|data|cookies|files|headers|GET|POST)\\b'], description: 'Flask/Django 请求输入' },
  { id: 'py.source.io', kind: 'source', category: '环境/命令行/输入', languages: ['python'], textPatterns: ['os\\.environ\\b', 'sys\\.argv\\b', '\\binput\\s*\\('], description: '环境变量 / argv / input()' },

  // ---------------- Java ----------------
  { id: 'java.sink.sql', kind: 'sink', category: 'SQL 执行', cwe: 'CWE-89', languages: ['java'], callNames: ['executeQuery', 'executeUpdate', 'execute', 'addBatch', 'createQuery', 'createNativeQuery', 'createSQLQuery'], description: 'JDBC/ORM 执行 SQL/HQL' },
  { id: 'java.sink.cmd', kind: 'sink', category: '命令执行', cwe: 'CWE-78', languages: ['java'], callNames: ['exec'], textPatterns: ['Runtime\\.getRuntime\\(\\)', 'new\\s+ProcessBuilder'], description: 'Runtime.exec / ProcessBuilder' },
  { id: 'java.sink.deser', kind: 'sink', category: '不安全反序列化', cwe: 'CWE-502', languages: ['java'], callNames: ['readObject'], description: 'ObjectInputStream.readObject' },
  { id: 'java.sink.reflect', kind: 'sink', category: '反射/类加载', cwe: 'CWE-470', languages: ['java'], callNames: ['forName', 'loadClass'], description: 'Class.forName / loadClass' },
  { id: 'java.sink.xxe', kind: 'sink', category: 'XXE', cwe: 'CWE-611', languages: ['java'], callNames: ['newDocumentBuilder', 'newSAXParser', 'newInstance'], textPatterns: ['DocumentBuilderFactory', 'SAXParserFactory', 'XMLReader'], description: 'XML 解析，注意 XXE' },
  { id: 'java.source.http', kind: 'source', category: 'HTTP 入参', languages: ['java'], callNames: ['getParameter', 'getParameterValues', 'getHeader', 'getQueryString', 'getCookies', 'getInputStream'], textPatterns: ['@RequestParam', '@PathVariable', '@RequestBody', '@RequestHeader'], description: 'Servlet/Spring 请求输入' },
  { id: 'java.source.env', kind: 'source', category: '环境变量', languages: ['java'], textPatterns: ['System\\.getenv\\b', 'System\\.getProperty\\b'], description: '环境变量 / 系统属性' },

  // ---------------- Go ----------------
  { id: 'go.sink.sql', kind: 'sink', category: 'SQL 执行', cwe: 'CWE-89', languages: ['go'], callNames: ['Query', 'QueryRow', 'QueryContext', 'Exec', 'ExecContext', 'Prepare'], description: 'database/sql 执行' },
  { id: 'go.sink.cmd', kind: 'sink', category: '命令执行', cwe: 'CWE-78', languages: ['go'], callNames: ['Command', 'CommandContext'], textPatterns: ['exec\\.Command'], description: 'os/exec 执行命令' },
  { id: 'go.source.http', kind: 'source', category: 'HTTP 入参', languages: ['go'], textPatterns: ['r\\.URL\\.Query\\(\\)', 'r\\.Form(Value)?\\b', 'r\\.PostForm', 'r\\.Header\\.Get', 'mux\\.Vars\\(', '\\bc\\.(Query|Param|PostForm)\\('], description: 'net/http / gin / mux 请求输入' },
  { id: 'go.source.env', kind: 'source', category: '环境/命令行', languages: ['go'], textPatterns: ['os\\.Getenv\\b', 'os\\.Args\\b'], description: '环境变量 / argv' },

  // ---------------- PHP ----------------
  { id: 'php.sink.cmd', kind: 'sink', category: '命令执行', cwe: 'CWE-78', languages: ['php'], callNames: ['system', 'exec', 'shell_exec', 'passthru', 'popen', 'proc_open'], textPatterns: ['`.*\\$.*`'], description: '命令执行函数 / 反引号' },
  { id: 'php.sink.code', kind: 'sink', category: '代码执行', cwe: 'CWE-95', languages: ['php'], callNames: ['eval', 'assert', 'create_function', 'call_user_func', 'call_user_func_array'], description: '动态代码执行' },
  { id: 'php.sink.sql', kind: 'sink', category: 'SQL 执行', cwe: 'CWE-89', languages: ['php'], callNames: ['query', 'mysqli_query', 'mysql_query', 'pg_query', 'exec'], description: '数据库查询' },
  { id: 'php.sink.deser', kind: 'sink', category: '不安全反序列化', cwe: 'CWE-502', languages: ['php'], callNames: ['unserialize'], description: 'unserialize 反序列化' },
  { id: 'php.sink.file', kind: 'sink', category: '文件/包含', cwe: 'CWE-98', languages: ['php'], callNames: ['include', 'require', 'include_once', 'require_once', 'file_get_contents', 'fopen', 'readfile'], description: '文件包含/读取（LFI/RFI/SSRF）' },
  { id: 'php.source.super', kind: 'source', category: 'HTTP 入参', languages: ['php'], textPatterns: ['\\$_(GET|POST|REQUEST|COOKIE|FILES|SERVER)\\b', 'php://input', 'getenv\\s*\\('], description: 'PHP 超全局输入' },

  // ---------------- C / C++ ----------------
  { id: 'c.sink.cmd', kind: 'sink', category: '命令执行', cwe: 'CWE-78', languages: ['c', 'cpp'], callNames: ['system', 'popen', 'execl', 'execlp', 'execle', 'execv', 'execvp', 'execvpe'], description: 'system / exec 系列' },
  { id: 'c.sink.buf', kind: 'sink', category: '缓冲区操作', cwe: 'CWE-120', languages: ['c', 'cpp'], callNames: ['strcpy', 'strcat', 'sprintf', 'vsprintf', 'gets', 'memcpy'], description: '不带边界检查的缓冲区写入' },
  { id: 'c.sink.fmt', kind: 'sink', category: '格式化字符串', cwe: 'CWE-134', languages: ['c', 'cpp'], callNames: ['printf', 'fprintf', 'snprintf', 'syslog'], description: '格式化字符串（注意 format 可控）' },
  { id: 'c.source.input', kind: 'source', category: '外部输入', languages: ['c', 'cpp'], callNames: ['getenv', 'gets', 'fgets', 'scanf', 'fscanf', 'read', 'recv', 'recvfrom'], textPatterns: ['\\bargv\\b'], description: 'argv / 环境变量 / 网络/标准输入读取' },

  // ---------------- C# ----------------
  { id: 'cs.sink.sql', kind: 'sink', category: 'SQL 执行', cwe: 'CWE-89', languages: ['csharp'], callNames: ['ExecuteReader', 'ExecuteNonQuery', 'ExecuteScalar', 'ExecuteQuery', 'Query', 'Execute'], textPatterns: ['new\\s+SqlCommand'], description: 'ADO.NET / Dapper 执行' },
  { id: 'cs.sink.cmd', kind: 'sink', category: '命令执行', cwe: 'CWE-78', languages: ['csharp'], callNames: ['Start'], textPatterns: ['Process\\.Start', 'new\\s+ProcessStartInfo'], description: 'Process.Start 执行命令' },
  { id: 'cs.sink.deser', kind: 'sink', category: '不安全反序列化', cwe: 'CWE-502', languages: ['csharp'], callNames: ['Deserialize'], textPatterns: ['BinaryFormatter', 'LosFormatter', 'JavaScriptSerializer'], description: '不安全反序列化器' },
  { id: 'cs.source.http', kind: 'source', category: 'HTTP 入参', languages: ['csharp'], textPatterns: ['Request\\.(QueryString|Form|Params|Cookies|Headers)\\b', 'Request\\[', '\\[FromBody\\]', '\\[FromQuery\\]', '\\[FromRoute\\]'], description: 'ASP.NET 请求输入' },
  { id: 'cs.source.env', kind: 'source', category: '环境/命令行', languages: ['csharp'], textPatterns: ['Environment\\.GetEnvironmentVariable', 'Console\\.ReadLine'], description: '环境变量 / 控制台输入' },
];
