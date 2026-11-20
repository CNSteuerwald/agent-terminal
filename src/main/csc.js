'use strict';
// Builds the small C# helpers in src/shim with the C# compiler that ships with Windows, on first use.
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

// csc.exe can't read inside app.asar; packaged builds ship src/shim unpacked (build.asarUnpack in package.json).
const SHIM_SRC = path.join(__dirname, '..', 'shim').replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
const CSC = path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');

// Compiles src/shim/<name>.cs to <dir>/<exeName>, unless an up-to-date build is there.
// Resolves to the exe's path, or null off Windows or when it can't be built.
function build(name, dir, exeName = `${name}.exe`) {
  if (process.platform !== 'win32') return Promise.resolve(null);
  const src = path.join(SHIM_SRC, `${name}.cs`);
  const exe = path.join(dir, exeName);
  try {
    if (fs.statSync(exe).mtimeMs >= fs.statSync(src).mtimeMs) return Promise.resolve(exe);
  } catch { /* not built yet */ }
  fs.mkdirSync(dir, { recursive: true });
  return new Promise(resolve => execFile(CSC, ['-nologo', '-optimize', `-out:${exe}`, src], { windowsHide: true, timeout: 60000 },
    err => resolve(err ? null : exe)));
}

module.exports = { build };
