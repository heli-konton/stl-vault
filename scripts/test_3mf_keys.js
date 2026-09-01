const AdmZip = require("adm-zip");
const fs = require("fs");
const path = require("path");

function inspectConfigs(file) {
  if (!fs.existsSync(file)) return;
  const zip = new AdmZip(file);
  const entries = zip.getEntries();
  for (const e of entries) {
    if (e.entryName.includes("slice_info") || e.entryName.includes("model_settings") || e.entryName.endsWith(".config")) {
      console.log(`--- ${path.basename(file)} :: ${e.entryName} ---`);
      try {
        const text = e.getData().toString("utf8");
        if (text.startsWith("{")) {
          const json = JSON.parse(text);
          const interestingKeys = ["layer_height", "nozzle_diameter", "filament_type", "filament_colour", "prediction", "estimated_time", "printer_model", "filament_density"];
          for (const k of Object.keys(json)) {
            if (interestingKeys.some(ik => k.includes(ik))) {
              console.log(`  ${k}:`, json[k]);
            }
          }
        } else {
          console.log(text.slice(0, 400));
        }
      } catch (err) {
        console.log("Error parsing:", err.message);
      }
    }
  }
}

const dir = "/srv/models";
const files = fs.readdirSync(dir).filter(f => f.endsWith(".3mf")).slice(0, 3);
files.forEach(f => inspectConfigs(path.join(dir, f)));
