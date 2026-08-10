// Orebody — every browser module parses as a real ES module.
//
//   node tools/verify_modules.mjs
//
// This exists because the check it replaces was worthless and said so
// convincingly. Parsing each file with `new vm.Script(src)` after stripping
// `import` lines with a regex reports success on source the browser refuses,
// because the thing it deletes is exactly the thing that was broken — a stray
// double comma in an import list took the whole console down while the check
// went on printing "parses".
//
// A syntax error in one module takes down every module that imports it, so a
// broken lib file is a blank console, not a broken feature.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { SourceTextModule } from "node:vm";

const ROOTS = ["dashboard"];
const SKIP = /\/(vendor|node_modules)\//;

function walk(dir, out = []) {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".js") && !SKIP.test("/" + p + "/")) out.push(p);
  }
  return out;
}

let pass = 0, fail = 0;
for (const f of ROOTS.flatMap((r) => walk(r))) {
  try {
    // Compiles the module for real: imports, exports and all. Nothing stripped,
    // so nothing can hide in what was stripped.
    new SourceTextModule(readFileSync(f, "utf8"), { identifier: f });
    pass++; console.log(`  ok   ${f}`);
  } catch (e) {
    fail++; console.log(`  FAIL ${f}\n       ${e.message}`);
  }
}
console.log(`\n${pass} parsed, ${fail} failed`);
process.exit(fail ? 1 : 0);
