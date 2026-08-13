import { readdirSync, statSync, writeFileSync, readFileSync, existsSync } from "fs";
import { join, extname, basename } from "path";
import { randomUUID } from "crypto";

const REPO = "azlandotgg/farhaven";
const BRANCH = "main";
const SOUNDS_DIR = "sounds";
const SOUND_IDS_FILE = "sound-ids.json";

const icons = JSON.parse(readFileSync("icons.json", "utf-8"));
const lucideIcons = JSON.parse(readFileSync("icon-map-lucide.json", "utf-8"));
const bundled = JSON.parse(readFileSync("bundled.json", "utf-8"));
const categories = JSON.parse(readFileSync("categories.json", "utf-8"));
const categoryIconsIn = JSON.parse(readFileSync("category-icons.json", "utf-8"));
const nameOverrides = JSON.parse(readFileSync("names.json", "utf-8"));
const soundIdsIn = existsSync(SOUND_IDS_FILE) ? JSON.parse(readFileSync(SOUND_IDS_FILE, "utf-8")) : {};

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

// pathKey (category/filename, same shape the old public id used to be) is
// still how icons.json/bundled.json/names.json reference a sound — those
// are hand-edited override files, and a human editing them wants something
// readable, not a uuid. The actual shipped id is the uuid below instead:
// pathKey changes the moment a sound moves categories or gets renamed,
// which is exactly the case that used to silently orphan a sound a saved
// mix already referenced by its old category/name.
const discovered = [];
for (const category of readdirSync(SOUNDS_DIR)) {
  const categoryPath = join(SOUNDS_DIR, category);
  if (!statSync(categoryPath).isDirectory()) continue;

  for (const file of readdirSync(categoryPath)) {
    if (![".mp3", ".wav"].includes(extname(file))) continue;

    const filenameId = basename(file, extname(file));
    discovered.push({ category, file, filenameId, pathKey: `${category}/${filenameId}` });
  }
}

// Resolves each discovered sound to a stable uuid, reusing sound-ids.json's
// existing ones wherever possible instead of minting fresh ones, since the
// whole point is that a sound's id outlives whatever category or filename
// it currently happens to have.
//
// Pass 1 claims exact pathKey matches first — a sound that hasn't moved
// keeps its own entry outright, before anything else gets a chance to grab
// it. Pass 2 covers the actual "moved to a different category" case: for
// anything left unclaimed, look for a still-unclaimed registry entry whose
// filename matches (categories differ, so the exact key didn't), and carry
// its uuid over. Only what's left after both passes is treated as genuinely
// new and gets a fresh uuid.
//
// This can't survive a plain rename (new filename, same or different
// category) — nothing on disk still points back to the old entry in that
// case. Update sound-ids.json's key by hand when renaming a file if the
// existing uuid needs to carry over; otherwise it'll read as a new sound.
const availableEntries = new Map(Object.entries(soundIdsIn));
const resolved = [];
const unmatched = [];

for (const sound of discovered) {
  if (availableEntries.has(sound.pathKey)) {
    resolved.push({ ...sound, id: availableEntries.get(sound.pathKey), status: "kept" });
    availableEntries.delete(sound.pathKey);
  } else {
    unmatched.push(sound);
  }
}

for (const sound of unmatched) {
  const candidates = [...availableEntries.entries()].filter(([oldPathKey]) => oldPathKey.split("/").pop() === sound.filenameId);

  if (candidates.length > 1) {
    console.warn(
      `Ambiguous move: "${sound.pathKey}" matches ${candidates.length} unclaimed ids (${candidates
        .map(([k]) => k)
        .join(", ")}) — picking the first. Fix sound-ids.json by hand if that's the wrong one.`,
    );
  }

  if (candidates.length > 0) {
    const [oldPathKey, id] = candidates[0];
    resolved.push({ ...sound, id, status: `moved from ${oldPathKey}` });
    availableEntries.delete(oldPathKey);
  } else {
    resolved.push({ ...sound, id: randomUUID(), status: "new" });
  }
}

const moved = resolved.filter((s) => s.status.startsWith("moved"));
const added = resolved.filter((s) => s.status === "new");
if (moved.length) console.log(`Carried ids over for ${moved.length} moved/renamed sound(s):\n${moved.map((s) => `  ${s.status} -> ${s.pathKey}`).join("\n")}`);
if (added.length) console.log(`Minted new ids for ${added.length} sound(s): ${added.map((s) => s.pathKey).join(", ")}`);

// Rewritten from scratch off what was actually resolved above, rather than
// patched in place — that's what drops entries for sounds that were
// deleted outright instead of moved, and is exactly equivalent to keeping
// them for everything still present.
const soundIdsOut = Object.fromEntries(resolved.map((s) => [s.pathKey, s.id]).sort(([a], [b]) => a.localeCompare(b)));
writeFileSync(SOUND_IDS_FILE, JSON.stringify(soundIdsOut, null, 2) + "\n");

const sounds = resolved.map(({ category, file, filenameId, pathKey, id }) => {
  const icon = icons[pathKey] || "waveform";
  return {
    id,
    name: nameOverrides[pathKey] || titleCase(filenameId),
    category,
    file,
    url: `https://cdn.jsdelivr.net/gh/${REPO}@${BRANCH}/sounds/${category}/${file}`,
    icon,
    iconLucide: lucideIcons[icon] || "audio-lines",
    bundled: bundled.includes(pathKey),
    // Kept only for the checks below and for sorting — not written out
    // above, since the manifest's own consumers key everything off id.
    pathKey,
  };
});

// Categories with more bundled sounds sort first; sounds within a category
// go bundled-first, alphabetical within each of those two groups. "other" is
// the one exception — a catch-all for sounds that don't fit any real
// category, and it should always read as the last resort, not compete with
// real categories for position just because it happens to pick up a bundled
// sound.
const bundledCountByCategory = {};
for (const s of sounds) if (s.bundled) bundledCountByCategory[s.category] = (bundledCountByCategory[s.category] || 0) + 1;

const categoryOrder = Object.keys(categories).sort((a, b) => {
  if (a === "other" || b === "other") return a === "other" ? 1 : -1;
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
  // pathKey, not id — id is a uuid now, and sorting by it would shuffle
  // the list into meaningless order instead of the readable alphabetical
  // one this tie-break is actually for.
  return a.pathKey.localeCompare(b.pathKey);
});

// Two different sounds landing on the same uuid should be impossible given
// how ids are resolved above, but it's one JSON.parse away from a hand-
// edited sound-ids.json breaking that — cheap to catch here rather than
// ship two sounds a saved mix can't tell apart.
const soundsByGeneratedId = {};
for (const s of sounds) (soundsByGeneratedId[s.id] ??= []).push(s.pathKey);
const duplicateIds = Object.entries(soundsByGeneratedId).filter(([, paths]) => paths.length > 1);

if (duplicateIds.length) {
  console.error("Duplicate sound ids found — fix sound-ids.json before generating the manifest:\n");
  for (const [id, paths] of duplicateIds) {
    console.error(`  "${id}" used by: ${paths.join(", ")}`);
  }
  process.exit(1);
}

writeFileSync(
  "manifest.json",
  JSON.stringify(
    {
      version: Date.now(),
      categories: orderedCategories,
      categoryIcons,
      sounds: sounds.map(({ pathKey, ...sound }) => sound),
    },
    null,
    2,
  ),
);
console.log(`Wrote manifest.json with ${sounds.length} sounds across ${Object.keys(orderedCategories).length} categories.`);

const missingIcons = sounds.filter((s) => !icons[s.pathKey]);
if (missingIcons.length) {
  console.log(`\nNo icons.json entry for: ${missingIcons.map((s) => s.pathKey).join(", ")}`);
  console.log(`These fell back to "waveform" — add them to icons.json when ready.`);
}

const missingCategoryIcons = categoryOrder.filter((slug) => !categoryIconsIn[slug]);
if (missingCategoryIcons.length) {
  console.log(`\nNo category-icons.json entry for: ${missingCategoryIcons.join(", ")}`);
  console.log(`These fell back to "waveform" — add them to category-icons.json when ready.`);
}

const pathKeysByName = {};
for (const s of sounds) (pathKeysByName[s.name] ??= []).push(s.pathKey);
const duplicateNames = Object.entries(pathKeysByName).filter(([, paths]) => paths.length > 1);
if (duplicateNames.length) {
  console.log(`\nDuplicate display names (cosmetic only, won't break the app):`);
  for (const [name, paths] of duplicateNames) {
    console.log(`  "${name}" used by: ${paths.join(", ")}`);
  }
  console.log(`Add an entry to names.json for one of them if they need to look distinct.`);
}
