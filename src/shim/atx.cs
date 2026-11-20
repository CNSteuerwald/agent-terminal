// atx: Agent Terminal's command-line client, on PATH in every pane. It only relays: each call sends
// { token, pane, cwd, argv, stdin } as one JSON line over a named pipe, and the app answers
// "<exit code>\n<output>". All parsing and behavior live in the app (src/main/control.js).
//   atx <command> ...   commands for people, scripts and agents (atx help)
//   atx hook <agent>    called by agent hooks; never prints, never fails, never blocks for long
//   atx mcp             MCP server on stdin/stdout; each JSON-RPC message is relayed the same way
// Compiled on first use with the C# compiler that ships with Windows (see src/main/csc.js).
using System;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading.Tasks;

class Atx {
  static readonly UTF8Encoding Utf8 = new UTF8Encoding(false);

  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr GetStdHandle(int which);
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern bool WriteConsoleW(IntPtr handle, string text, int length, out int written, IntPtr reserved);
  [DllImport("kernel32.dll")] static extern bool GetConsoleMode(IntPtr handle, out int mode);

  // Text for a terminal goes through the Unicode console API, so it shows correctly whatever the console's
  // code page; redirected output (pipes, files, MCP) is UTF-8.
  class Out : TextWriter {
    readonly IntPtr handle; readonly bool console; readonly Stream stream;
    public Out(int which, Stream s) { handle = GetStdHandle(which); int m; console = GetConsoleMode(handle, out m); stream = s; }
    public override Encoding Encoding { get { return Utf8; } }
    public override void Write(char c) { Write(c.ToString()); }
    public override void Write(string s) {
      if (string.IsNullOrEmpty(s)) return;
      int n;
      if (console && WriteConsoleW(handle, s, s.Length, out n, IntPtr.Zero)) return;
      byte[] b = Utf8.GetBytes(s);
      stream.Write(b, 0, b.Length);
      stream.Flush();
    }
  }

  static int Main(string[] args) {
    bool hook = args.Length > 0 && args[0] == "hook";
    bool mcp = args.Length > 0 && args[0] == "mcp";
    string pipe = Environment.GetEnvironmentVariable("AGENT_TERMINAL_CTL_PIPE");
    string token = Environment.GetEnvironmentVariable("AGENT_TERMINAL_CTL_TOKEN");
    string pane = Environment.GetEnvironmentVariable("AGENT_TERMINAL_PANE") ?? "";
    TextWriter stdout = new Out(-11, Console.OpenStandardOutput());
    TextWriter stderr = new Out(-12, Console.OpenStandardError());
    if (string.IsNullOrEmpty(pipe) || string.IsNullOrEmpty(token)) {
      if (hook) return 0;
      stderr.WriteLine("atx only works inside an Agent Terminal pane.");
      return 1;
    }

    if (mcp) {
      var input = new StreamReader(Console.OpenStandardInput(), Utf8);
      string line;
      while ((line = input.ReadLine()) != null) {
        if (line.Trim().Length == 0) continue;
        string text;
        int code = Send(pipe, Request(token, pane, args, line), 0, out text);
        if (code != 0) { stderr.WriteLine(text); continue; }
        if (text.Length > 0) stdout.Write(text + "\n");
      }
      return 0;
    }

    try {
      string stdin = null;
      if (hook && Console.IsInputRedirected) {
        var reader = new StreamReader(Console.OpenStandardInput(), Utf8);
        var task = reader.ReadToEndAsync();
        stdin = task.Wait(2000) ? task.Result : null;
      }
      string text;
      // A hook must never hold up its agent, so it gives up after a few seconds.
      int code = Send(pipe, Request(token, pane, args, stdin), hook ? 4000 : 0, out text);
      if (hook) return 0;
      if (text.Length > 0) (code == 0 ? stdout : stderr).Write(text.EndsWith("\n") ? text : text + "\n");
      return code;
    } catch (Exception e) {
      if (hook) return 0;
      stderr.WriteLine("atx: " + e.Message);
      return 1;
    }
  }

  static string Request(string token, string pane, string[] args, string stdin) {
    var b = new StringBuilder("{\"token\":").Append(Json(token))
      .Append(",\"pane\":").Append(Json(pane))
      .Append(",\"cwd\":").Append(Json(Environment.CurrentDirectory))
      .Append(",\"argv\":[");
    for (int i = 0; i < args.Length; i++) b.Append(i > 0 ? "," : "").Append(Json(args[i]));
    b.Append("]");
    if (stdin != null) b.Append(",\"stdin\":").Append(Json(stdin));
    return b.Append("}\n").ToString();
  }

  // Sends one request and reads the whole answer. timeoutMs 0 waits as long as the app takes (e.g. atx wait).
  static int Send(string pipe, string request, int timeoutMs, out string text) {
    text = "";
    try {
      using (var client = new NamedPipeClientStream(".", pipe, PipeDirection.InOut)) {
        client.Connect(timeoutMs > 0 ? Math.Min(timeoutMs, 1500) : 3000);
        byte[] msg = Utf8.GetBytes(request);
        client.Write(msg, 0, msg.Length);
        client.Flush();
        var read = new StreamReader(client, Utf8).ReadToEndAsync();
        if (timeoutMs > 0 ? !read.Wait(timeoutMs) : !Wait(read)) { text = "Agent Terminal did not answer."; return 1; }
        string reply = read.Result;
        int nl = reply.IndexOf('\n');
        int code;
        if (nl < 0 || !int.TryParse(reply.Substring(0, nl), out code)) { text = "Agent Terminal sent an unexpected answer."; return 1; }
        text = reply.Substring(nl + 1);
        return code;
      }
    } catch (TimeoutException) {
      text = "Agent Terminal is not reachable (is it still running?).";
      return 1;
    } catch (IOException e) {
      text = "Agent Terminal is not reachable: " + e.Message;
      return 1;
    }
  }

  static bool Wait(Task task) { task.Wait(); return true; }

  static string Json(string s) {
    var b = new StringBuilder("\"");
    foreach (char c in s ?? "") {
      switch (c) {
        case '"': b.Append("\\\""); break;
        case '\\': b.Append("\\\\"); break;
        case '\n': b.Append("\\n"); break;
        case '\r': b.Append("\\r"); break;
        case '\t': b.Append("\\t"); break;
        default:
          if (c < 0x20) b.Append("\\u").Append(((int)c).ToString("x4"));
          else b.Append(c);
          break;
      }
    }
    return b.Append('"').ToString();
  }
}
