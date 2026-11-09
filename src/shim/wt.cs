// Stand-in for Windows Terminal's wt.exe, put on PATH only inside Agent Terminal's sbx tab.
// The sbx TUI's "External terminal" option runs: wt.exe -w new nt -- sbx.exe ... run --name X
// This forwards those arguments to Agent Terminal over a named pipe, which opens the session as a tab.
// Compiled on first use with the C# compiler that ships with Windows (see src/main/sandbox.js).
using System;
using System.IO.Pipes;
using System.Text;

class Wt {
  static int Main(string[] args) {
    string pipe = Environment.GetEnvironmentVariable("AGENT_TERMINAL_PIPE");
    string token = Environment.GetEnvironmentVariable("AGENT_TERMINAL_TOKEN");
    if (string.IsNullOrEmpty(pipe) || string.IsNullOrEmpty(token)) {
      Console.Error.WriteLine("This wt.exe only works inside Agent Terminal.");
      return 1;
    }
    try {
      using (var client = new NamedPipeClientStream(".", pipe, PipeDirection.Out)) {
        client.Connect(3000);
        byte[] msg = Encoding.UTF8.GetBytes(token + "\n" + Environment.CurrentDirectory + "\n" + string.Join("\n", args) + "\n");
        client.Write(msg, 0, msg.Length);
      }
      return 0;
    } catch (Exception e) {
      Console.Error.WriteLine("Agent Terminal is not reachable: " + e.Message);
      return 1;
    }
  }
}
