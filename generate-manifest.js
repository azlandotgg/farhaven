import { readdirSync, statSync, writeFileSync, readFileSync } from "fs";
import { join, extname, basename } from "path";

const REPO = "azlandotgg/farhaven";
const BRANCH = "main";
const SOUNDS_DIR = "sounds";

const icons = JSON.parse(readFileSync("icons.json", "utf-8"));
const lucideIcons = JSON.parse(readFileSync("icon-map-lucide.json", "utf-8"));
const bundled = JSON.parse(readFileSync("bundled.json", "utf-8"));
const categories = JSON.parse(readFileSync("categories.json", "utf-8"));
const categoryIconsIn = JSON.parse(readFileSync("category-icons.json", "utf-8"));
const nameOverrides = JSON.parse(readFileSync("names.json", "utf-8"));

// Small connector words stay lowercase unless they're the first word,
// e.g. "rain-on-window" -> "Rain on Window", not "Rain On Window".
const SMALL_WORDS = new Set(["a", "an", "and", "as", "at", "but", "by", "for", "in", "of", "on", "or", "the", "to", "vs", "von"]);

function titleCase(slug) {
  return slug
    .split("-")
    .map((word, i) => {
      if (i !== 0 && SMALL_WORDS.has(word.toLowerCase())) return word.toLowerCase();
      return word.charAt(0).toUpperCase() + word.slice(1);
    })
    .join(" ");
}

const sounds = [];

for (const category of readdirSync(SOUNDS_DIR)) {
  const categoryPath = join(SOUNDS_DIR, category);
  if (!statSync(categoryPath).isDirectory()) continue;

  for (const file of readdirSync(categoryPath)) {
    if (![".mp3", ".wav"].includes(extname(file))) continue;

    const filenameId = basename(file, extname(file));
    const id = `${category}/${filenameId}`;
    const icon = icons[id] || "waveform";

    sounds.push({
      id,
      name: nameOverrides[id] || titleCase(filenameId),
      category,
      file,
      url: `https://cdn.jsdelivr.net/gh/${REPO}@${BRANCH}/sounds/${category}/${file}`,
      icon,
      iconLucide: lucideIcons[icon] || "audio-lines",
      bundled: bundled.includes(id)
    });
  }
}

// Categories with more bundled sounds sort first; sounds within a category
// go bundled-first, alphabetical within each of those two groups.
const bundledCountByCategory = {};
for (const s of sounds) if (s.bundled) bundledCountByCategory[s.category] = (bundledCountByCategory[s.category] || 0) + 1;

const categoryOrder = Object.keys(categories).sort((a, b) => {
  const countDiff = (bundledCountByCategory[b] || 0) - (bundledCountByCategory[a] || 0);
  return countDiff !== 0 ? countDiff : a.localeCompare(b);
});
const categoryRank = Object.fromEntries(categoryOrder.map((slug, i) => [slug, i]));

const orderedCategories = {};
for (const slug of categoryOrder) orderedCategories[slug] = categories[slug];

const categoryIcons = {};
for (const slug of categoryOrder) {
  const icon = categoryIconsIn[slug] || "waveform";
  categoryIcons[slug] = { icon, iconLucide: lucideIcons[icon] || "audio-lines" };
}

sounds.sort((a, b) => {
  const rankDiff = categoryRank[a.category] - categoryRank[b.category];
  if (rankDiff !== 0) return rankDiff;
  if (a.bundled !== b.bundled) return a.bundled ? -1 : 1;
  return a.id.localeCompare(b.id);
});

// id is prefixed with category, so it can only collide when a single
// category folder has two files with the same name but different
// extensions (e.g. white-noise.mp3 and white-noise.wav side by side).
const idLocations = {};
for (const s of sounds) (idLocations[s.id] ??= []).push(`${s.category}/${s.file}`);
const duplicateIds = Object.entries(idLocations).filter(([, locations]) => locations.length > 1);

if (duplicateIds.length) {
  console.error("Duplicate sound ids found — fix before generating the manifest:\n");
  for (const [id, locations] of duplicateIds) {
    console.error(`  "${id}" used by: ${locations.join(", ")}`);
  }
  process.exit(1);
}

writeFileSync(
  "manifest.json",
  JSON.stringify({ version: Date.now(), categories: orderedCategories, categoryIcons, sounds }, null, 2)
);
console.log(`Wrote manifest.json with ${sounds.length} sounds across ${Object.keys(orderedCategories).length} categories.`);

const missingIcons = sounds.filter(s => !icons[s.id]);
if (missingIcons.length) {
  console.log(`\nNo icons.json entry for: ${missingIcons.map(s => s.id).join(", ")}`);
  console.log(`These fell back to "waveform" — add them to icons.json when ready.`);
}

const missingCategoryIcons = categoryOrder.filter(slug => !categoryIconsIn[slug]);
if (missingCategoryIcons.length) {
  console.log(`\nNo category-icons.json entry for: ${missingCategoryIcons.join(", ")}`);
  console.log(`These fell back to "waveform" — add them to category-icons.json when ready.`);
}

const idsByName = {};
for (const s of sounds) (idsByName[s.name] ??= []).push(s.id);
const duplicateNames = Object.entries(idsByName).filter(([, ids]) => ids.length > 1);
if (duplicateNames.length) {
  console.log(`\nDuplicate display names (cosmetic only, won't break the app):`);
  for (const [name, ids] of duplicateNames) {
    console.log(`  "${name}" used by: ${ids.join(", ")}`);
  }
  console.log(`Add an entry to names.json for one of them if they need to look distinct.`);
}
