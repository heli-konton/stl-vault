const fs = require("fs");
const path = require("path");

const ROOT = "/srv/models";

// Category definitions
const CATEGORIES = {
  "01_Printers_&_Tools": [
    "kobra-33", "kobra-x6", "printer", "printer-accessories-&-tools7",
    "hexscraper---printbed-scraper---666652471", "z-offset-calibration396",
    "calibration2", "filament-profiles124", "profiles413",
    "flashforge-adventurer-5m-pro-orca-profiles---6758456125",
    "flashforge-adventurer-5m-pro-top-spool-holder-for-tpu-model-files127",
    "Magnetic Consumables Color Card", "obj_5_Rail _1_.3mf",
    "Multifunction_Arm_Mounting_System_-_Organised.3mf"
  ],
  "02_Desk_&_Electronics_Stands": [
    "Apple watch charger stand", "Apple watch charger stand - obj_1_Apple watch charger stand v1.stl_1.stl",
    "airpod_max_hardcase", "ipadstand", "ipads410", "iPhone 16Pro Max_No case",
    "iPhone16 Pro Max_Apple Silicon_Old Magsafe", "LOGI MX keys case",
    "sofa station", "monitor_lamp.3mf", "Remington RX5 Stand", "Remington RX5 Stand.step",
    "remington-shaver-holder416", "deskoffice399", "diy-elite-strap-w-flipup-stls134",
    "MakerWorld_Model_1079734-fast-grip-gunstock-for-quest-3"
  ],
  "03_Storage_&_Organization": [
    "glasses cases", "mando glasses case", "fridge401",
    "honeycomb-storage-wall404", "medication411", "vapes417", "arms143"
  ],
  "04_Pop_Culture_Gaming_&_Cosplay": [
    "InterceptorTIE", "KITT", "razorCrest", "MARIO_THEROBOCOP.TOMMY_IMPRESSIONS_FAN_ART.3mf",
    "fnaf-the-yellow-rabbit-cosplay-head-model-files146", "props-cosplay",
    "Munchkin_T_rme_AMS.3mf", "Thingiverse_Thing_7352348"
  ],
  "05_Family_&_Personal_Projects": [
    "projects-for-anna415", "projects-for-liam414", "work418", "design-resources397"
  ],
  "06_Unsorted_Imports": [
    "downloaded-files-to-sort-out400", "completed75", "new-3mf-files-1138",
    "new-3mf-files137", "test_model"
  ]
};

// Friendly folder renames (clean up messy database export names)
const RENAMES = {
  "printer-accessories-&-tools7": "Printer Accessories & Tools",
  "hexscraper---printbed-scraper---666652471": "HexScraper Printbed Scraper",
  "z-offset-calibration396": "Z-Offset Calibration",
  "filament-profiles124": "Filament Profiles",
  "flashforge-adventurer-5m-pro-orca-profiles---6758456125": "Flashforge Adventurer 5M Pro Orca Profiles",
  "flashforge-adventurer-5m-pro-top-spool-holder-for-tpu-model-files127": "Flashforge 5M Pro Top Spool Holder TPU",
  "Apple watch charger stand": "Apple Watch Charger Stand",
  "airpod_max_hardcase": "AirPods Max Hard Case",
  "ipadstand": "iPad Stand",
  "ipads410": "iPad Mounts & Stands",
  "iPhone 16Pro Max_No case": "iPhone 16 Pro Max (No Case)",
  "iPhone16 Pro Max_Apple Silicon_Old Magsafe": "iPhone 16 Pro Max (Magsafe)",
  "LOGI MX keys case": "Logitech MX Keys Case",
  "sofa station": "Sofa Station",
  "remington-shaver-holder416": "Remington Shaver Holder",
  "Remington RX5 Stand": "Remington RX5 Shaver Stand",
  "deskoffice399": "Desk & Office Organizers",
  "diy-elite-strap-w-flipup-stls134": "DIY Elite Strap Flip-Up Quest 3",
  "MakerWorld_Model_1079734-fast-grip-gunstock-for-quest-3": "Quest 3 Fast Grip Gunstock",
  "glasses cases": "Glasses Cases",
  "mando glasses case": "Mandalorian Glasses Case",
  "fridge401": "Fridge Storage Organizers",
  "honeycomb-storage-wall404": "Honeycomb Storage Wall",
  "medication411": "Medication Organizers",
  "vapes417": "Vape Stands & Holders",
  "arms143": "Mounting Arms & Brackets",
  "InterceptorTIE": "Star Wars TIE Interceptor",
  "KITT": "Knight Rider KITT",
  "razorCrest": "Star Wars Razor Crest",
  "MARIO_THEROBOCOP.TOMMY_IMPRESSIONS_FAN_ART.3mf": "Mario Robocop Fan Art.3mf",
  "fnaf-the-yellow-rabbit-cosplay-head-model-files146": "FNAF Yellow Rabbit Cosplay Head",
  "props-cosplay": "Cosplay Props & Replicas",
  "Munchkin_T_rme_AMS.3mf": "Munchkin Dice & Card Towers.3mf",
  "projects-for-anna415": "Anna's Projects",
  "projects-for-liam414": "Liam's Projects",
  "work418": "Work Projects",
  "design-resources397": "Design Resources",
  "downloaded-files-to-sort-out400": "Downloaded Files To Sort",
  "completed75": "Completed Prints Archive"
};

function sanitizeName(name) {
  if (RENAMES[name]) return RENAMES[name];
  return name.replace(/[#+]+/g, " ").replace(/\s+/g, " ").trim();
}

function runTidy(dryRun = true) {
  console.log(`=== STARTING LIBRARY TIDY UP (${dryRun ? "DRY RUN" : "LIVE EXECUTION"}) ===\n`);

  // Ensure category directories exist
  for (const cat of Object.keys(CATEGORIES)) {
    const catPath = path.join(ROOT, cat);
    if (!dryRun && !fs.existsSync(catPath)) {
      fs.mkdirSync(catPath, { recursive: true });
    }
  }

  const manifest = [];

  // Helper to move item
  function moveItem(sourcePath, catDir, originalName) {
    if (!fs.existsSync(sourcePath)) return;
    const cleanName = sanitizeName(originalName);
    const targetPath = path.join(ROOT, catDir, cleanName);

    manifest.push({ from: sourcePath, to: targetPath, category: catDir });

    if (!dryRun) {
      if (sourcePath !== targetPath) {
        fs.renameSync(sourcePath, targetPath);
      }
    }
  }

  // 1. Process top-level items in /srv/models
  for (const [cat, matchItems] of Object.entries(CATEGORIES)) {
    for (const item of matchItems) {
      const topPath = path.join(ROOT, item);
      const newPath = path.join(ROOT, "new", item);

      if (fs.existsSync(topPath)) {
        moveItem(topPath, cat, item);
      } else if (fs.existsSync(newPath)) {
        moveItem(newPath, cat, item);
      }
    }
  }

  // 2. Any remaining items in /srv/models/new/ -> move to 06_Unsorted_Imports
  const newDir = path.join(ROOT, "new");
  if (fs.existsSync(newDir)) {
    const remainingInNew = fs.readdirSync(newDir).filter(f => !f.startsWith("."));
    for (const item of remainingInNew) {
      moveItem(path.join(newDir, item), "06_Unsorted_Imports", item);
    }
  }

  console.log(`Planned moves: ${manifest.length} items.\n`);
  manifest.forEach(m => {
    console.log(` [${m.category}] ${path.basename(m.from)} -> ${path.basename(m.to)}`);
  });

  return manifest;
}

const isLive = process.argv.includes("--live");
runTidy(!isLive);
