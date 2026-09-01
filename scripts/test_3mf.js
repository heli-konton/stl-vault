const AdmZip = require("adm-zip");
const fs = require("fs");
const path = require("path");

function inspect3MF(file) {
  if (!fs.existsSync(file)) return null;
  try {
    const zip = new AdmZip(file);
    const entries = zip.getEntries();
    console.log(`=== ${path.basename(file)} (${entries.length} entries) ===`);

    let thumbEntry = null;
    let configEntry = null;

    for (const e of entries) {
      const name = e.entryName;
      if (!thumbEntry && (name.endsWith(".png") || name.endsWith(".jpg"))) {
        if (name.includes("thumbnail") || name.includes("plate_") || name.startsWith("Metadata/")) {
          thumbEntry = e;
        }
      }
      if (!configEntry && (name.endsWith(".config") || name.endsWith(".gcode") || name.endsWith(".model"))) {
        if (name.includes("slice_info") || name.includes("model_settings") || name.endsWith(".config")) {
          configEntry = e;
        }
      }
    }

    if (thumbEntry) console.log(" Found thumb entry:", thumbEntry.entryName, thumbEntry.header.size, "bytes");
    if (configEntry) {
      console.log(" Found config entry:", configEntry.entryName);
      const text = configEntry.getData().toString("utf8").slice(0, 500);
      console.log(" Config preview:\n", text);
    }
  } catch (err) {
    console.error("Error reading 3MF:", err.message);
  }
}

const dir = "/srv/models";
if (fs.existsSync(dir)) {
  const files = fs.readdirSync(dir).filter(f => f.endsWith(".3mf")).slice(0, 5);
  files.forEach(f => inspect3MF(path.join(dir, f)));
}
