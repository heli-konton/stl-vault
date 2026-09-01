const fs = require("fs");
let html = fs.readFileSync("/opt/stl-vault/client/index.html", "utf-8");
const newVars = `
:root {
  --void:#0e0a1e; --surface:#1a1435; --surface-2:#251e45; --hairline:rgba(255,255,255,.13);
  --accent:#b18cff; --accent-rgb:177,140,255; --teal:#e57bd8; --ink:#eef1f7;
  --ink-dim:rgba(238,241,247,.6); --ink-faint:rgba(238,241,247,.42); --fail:#ef5b52; --warn:#e08a3c;
  --mono:ui-monospace,"SF Mono",SFMono-Regular,Menlo,Consolas,monospace;
  --sans:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
}
`;
html = html.replace(/undefined/, newVars.trim());
fs.writeFileSync("/opt/stl-vault/client/index.html", html);
